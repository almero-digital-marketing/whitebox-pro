// Geolocation plugin — passive, no-permission-prompt IP geolocation.
//
// Piggybacks on the ONE request every client SDK already makes on load
// (POST /sessions/resolve) via core's sessions.onResolve hook, instead of a
// second round-trip: the server derives geo from the request IP at the same
// moment it resolves the session, and the result rides along in that same
// response. The client reads it via wb.on('session.resolved', res => res.geo)
// — see whitebox-pro-client-plugin-geolocation for the thin wrapper.
//
// Structured state, not a bespoke store: a lookup becomes core FACTS
// (geo_country/geo_region/geo_city/geo_lat/geo_lon), the same pattern used for
// CRM state — so it's queryable via the selector for segmentation
// ({ filter: { fact: { geo_city: { eq: "Sofia" } } } }) and gets asOf/history
// for free, no new table.
//
// Factory: geolocation({ provider: maxmind({ … }), recordFacts? }).
// `provider` is a composed geolocation-provider descriptor (e.g.
// whitebox-geolocation-maxmind) implementing the neutral contract:
//   { name, lookup(ip) → { country, region, city, lat, lon } | null }
// The plugin stays provider-agnostic — swap providers without touching this file.

const FACT_KEYS = {
  country: 'geo_country',
  region: 'geo_region',
  city: 'geo_city',
  lat: 'geo_lat',
  lon: 'geo_lon',
}

// Human labels for the keys above — registered as DEFAULTS (ctx.facts.describe
// only sets a key that's still unset), so an operator's whitebox.config.js
// `facts.labels` entry always wins over these. Consumed by anything that shows
// a fact to a person or an AI: analytics compose vocabulary, audience rule
// authoring — see docs/02-concepts.md.
const FACT_LABELS = {
  geo_country: 'Country',
  geo_region: 'Region',
  geo_city: 'City',
  geo_lat: 'Latitude',
  geo_lon: 'Longitude',
}

export function geolocation(options = {}) {
  return {
    name: 'geolocation',

    async register(app, ctx) {
      const { sessions, facts, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'geolocation' })
      const config = options

      const provider = config.provider
      if (!provider) {
        throw new Error('geolocation(): a provider is required, e.g. geolocation({ provider: maxmind({ … }) })')
      }
      if (typeof provider.lookup !== 'function') {
        throw new Error(`geolocation(): provider "${provider.name || 'unknown'}" is missing required method lookup()`)
      }

      const recordFacts = config.recordFacts !== false   // on by default — unlocks segmentation

      if (recordFacts) {
        for (const [key, humanLabel] of Object.entries(FACT_LABELS)) facts.describe(key, humanLabel)
      }

      if (!sessions?.onResolve) {
        logger.warn('geolocation: core sessions.onResolve is unavailable — plugin has nothing to hook into')
        return
      }

      sessions.onResolve(async ({ passportId, req }) => {
        // trust proxy must be configured at the app level for req.ip to reflect
        // X-Forwarded-For behind a reverse proxy — same requirement the
        // shortener plugin's README already flags for req.hostname.
        const ip = req?.ip
        if (!ip) return null

        let geo
        try {
          geo = await provider.lookup(ip)
        } catch (err) {
          logger.warn({ err, ip }, 'geolocation: provider lookup failed')
          return null
        }
        if (!geo) return null

        if (recordFacts && passportId) {
          const observed_at = new Date()
          for (const [field, key] of Object.entries(FACT_KEYS)) {
            const value = geo[field]
            if (value == null) continue
            facts.record({ passport_id: passportId, key, value, source: 'geolocation', observed_at })
              .catch(err => logger.warn({ err, key }, 'geolocation: facts.record failed'))
          }
        }

        return { geo }
      })

      logger.info('Geolocation plugin ready (provider: %s)', provider.name || 'unknown')
    },
  }
}
