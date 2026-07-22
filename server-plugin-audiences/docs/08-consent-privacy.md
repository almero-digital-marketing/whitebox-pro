# 08 · Consent & privacy

Forwarding **AI-inferred** behavioral segments to third-party ad networks is the most legally sensitive
thing this plugin does. Consent and hashing are **load-bearing**, not polish.

## The gates (in order)

Every passport passes two gates before it counts as **deliverable** (`consent.js`'s `allowedCohort`,
called from `service.js`'s `previewCohort` / `previewDelivery` / `setDelivery`):

```
1. suppression   — on the do-not-target list?          → drop (hard)
2. consent       — has the required consent category?   → drop unless granted
```

Both run over the **whole cohort in one batched query** (not N sequential round-trips): suppression via
`store.suppressedAmong(ids)`, consent only on the survivors and only when
`privacy.requireConsentCategory` is configured. A passport that fails either gate is simply excluded
from `deliverable` — nothing is sent for it, and it isn't part of that sync's `last_count`.

> An earlier `Rule` entity also had a third gate — a `non_sensitive` policy / sensitive-category guard
> (`consent.policyAllows()`, checked per rule). It was only ever called from the now-removed
> `delivery.js` and was dropped along with the rest of that system (see
> [01 · Architecture](01-architecture.md)). **There is no sensitive-category guard today** — if you need
> one for AI-inferred segments, it has to be re-added.

## 1. Suppression

A hard do-not-target list (`whitebox_audience_suppression`). A suppressed passport is **never** counted
as deliverable for any audience, regardless of consent. Use it for opt-outs and legal holds.

```
audiences_suppress { passport_id, reason }      # MCP
POST /audiences/passports/:pid/suppress         # REST
```

## 2. Consent

Configured by `privacy.requireConsentCategory` — unset by default, meaning **no consent gate runs**
until you configure one. When set, the plugin **default-denies** if no consent source is wired (`passports.hasConsent`
isn't implemented) — you cannot accidentally forward un-consented users just by turning the gate on.

**Wire your consent source.** The client already has a `consent` module (`marketing` category). Persist
a per-passport flag server-side — e.g. write it at `/sessions/resolve` from the client consent state, or
expose a `consent` context provider — and implement `passports.hasConsent(passport, category)` (the
hook `consent.js` calls). Also honor GPC / DNT and a global kill-switch upstream.

## PII hashing

- Email/phone are **SHA-256 hashed** before they leave your server (`identity.resolve`): email
  lowercased/trimmed; phone reduced to digits (prefix the country code for true E.164).
- **Raw PII is never sent.** Networks match on hashes.
- **Awareness chunk text is PII-redacted** at ingest (`redactPii`), so match keys never come from
  content — only from passport identities. This keeps the semantic layer clean of identifiers.

## No persisted audit trail

There is no per-passport delivery log or `explain` tool today. The `whitebox_audience_matches` /
`whitebox_audience_deliveries` tables and the `audiences_explain_match` MCP tool belonged to the removed
`Rule` entity and were dropped with it (migration `011_drop_rule_system.js`). What persists instead is
coarse, per-network delivery metadata on the audience row itself: `delivery.<network> = {enabled,
last_synced_at, last_count, dry_run}` — a count and a timestamp, not a per-passport record. If you need
a GDPR "why was this person targeted" answer, it has to be derived live from the segment/audience
definition (see [02 · Concepts](02-concepts.md)), not read from a stored record.

## Data minimization

- Only the **hashed** identifiers + browser ad signals leave the system.
- On erasure (a passport's right-to-be-forgotten), the core's `awareness.forget` removes content; also
  delete that passport's `whitebox_audience_identities` / `whitebox_audience_suppression` rows as
  appropriate.

## Checklist before going live

- [ ] `privacy.requireConsentCategory` set (if you need the gate) and `passports.hasConsent` wired.
- [ ] PII hashing verified (normalize before hashing).
- [ ] Suppression endpoint reachable by your support/ops flow.
- [ ] Per-network data-use / consent terms accepted (Meta, TikTok, Google).
- [ ] Decide whether you need a sensitive-category guard for AI-inferred segments re-added — there
  isn't one built in (see above).
