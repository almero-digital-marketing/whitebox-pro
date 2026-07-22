# 11 · Segments, audiences & activation

A **segment** is a named, dynamic sub-query — a saved selector/funnel source, typically born from a
chart selection in the Analytics module. An **audience** is an `AND`/`OR`/`NOT` composition of segments.
Both are **living queries** (resolved at read-time, never a stored roster) — see
[02 · Concepts](02-concepts.md). An audience is the **activation-agnostic targeting primitive**: the
same audience can sync **delivery** to an ad network, be exposed **client-side** (on-site membership),
or be exposed to the **campaigns** module (email/SMS).

This is the plugin's primary, actually-used concept — see [01 · Architecture](01-architecture.md) and
[03 · Segment sources](03-segment-sources.md) for the source grammar a segment is built from.

---

## 1. Why segments are split from audiences

A cohort (a saved selector / funnel-slot) and an ad-network delivery used to be bundled into one thing —
an earlier `Rule` entity that carried both. That coupling didn't survive contact with a second consumer:
the **campaigns** module needs to target email/SMS at the *same* cohorts ad delivery targets. So the
plugin splits the two:

| layer | what it is | schema |
|---|---|---|
| **segment** | one saved source (the atom) | [`src/segments.js`](../src/segments.js) |
| **audience** | an `AND`/`OR`/`NOT` composition of segments — activation-agnostic | [`src/audiences.js`](../src/audiences.js) |
| **activation** | how an audience is *used*: ad-network delivery, client-side exposure, or a campaign | flags/status on the audience row, or the consumer plugin |

```
analytics (a chart selection)
        │  derive + dedup
        ▼
   SEGMENT ──compose (all/any + negate)──▶ AUDIENCE ──┬─▶ ad-network delivery (Mode A sync)
   (dynamic, named, dedup'd)              (dynamic)   ├─▶ client-side exposure (on-site lookup)
                                                        └─▶ campaigns module (email / SMS)
        └───────────────── resolved LIVE, every call ─────────────────┘
```

## 2. Segment — the atom

```js
segment {
  id,                       // uuid
  name,                     // AI-generated or user-supplied, human-facing
  source: { ... },          // { select: {about?, filter?, judge?} }  OR  { funnel, slot, status? }
  predicate_key,            // sha256 of the stable-sorted source → dedup identity
  origin,                   // provenance: { widget_id?, report_id?, selection, system? } (optional)
  created_at, updated_at,
}
```

- Typically **born from a chart selection** in Analytics: the user clicks a bar, the system derives the
  predicate, the AI names it (`nameSegment`), and the query stays hidden behind a named chip. Can also
  be authored directly via REST/MCP (`audiences_create_segment` / `POST /audiences/segments`).
- **Dedups on `predicate_key`, not the name** (`saveSegment` in `service.js`): selecting the same slice
  twice returns the *existing* segment. The AI name is a cosmetic label over a deterministic identity.
- `source` is resolved by the **core selector engine** via `evaluator.resolveSource` — `select` →
  `selector.resolve(…, {projection:'people'})`, `funnel` → `selector.funnel(…)` + the slot. Same
  resolution the evaluator has always used for a saved source — see
  [04 · Evaluator](04-evaluator.md).
- The plugin seeds one built-in segment on boot: **"Everyone"** — an empty `{select:{filter:{all:[]}}}`
  (`service.ensureDefaultSegments`), the universal building block for audiences that need a whole-base
  positive term to subtract from (e.g. *Everyone AND NOT reached*).

## 3. Audience — the composition

```js
audience {
  id, name,
  activation_id,            // slugified from name (or user-supplied), unique — the CAPI audience key
                             // and the client-side membership key
  rule: { op: 'all' | 'any', members: [ { segment, negate? } ] },
  delivery,                 // per-network sync status — see §5
  client_side,              // exposed to the client-side membership lookup?
  campaigns,                // available to the Campaigns module (email & SMS)?
}
```

