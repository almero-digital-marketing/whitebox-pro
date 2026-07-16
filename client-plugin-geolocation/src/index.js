// Geolocation plugin — reads the passive IP-geolocation lookup that rides
// along on the /sessions/resolve response (server-plugin-geolocation, via the
// core sessions.onResolve hook). No permission prompt, no extra request —
// this plugin does nothing but listen and expose what's already there.
//
// get() stays a method (not a plain property) since geo can update after a
// later session.resolved — a plain property snapshot at attach time would go
// stale. Callers reach this plugin via `await wb.plugin('geolocation')`, so
// there's no need for get() itself to return a Promise.

export default function geolocationPlugin() {
  return {
    name: 'geolocation',

    install(core) {
      const { emitter } = core
      let geo = null

      function onResolved(res) {
        if (res && res.geo) geo = res.geo
      }
      emitter?.on?.('session.resolved', onResolved)

      core.attach('geolocation', {
        get: () => geo,   // { country, region, city, lat, lon } | null (null until resolved, or no data for this IP)
      })

      return () => emitter?.off?.('session.resolved', onResolved)
    },
  }
}
