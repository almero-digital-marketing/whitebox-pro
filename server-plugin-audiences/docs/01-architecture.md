# 01 · Architecture

## Components

```
                          whitebox-pro-server-plugin-audiences
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  index.js  (plugin contract: migrate + register)                          │
 │     │ wires everything as init()+singletons                               │
 │     ▼                                                                      │
 │  service.js  ◀── REST (rest.js)        ◀── MCP (mcp.js)                    │
 │     │  the single implementation both transports call                     │
 │     ├──▶ segments.js     zod schema + identity — a saved selector/funnel  │
 │     │                    source, deduped by predicate_key                 │
 │     ├──▶ audiences.js    zod schema + identity — a boolean composition of │
 │     │                    segments (the deliverable layer)                 │
 │     ├──▶ rules.js        the shared Selector/Funnel/SLOT_RE grammar both  │
 │     │                    schemas above reuse                              │
 │     ├──▶ evaluator.js    thin adapter over ctx.selector — resolves a      │
 │     │                    segment's source, composes an audience's members │
 │     ├──▶ identity.js     manifest + hashed match keys                     │
 │     ├──▶ consent.js      cohort consent gate (allowedCohort)              │
 │     └──▶ store.js        knex data access                                 │
 └──────────────────────────────────────────────────────────────────────────┘
        ▲                         ▲                         │
        │ ctx.ai · ctx.db         │ ctx.selector (resolve)   │ HTTP (on explicit sync)
        │ ctx.facts               │                          ▼
   WhiteBox core                  WhiteBox core         Meta · TikTok · GA4 (optional adapters)
```

The plugin does no selection of its own. The core **selector engine** (`ctx.selector`, spec at
`whitebox-pro-server/docs/selector.md`) owns *all* selection — `about → filter → judge` over the two
memories. The plugin's job is narrow: **store** segment/audience definitions, **resolve** them through
the engine, and **activate** (deliver/expose) the result. `evaluator.js` is a thin adapter over the
engine; there is no bespoke feature family or plugin-owned LLM judge here.

There is **no background worker, queue, or scheduler** in this plugin. Segments and audiences resolve
live, on demand, every time they're read or synced — see [02 · Concepts](02-concepts.md).

## What the plugin receives from the host (`ctx`)

From `register(app, ctx)` (see `whitebox-pro-server/src/server.js`):

| `ctx.*` | used for |
|---|---|
| `selector` | `resolve()` / `preview()` / `funnel()` / `funnelSlot()` — **all** selection |
| `db` | knex — segments/audiences/suppression/identities + distinct fact keys from `whitebox_facts` |
| `ai` | `object()` — naming an unsaved segment or audience |
| `facts` | fact-key labels for `availableFacts()` |
| `passports` | `identities()` → email/phone for hashed match keys; `hasConsent()` for the consent gate |
| `mcp` | `tool()` — register the management tools |
| `sessions` | `onResolve()` — attach the identity manifest to session resolve |
| `config` | the `audiences` plugin options (`auth`, `networks`, `privacy`) |

## Data flow

### A segment's source

A segment ([`src/segments.js`](../src/segments.js)) is a saved core selector. Its source is *exactly
one* of:

- **`select`** — a core selector `{about, filter, judge}` (CRM state lives in core facts, reached via
  `select.filter.fact`).
- **`funnel` + `slot`** — a funnel cohort: a step's completers (`"step:N"`) or a gap (`"gap:N→M"`), with
  an optional `status` of `pending` (still in window) or `dropped` (window closed).

### Resolving a segment

```
service.resolveSegment(id)
  → evaluator.resolveSource(seg.source)     # alias of resolveCohort
        select  → ctx.selector.resolve(source.select, { projection: 'people' })
        funnel  → ctx.selector.funnel(source.funnel) then funnelSlot(result, source.slot, { status })
  → { count, ids }
```

### Resolving an audience — set algebra over segments

An audience ([`src/audiences.js`](../src/audiences.js)) is `{ op: 'all'|'any', members: [{segment,
negate?}] }`. `service.js` memoises each distinct segment resolution within one audience resolve (a
segment referenced twice, or a positive that's also subtracted, resolves only once), then
`evaluator.js` combines the resulting id-sets:

```
service.resolveAudience(id)
  → for each member: resolveSegment(member.segment) → Set<passport id>   (memoised)
  → op:'all' → intersect the positive members' sets
    op:'any' → union the positive members' sets
  → subtract the union of any `negate: true` members' sets
  → ids
```

### Delivery — an explicit sync, not a background sweep

`service.setDelivery(id, { network, enabled })` runs on demand (REST/MCP/UI) — there is no recurring
re-sync built into this plugin:

```
enabled:false → delivery[network].enabled = false   (nothing else changes)
enabled:true  → resolve the audience → consent.allowedCohort(ids)  (suppression + consent gate)
             → dry_run = true unless an eligible adapter is configured for that network
             → stamp delivery[network] = { enabled, last_synced_at, last_count, event: activation_id, dry_run }
```

The `activation_id` (a slugified, unique id on the audience) is the key a platform's Custom Audience is
built on, and what the client-side membership lookup reports.

## Data model

| table | role |
|---|---|
| `whitebox_audience_segments` | a saved selector/funnel source (`source` jsonb), `name`, `predicate_key` (sha256 dedup hash), `origin` (provenance) |
| `whitebox_audiences` | a boolean composition (`rule` jsonb: `{op, members}`), `activation_id`, per-network `delivery` status, `client_side` / `campaigns` flags |
| `whitebox_audience_suppression` | hard do-not-target list |
| `whitebox_audience_identities` | browser-collected ad signals per passport (`fbp`, `ttclid`, `ga_client_id`, …) |

Migrations live in [`src/migrations/`](../src/migrations) and run via the plugin's `migrate(db)` on
boot. Migrations **001–003** created a standalone `Rule` entity (`whitebox_audience_rules` + its
`matches`/`deliveries` audit trail) with its own BullMQ worker, daily keep-warm scheduler sweep, and
REST/MCP CRUD — it was fully wired but never adopted (no UI ever wrote to it, and it was a completely
separate table from the segments/audiences below). Migration **011**
([`011_drop_rule_system.js`](../src/migrations/011_drop_rule_system.js)) drops all three of those
tables. Migrations **009–010** created `whitebox_audience_segments` / `whitebox_audiences` — the actual,
live feature this doc describes. Schema detail per column is in [09 · API](09-api.md) and the migration
files themselves.

## Design rules carried from the core

- **One engine owns selection.** The plugin stores, resolves, and activates; it does not narrow
  vectors, judge, or aggregate metrics itself.
- **One service, two transports.** REST and MCP are dumb shells over `service.js`.
- **Adapters are data.** Each declares `modes`, `eligible`, `identitySpec`, `acceptedKeys` — a network is
  only **eligible** (real delivery, not dry-run) once its credentials are configured.
- **Resolve every call.** Segments and audiences are living queries — nothing is materialized, matching
  the project's compute-on-read philosophy elsewhere in WhiteBox.