`all` = AND (intersect the non-negated members), `any` = OR (union them); any `negate: true` member is
always subtracted. **Flat only** — no nested trees. At least one non-negated member is required (a
composition can't be defined purely as a NOT of the whole base).

An audience with `delivery` empty, `client_side: false`, and `campaigns: false` is legal: *defined and
sizeable, not yet activated anywhere.* You turn on a network, client-side exposure, or campaigns
eligibility independently and later.

## 4. Dynamic, never a roster

Membership is **never materialized**. An audience holds the *composition*; "who is in it" is a **live
read**, recomputed every time:

- `resolveSegment(id)` / `resolveAudience(id)` read straight through the selector engine / set algebra,
  with no cache — see [02 · Concepts](02-concepts.md) and [04 · Evaluator](04-evaluator.md).
- **Resolution is always set algebra over member segments.** `service.js`'s `segmentResolver()`
  memoises each distinct segment resolve within one audience resolution (so a segment referenced twice,
  or a positive that's also subtracted, resolves only once), then `evaluator.composeAudience` unions/
  intersects the id-sets and subtracts the negated ones. There is no "compile an all-`select`
  composition into one selector call" optimization — every member always resolves independently first.
- There is **no persisted qualification/audit record** for the audience layer — no equivalent of the
  old `whitebox_audience_matches` table. What persists is coarse: per-network `delivery` status
  (`{enabled, last_synced_at, last_count, dry_run}`) on the audience row itself.

## 5. Activation — the consumers

An audience is activation-agnostic; three independent surfaces read it:

| activation | how | identity needed | consent |
|---|---|---|---|
| **ad-network delivery** | `setDelivery(id, {network, enabled})` — resolves the audience, consent-gates it, dry-runs unless the network has an eligible adapter, stamps `last_synced_at`/`last_count` | hashed email/phone + click-ids (`identity.resolve`) | `consent.allowedCohort` (marketing) |
| **client-side exposure** | `setClientSide(id, enabled)` — a flag; `passportAudiences(passportId)` checks a passport against every `client_side` audience | none beyond the passport id itself (first-party) | none — immediate, first-party only |
| **campaigns** | `setCampaigns(id, enabled)` — a flag; the Campaigns module (a separate plugin) reads campaign-enabled audiences as send targets and resolves membership itself at send time | contactable email/phone (raw) | the Campaigns plugin's own channel consent |

Ad delivery is a **sync you trigger**, not a continuous process — see
[02 · Concepts](02-concepts.md#nothing-is-materialized) and [10 · Deployment](10-deployment.md).
Client-side and campaigns flags are immediate — flipping them changes what the next
`passportAudiences` call or campaigns-module read sees, with no third-party send involved.

## 6. Chart selection → segment (per chart)

The Analytics module (a separate plugin) translates a visual selection into a source. Covered kinds and
their derivation:

| chart | selection → source |
|---|---|
| breakdown / donut | bucket value → `select.filter: { <dim> = value }` |
| drop-off / funnel | the bar's transition → `funnel` + `slot: 'gap:i+1→i+2'` (`step:N` for a step) |
| distribution | a bin → `select.filter: { fact ∈ [lo, hi) }` |
| heatmap | a cell → `all: [ row-value, col-value ]` |
| scatter | a **box** brush → `all: [ factX ∈ [x0,x1], factY ∈ [y0,y1] ]` (range predicate — stays dynamic; a freeform lasso can't) |

No selection on cohort or timeseries charts (their cell/point predicates are ambiguous).

## 7. Historical note — the old `Rule` entity

An earlier `Rule` entity bundled a segment-like source with delivery + lifecycle in one row
(`whitebox_audience_rules`), plus a `whitebox_audience_matches` qualification-audit table and a
`whitebox_audience_deliveries` fired-event log, kept warm by a BullMQ worker and a daily scheduler
sweep. It was **fully wired — REST/MCP CRUD, worker, scheduler — but never adopted**: no UI ever wrote to
it, and it lived in a completely separate table from the segments/audiences this doc describes. It was
removed entirely (migration
[`011_drop_rule_system.js`](../src/migrations/011_drop_rule_system.js)); `src/rules.js` now only exports
the shared `Selector`/`Funnel`/`SLOT_RE` grammar segments reuse (see
[03 · Segment sources](03-segment-sources.md)). Nothing in this doc depends on it.
