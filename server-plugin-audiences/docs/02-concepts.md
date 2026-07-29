# 02 · Concepts

Read this once and the rest of the docs make sense.

## Segments and audiences

The plugin has two persisted concepts — full detail in
[11 · Segments & audiences](11-segments-and-audiences.md):

- **Segment** ([`src/segments.js`](../src/segments.js)) — a saved *source*: a core selector (`{select:
  {about?, filter?, judge?}}`) or a funnel cohort (`{funnel: {...}, slot: 'step:N'|'gap:N→M', status?}`).
  Exactly one of `select` / `funnel`. Deduped by a deterministic hash of the source (`predicate_key`) —
  saving the same slice twice returns the existing row.
- **Audience** ([`src/audiences.js`](../src/audiences.js)) — a boolean composition of segments: `{op:
  'all'|'any', members: [{segment, negate?}]}`. `all` intersects the non-negated members, `any` unions
  them, and any `negate: true` member is subtracted. This is the **deliverable** layer — it carries an
  `activation_id`, per-network `delivery` status, and `client_side` / `campaigns` exposure flags.

Segments are the atom; audiences compose them. Both resolve through the same core selector engine — see
[04 · Evaluator](04-evaluator.md).

## Mode A vs Mode B (ad-network delivery)

There are two ways to turn an audience into an audience *on an ad network*. **This plugin does Mode A.**

### Mode A — event → audience rule (v1)

You fire a **custom event** (e.g. `wb_enterprise_ready`) with hashed identity. On the platform you
create — **once** — a Custom Audience whose rule is *"people who triggered `wb_enterprise_ready` in
the last N days."* The platform pools, sizes, and ages the audience.

- ✅ low setup (one audience rule per WhiteBox audience), works below min-size (platform pools), zero
  ongoing membership plumbing.
- ⚠️ **no explicit removal** — you stop syncing, the platform ages people out by its own window; you
  don't control the final audience size.

### Mode B — membership upload (v2)

You create a named audience and **add/remove members directly** with hashed identifiers. Full control
(removal, decay, first-party-only signals), but more setup (audience CRUD, OAuth, min-size buffering).

| | Mode A | Mode B |
|---|---|---|
| audience defined | a rule on your event, on-platform | a member list, in WhiteBox |
| who manages membership | the platform (recency window) | WhiteBox (explicit add/remove) |
| removal / decay | window only | precise |
| small audiences | platform pools | blocked by min-size |
| WhiteBox knows | who's deliverable (count) and when it last synced | the roster + size |

> **Why Mode A first:** zero per-audience membership management, and it works the day you ship — the
> platform does the pooling. Mode B (direct membership upload) is a future extension, not implemented
> today.

## Nothing is materialized

Neither a segment nor an audience holds a roster. `resolveSegment` / `resolveAudience` compute
membership **fresh, on every call**, via the selector engine (segments) and set algebra over segment
id-sets (audiences) — see [04 · Evaluator](04-evaluator.md). There's no cache to invalidate and no
background job keeping anything "warm": a CRM fact change or a new awareness event is reflected the
next time the segment/audience is resolved, automatically.

This also means **delivery is an explicit, on-demand sync**, not a continuous background process.
Calling `setDelivery(id, {network, enabled: true})` resolves the audience, consent-gates it, and stamps
`last_synced_at` / `last_count` for that network **once** — it dry-runs automatically when no eligible
adapter is configured for that network. Nothing re-fires on its own; sync again (via REST/MCP, or your
own schedule) to refresh a platform's recency window.

## What "explainability" looks like today

The selector engine computes a `why` / `score` for every member of a `select`-sourced segment (and a
synthetic `funnel <slot>` reason for a funnel-sourced one) — see [04 · Evaluator](04-evaluator.md). But
the segment/audience member endpoints (`GET /segments/:id/members`, `GET /audiences/:id/members`) only
return **ids** — there's no persisted per-match audit trail or `explain` tool today. (An earlier, unused
`Rule` entity had one — a `matches` + `deliveries` table pair with a full audit trail — but it was
dropped along with the rest of that system; see [01 · Architecture](01-architecture.md).) If you need a
per-passport "why was this person targeted," it has to be read live off the engine's resolve, not from
a stored record.
