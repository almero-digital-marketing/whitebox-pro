# 09 · API (REST + MCP) & Auth

REST and MCP are thin transports over one [`service.js`](../src/service.js). Same operations, two
surfaces.

## Auth — two tiers, both bearer

WhiteBox already has the mechanism (`createAuth`, timing-safe `Authorization: Bearer <secret>`); this
plugin reuses the pattern via `resolveReadWriteAuth(cfg.auth, …)`, which resolves a read-tier and a
write-tier verifier from `audiences.auth` (commonly the same secret for both). **No user/identity layer
is required for v1** — these are privileged API keys, rotated like your other secrets.

| tier | who | gated by |
|---|---|---|
| **public / ingest** | browser SDK (sessions, engagement, `/audiences/identity`) | existing client token |
| **management** | admin / UI / scripts (`/audiences/*`) | `audiences.auth.secret` (read/write split) |
| **MCP** | agent / Claude | `config.mcp.auth.secret` (the host already gates `/mcp`) |

> The `/mcp` secret gates *all* MCP tools across plugins (endpoint-level), not per-tool. Fine for v1;
> per-tool scopes are a v2 extension. Per-user tokens + roles wait for a real auth layer.

## REST reference

Base: `/audiences` — this plugin's REST namespace. Two resource collections live under it:
`/segments/*` and `/audiences/*` (the composition resource shares its name with the plugin, so its full
path is `/audiences/audiences/*` — not a typo). All routes require
`Authorization: Bearer <audiences.auth.secret>`. The split below is by **mutation**, not HTTP verb —
several `POST` routes are previews/name-suggestions that never persist anything and stay read-gated.

### Segments

| method | path | body / query | returns |
|---|---|---|---|
| `POST` | `/audiences/segments/preview` | `{ source }` (or the source directly) | `{candidate_pool, est_matches, sampled, full_scan, confirm_required, sample_reasons}` |
| `POST` | `/audiences/segments/name` | `{ source, context? }` | `{name}` — AI-suggested, never persists |
| `GET` | `/audiences/segments` | | all segments |
| `POST` | `/audiences/segments` | `{ source, name?, origin?, context? }` | the saved segment — **dedups on the source predicate** |
| `GET` | `/audiences/segments/:id` | | one segment |
| `PATCH` | `/audiences/segments/:id` | `{ name }` | the renamed segment |
| `DELETE` | `/audiences/segments/:id` | | `{deleted}` |
| `GET` | `/audiences/segments/:id/members` | `?limit` | `{count, ids}` |

A segment source has exactly one of `select` (a core selector) or `funnel`+`slot` — full schema and
examples in [03 · Segment sources](03-segment-sources.md).

#### `preview`

`POST /audiences/segments/preview` runs the selector engine on an **unsaved** source — no persistence,
no LLM beyond the small judge sample:

```jsonc
{
  "candidate_pool":   1800,        // size after `about` (the similarity-floor cohort)
  "est_matches":      120,         // projected qualifying count
  "sampled":          20,          // judge calls made for the sample
  "full_scan":        false,       // true when there's no positive anchor → walk the whole base
  "confirm_required": false,       // true above the survivor cap → creating needs an explicit confirm
  "sample_reasons":   [ "…", "…" ] // a few real "why" reasons from the sample
}
```

For a **funnel** source, `candidate_pool`/`est_matches` reflect the slot cohort size instead.

### Audiences

| method | path | body / query | returns |
|---|---|---|---|
| `POST` | `/audiences/audiences/preview` | `{ rule }` (or the rule directly) | `{candidate_pool, est_matches}` — an **unsaved** composition |
| `POST` | `/audiences/audiences/name` | `{ rule }` | `{name}` — AI-suggested, never persists |
| `GET` | `/audiences/audiences/memberships/:passportId` | | `{passport_id, audiences: [{id, activation_id, name}]}` — **client-side-exposed** audiences only |
| `GET` | `/audiences/audiences/by-activation-id/:activationId` | | the audience |
| `GET` | `/audiences/audiences` | | all audiences |
| `POST` | `/audiences/audiences` | audience input (see below) | the saved audience |
| `GET` | `/audiences/audiences/:id` | | one audience |
| `DELETE` | `/audiences/audiences/:id` | | `{deleted}` |
| `GET` | `/audiences/audiences/:id/members` | `?limit` (capped at 5000) | `{count, ids}` |
| `POST` | `/audiences/audiences/:id/delivery/preview` | | `{resolved, deliverable, suppressed, no_consent}` |
| `POST` | `/audiences/audiences/:id/delivery` | `{network, enabled}` | the updated audience |
| `POST` | `/audiences/audiences/:id/client-side` | `{enabled}` | the updated audience |
| `POST` | `/audiences/audiences/:id/campaigns` | `{enabled}` | the updated audience |

#### Audience body (create / update)

An audience is `{ id?, name?, activation_id?, rule, delivery?, client_side?, campaigns? }`, where `rule`
is a boolean composition of segment ids:

