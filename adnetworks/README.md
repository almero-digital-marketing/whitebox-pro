# whitebox-pro-adnetworks

The shared **kernel** for ad-network conversion tracking. Per-network specifics
live in their **own self-contained repos** (each released independently; clone
into `./integrations` for local dev) and are **composed** like plugins:

- `whitebox-pro-adnetworks-meta` — Meta (Conversions API + Pixel)
- `whitebox-pro-adnetworks-google` — GA4 (Measurement Protocol + gtag)
- `whitebox-pro-adnetworks-tiktok` — TikTok (Events API + Pixel)

Each owns everything about its network — the canonical→network event map, the
browser signal specs, the server adapter, and the client pixel — and is called
as a factory:

```js
// server (whitebox.config.js) — fan-out leg, with creds
import { meta }   from 'whitebox-pro-adnetworks-meta'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok'
conversions({ networks: [ meta({ pixelId, accessToken }), tiktok({ pixelCode, accessToken }) ] })

// client (browser) — pixel leg, no creds (the base snippet carries the id)
import { meta } from 'whitebox-pro-adnetworks-meta/client'
conversions({ networks: [ meta(), tiktok() ] })
```

A composed network descriptor:

| surface | shape |
|---|---|
| server (`.`) | `{ name, signals[], eligible, modes, transport, async sendEvent(canonical, ids) }` |
| client (`/client`) | `{ name, signals[], present(), collect(), fire(kind, name, payload, eventId) }` |
| spec (`/spec`) | pure: `{ name, pixelGlobal, events, signals, eventName(canonical) }` |

## What this kernel provides

- **`./schemas`** — zod payload schemas (`validateEvent`, `validateCustom`, `CONVERSION_EVENTS`). Client-safe.
- **`./browser`** — pure client helpers (`cookie`, `param`, `stickyParam`, `clickIdClaims`, `removeUndefined`, `toItems`) the pixels use.
- **`.`** — the above plus `CANONICAL_EVENTS` and identity helpers (`hashEmail`, `hashPhone`, `composeManifest`, `pick`). Server-side (uses `node:crypto`).

`composeManifest(networks)` unions the eligible networks' `signals` into the
declarative client-collection manifest. Adding a network = a new package; no
edits to a central registry.

### Click ids

A signal spec may add `clickId: true` (URL signals only):

```js
{ key: 'gclid', from: 'url', name: 'gclid', clickId: true }
```

Two things follow from that flag, and nothing in core needs to know what the
parameter means:

- **`stickyParam(name)`** reads the URL, remembers the value for 90 days, and keeps
  returning it once the URL no longer has it. Click ids arrive once, on the landing
  page, and a conversion almost never happens there — read late with plain
  `param()` the id is simply absent, so the hit reaches the network with nothing to
  attribute the sale to. A fresh click always beats a remembered one, so a second
  campaign is never credited to the first.
- **`clickIdClaims(networks)`** turns whatever the composed networks declare into
  `{ type: 'clickid', name, value }` identity claims, which
  `client-plugin-conversions` POSTs to `/passports/link` on arrival.

`clickid` is deliberately a **weak** identity type. Weak identities attach to one
passport and never drive a merge — which matters, because click ids look unique and
are not: on ten days of one deployment's live traffic 2,237 distinct `gclid` values
had been seen by more than one passport (one by nine of them), and `gbraid` by 48%,
since it names a campaign rather than a click when consent limits tracking. As a
strong (merge-key) type those would have permanently fused thousands of unrelated
people.
