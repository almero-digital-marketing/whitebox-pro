# Audiences plugin — documentation

Everything you need to take this from a scaffold to a working integration.

## Read in order

1. **[01 · Architecture](01-architecture.md)** — the components, the data flow, and the data model.
2. **[02 · Concepts](02-concepts.md)** — Mode A vs Mode B, segments vs audiences, and why nothing is
   materialized.
3. **[03 · Segment sources](03-segment-sources.md)** — the shared `select` / `funnel`+`slot` grammar a
   segment's source is built from.
4. **[04 · Evaluator](04-evaluator.md)** — how the evaluator is a thin adapter over the core selector
   engine: resolving a segment's source, and composing an audience's member segments.
5. **[05 · Networks](05-networks.md)** — the adapter contract and Mode A per network, plus per-network
   setup: [Meta](networks/meta.md) · [TikTok](networks/tiktok.md) · [Google / GA4](networks/google-ga4.md).
6. **[06 · Identity](06-identity.md)** — the client-collection manifest, the capture shim, hashing,
   and how match keys are resolved.
7. **[07 · CRM integration](07-crm-integration.md)** — CRM state as **core facts**, queried via
   `select.filter.fact`, and how that reaches the selector engine.
8. **[08 · Consent & privacy](08-consent-privacy.md)** — the suppression + consent gate every delivery
   passes through, and PII hashing.
9. **[09 · API](09-api.md)** — the full REST + MCP reference and the two-tier auth model.
10. **[10 · Deployment](10-deployment.md)** — config, env vars, and migrations.
11. **[11 · Segments & audiences](11-segments-and-audiences.md)** — segments (chart-derived dynamic
    sub-queries) composing into audiences (`AND`/`OR`/`NOT`), the shared targeting layer used by both
    ad-network delivery **and** the campaigns module (email/SMS).

## The 60-second mental model

- A **segment** is a saved cohort definition: a core **selector** (`about / filter / judge`) or a
  **funnel** slot (`step:N` / `gap:N→M`). Segments dedup on a deterministic hash of their source
  (`predicate_key`) — saving the same slice twice returns the existing segment.
- An **audience** is a boolean composition of segments — `{op: 'all'|'any', members: [{segment,
  negate?}]}`. This is the deliverable layer: it carries an `activation_id`, and can sync **delivery**
  to ad networks (Meta/TikTok/Google), be exposed **client-side** (on-site membership lookup), or be
  exposed to the **Campaigns** module.
- Both resolve **live** — the core **selector engine** computes membership on every call; nothing is
  materialized or cached, and there's no background worker keeping anything "warm."
- Management is over REST + MCP, both thin transports over one [`service.js`](../src/service.js).

## Conventions in this codebase

- Modules use `init(deps)` + free named exports (module singletons), matching the WhiteBox core.
- One **service layer** ([`src/service.js`](../src/service.js)); REST and MCP are thin transports over it.
- Adapters are **data + two methods** — declare constraints, fire an event. Add a network = add an
  adapter + a `docs/networks/*.md`.
