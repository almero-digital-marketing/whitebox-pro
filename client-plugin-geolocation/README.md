# Geolocation Client Plugin

> Exposes the passive IP-geolocation lookup that already rides along on the
> `/sessions/resolve` response — no permission prompt, no extra request.

## What it is

The landing-page half of [`server-plugin-geolocation`](../server-plugin-geolocation).
The server derives a visitor's coarse location from their IP at the same
moment it resolves their session (`sessions.onResolve`), and the client core
re-emits the full resolve response as `session.resolved`. This plugin just
listens for that and exposes what it finds.

```js
import { createClient } from 'whitebox-pro-client'
import geolocation from 'whitebox-pro-client-plugin-geolocation'

const wb = createClient({ /* … */, plugins: [ geolocation() ] })

wb.on('ready', () => {
  const geo = wb.geolocation.get()
  // { country, region, city, lat, lon } | null — null until resolved, or if
  // the server has no data for this IP
})
```

No permission dialog (unlike the browser's native `navigator.geolocation`) —
this is IP-based, city/region precision, available the moment the session
resolves.
