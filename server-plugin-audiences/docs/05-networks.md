# 05 · Networks

All three networks use **Mode A**: WhiteBox fires a custom event, the platform builds the audience.
Each network is an **adapter** — data plus one method.

> The adapters live in the shared **[`whitebox-pro-adnetworks`](../../../adnetworks)** package, not
> in this plugin — they're the ad-network *transport*, reused by `analytics` to report standard
> conversion events (`purchase`, `lead`, …). This plugin just fires **custom** events through them.
> See that package's README for the contract + standard-event taxonomy.

## The adapter contract

```js
{
  name: 'meta',
  modes: ['event'],                 // ['event','membership'] in v2
  eligible: <bool>,                 // true only when its secrets are configured
  transport: 'http' | 'ga4',
  identitySpec: [ … ],              // browser signals the client must collect (→ the manifest)
  acceptedKeys: [ … ],              // which identity keys this network can match on
  async sendEvent(canonical, ids) { … }   // fire one event; return { status, matched_via, error }
}
```

- **`identitySpec`** flows server → client: the union across eligible adapters becomes the
  collection manifest. See [06 · Identity](06-identity.md).
- **`acceptedKeys`** is consumed server-side at send time — the core resolves a passport's identity and
  the adapter picks the subset it can use.
- **`sendEvent`** receives a `canonical` event — `{ event, … }` for a custom event (audiences) or
  `{ standard: 'purchase', value, currency, … }` for a standard event (analytics) — and the resolved
  `ids` `{ email_sha256, phone_sha256, external_id, signals, ip?, user_agent? }`.

Add a network = add an adapter factory in
[`whitebox-pro-adnetworks/src/adapters/`](../../../adnetworks/src/adapters), register it there,
and write a `docs/networks/<net>.md`.

## Eligibility

A network is **eligible** only when its credentials are present in config. `audiences_network_status`
/ `GET /audiences/networks` reports eligibility so you (and the agent) know what's targetable before
authoring segments and audiences.

## Encoding the audience: one event name per audience

In Mode A the audience is the **rule on your event** (the platform's own targeting rule, not this
plugin's data model). To keep that rule trivial and reliable on every platform, **fire a distinct
custom event name per audience**, keyed by its `activation_id` (`wb_enterprise_ready`,
`wb_trial_hesitant`). Put metadata (`score`, etc.) in event params, not the audience key — Meta's
custom-parameter audience filtering is spotty and you lose standard-event optimization.

## `event_id` and dedup

The adapter contract ([above](#the-adapter-contract)) is built around a per-network `sendEvent(canonical,
ids)` call, with the convention `event_id = "<activation_id>:<passport>:<yyyy-mm-dd>"`:
- **idempotent within a day** (re-runs don't double-count),
- **fresh across days** so a re-sync refreshes the platform's recency window,
- **shared with the browser pixel** if you also fire client-side, so the network deduplicates
  browser + server.

This plugin's own `setDelivery` (see [09 · API](09-api.md#delivery)) resolves the cohort, consent-gates
it, and records eligibility/counts; wiring it through to a live per-passport `sendEvent` call is what
"real" (non-dry-run) delivery does once a network is eligible.

## Per-network setup

- **[Meta](networks/meta.md)** — Conversions API custom event → Website Custom Audience.
- **[TikTok](networks/tiktok.md)** — Events API custom event → Custom Audience.
- **[Google / GA4](networks/google-ga4.md)** — Measurement Protocol event → GA4 audience → Google Ads / DV360.

## The platform-side step (one-time, per audience)

WhiteBox fires events; **you create the audience rule once** on each platform:

> *Custom Audience = people who triggered `wb_<activation_id>` in the last N days.*

Set N (the lookback window) generously — there's no automatic keep-warm sweep in this plugin (see
[02 · Concepts](02-concepts.md)), so re-syncing (via REST/MCP, or your own schedule) is what refreshes
the platform's recency window. A longer window gives you more slack between syncs.