```jsonc
// POST /audiences/audiences
{
  "name": "Pro accounts at churn risk",
  "rule": {
    "op": "all",
    "members": [
      { "segment": "b1f5…-segment-id" },
      { "segment": "9ac2…-segment-id", "negate": true }
    ]
  }
}
```

Passing an existing `id` updates that audience. Only the fields you supply are written — omitting
`delivery`/`client_side`/`campaigns` leaves the stored values untouched (so editing `rule` doesn't wipe
existing delivery config). `activation_id` defaults to a slug of `name`, de-duplicated with a numeric
suffix if it collides. Full schema in
[11 · Segments & audiences](11-segments-and-audiences.md).

#### Delivery

`POST /audiences/audiences/:id/delivery { network, enabled }` toggles sync to one network:
- `enabled: true` — resolves the audience, consent-gates it (suppression + `requireConsentCategory`),
  and stamps `delivery[network] = {enabled, last_synced_at, last_count, event: activation_id, dry_run}`.
  `dry_run` is `true` automatically when no eligible adapter is configured for that network — there is
  no separate flag to pass.
- `enabled: false` — just flips `delivery[network].enabled` off.

This is a **one-shot sync**, not a subscription — see [02 · Concepts](02-concepts.md). Nothing re-runs
it on a schedule; call it again (via REST/MCP or your own cron) to refresh a platform's recency window.

### Passports

| method | path | returns |
|---|---|---|
| `POST` / `DELETE` | `/audiences/passports/:pid/suppress` | `{ok}` — add / remove from do-not-target |

### Networks / discovery

| method | path | returns |
|---|---|---|
| `GET` | `/audiences/networks` | adapters: name, modes, eligible, transport |
| `GET` | `/audiences/networks/:net/identity-manifest` | the client-collection manifest |
| `GET` | `/audiences/facts` | available fact keys + labels (discovery) |
| `GET` | `/audiences/suppression` | the do-not-target list |

### Public (ingest tier, NOT management-gated)

| method | path | body |
|---|---|---|
| `POST` | `/audiences/identity` | `{passport_id, signals}` — the client capture shim posts collected ad signals |

> `rest.js` registers only the management routes above. Wire `/audiences/identity` to
> `service.saveSignals` behind the **public** token (not the management secret) — this was true before
> the `Rule` system existed and hasn't changed.

## MCP reference

Registered on the shared `/mcp` server (behind `config.mcp.auth.secret`), mirroring the REST surface.
Grouped as in [`src/mcp.js`](../src/mcp.js):

### Inspect

| tool | purpose |
|---|---|
| `audiences_list_segments` / `audiences_get_segment` | inspect segments |
| `audiences_segment_members` | resolve a segment to its live cohort (ids) |
| `audiences_list_audiences` / `audiences_get_audience` | inspect audiences |
| `audiences_audience_members` | resolve an audience to its live cohort (segments combined per `op` + negation) |
| `audiences_passport_audiences` | which client-side-exposed audiences a passport belongs to |
| `audiences_delivery_preview` | of an audience's resolved cohort, how many are deliverable after suppression + consent |
| `audiences_network_status` | networks: eligibility, modes, identity coverage |
| `audiences_list_facts` | fact keys available for authoring |
| `audiences_list_suppression` | the do-not-target list |

### Author (AI-native, preview-first)

| tool | purpose |
|---|---|
| `audiences_preview_segment` | size of an **unsaved** segment source — never persists |
| `audiences_name_segment` | AI-suggested name for an unsaved segment source |
| `audiences_create_segment` | create a segment (commit) — **dedups on the source predicate** |
| `audiences_rename_segment` | rename a saved segment |
| `audiences_preview_audience` | size of an **unsaved** audience composition — never persists |
| `audiences_name_audience` | AI-suggested name for an unsaved audience composition |
| `audiences_create_audience` | create/update an audience — pass an existing `id` to update |

### Act (guarded)

| tool | purpose |
|---|---|
| `audiences_delete_segment` / `audiences_delete_audience` | delete |
| `audiences_set_delivery` | turn delivery to one network on/off — dry-runs automatically when no adapter is eligible |
| `audiences_set_client_side` | expose/hide an audience for on-site membership lookup (first-party only, immediate) |
| `audiences_set_campaigns` | make an audience available to the Campaigns module or not |
| `audiences_suppress` / `audiences_unsuppress` | do-not-target a passport |

### Write safety

- **Preview before create.** `audiences_preview_segment`/`audiences_preview_audience` cost nothing to
  call repeatedly and never persist — use them before `audiences_create_segment`/`audiences_create_audience`.
- **Delivery has no `dryRun` flag to pass.** Eligibility decides, not caller intent —
  `audiences_set_delivery` dry-runs automatically when the target network has no eligible adapter
  configured.
- **Member listing returns ids only** — `audiences_segment_members`/`audiences_audience_members` never
  return the per-member `why`/`score` the engine computes internally, and there's no bulk-export or
  `explain` tool (see [02 · Concepts](02-concepts.md)).
