# Geolocation Plugin

> Passive, no-permission-prompt IP geolocation — know a visitor's coarse
> location the moment they arrive, with no extra request and no browser
> permission dialog.

## What it is

Every whitebox-pro client SDK already calls `POST /sessions/resolve` once on
load. This plugin piggybacks a geo-IP lookup onto that same request — via
core's `sessions.onResolve` hook — instead of adding a second round-trip. The
result rides along in the resolve response; the client reads it via
[`whitebox-pro-client-plugin-geolocation`](../client-plugin-geolocation).

Unlike the browser's native `navigator.geolocation`, this is IP-based (city/
region-level precision), so there's no permission prompt — the same passive
behavior most geo-personalization needs (default currency, nearest-location
picker, coarse targeting).

## Structured state, not a bespoke store

A lookup becomes core **facts** — `geo_country` / `geo_region` / `geo_city` /
`geo_lat` / `geo_lon`, tagged `source: 'geolocation'` — the same pattern used
for CRM state. That means:

- queryable via the selector for segmentation:
  `{ filter: { fact: { geo_city: { eq: "Sofia" } } } }`
- `asOf` time-travel and full history for free (facts are append-only) — no
  new table, no extra design.

Set `recordFacts: false` to skip this and treat geo as purely ephemeral
(returned in the resolve response only).

## Provider contract

The plugin is provider-agnostic — swap the geo-IP backend without touching
this package:

```js
provider.name            // for logging
provider.lookup(ip)      // → { country, region, city, lat, lon } | null
provider.health?.()      // OPTIONAL → { dbPath, loaded, loadedAt, mtimeMs, watching }
```

`health()` is optional and only feeds `status()` below — a provider that can't
describe its data source (a network API, say) just omits it.

## Install

```js
import { geolocation } from 'whitebox-pro-server-plugin-geolocation'
import { maxmind } from 'whitebox-pro-geolocation-maxmind'

geolocation({
  provider: maxmind({ dbPath: process.env.GEOIP_DB_PATH, watch: true }),
  // recordFacts: true (default) — false to skip writing facts
  // staleAfterDays: 30 (default) — when status() starts calling the GeoIP DB stale
})
```

Requires `trust proxy` configured at the app level for `req.ip` to reflect
`X-Forwarded-For` behind a reverse proxy (same requirement the shortener
plugin's README already flags for `req.hostname`).

## Monitoring (`status()`)

`register()` returns `{ service: { status } }` so any monitoring surface can pick
this plugin up (see `docs/10-plugin-status.md`). It reports `lookups`, `no data`
(the provider had nothing for that IP — private/reserved ranges land here, so it
is not a fault), `failed` (the provider threw — marked bad), and, when the
provider implements `health()`, `database age (days)` plus a `stale database`
flag.

Nothing here is windowed by `since`: this plugin owns no tables, so the counts are
process-lifetime and the database's age is live state. The age is the point —
a stale GeoIP database keeps answering plausibly for months without ever raising
an error, and that is precisely the failure nobody notices.

## Design notes

- **No REST route, no migration.** Everything piggybacks on the session-resolve
  hook; geo becomes core facts (an existing table). The smallest plugin in the
  repo, on purpose.
- **A provider error never breaks session resolution.** A failed or missing
  lookup returns `null` from the hook — the visitor still gets a session, just
  without `geo` in the response.
- **Facts are best-effort.** A `facts.record` failure is logged and swallowed,
  not surfaced to the caller — geolocation is enrichment, not a required write.
