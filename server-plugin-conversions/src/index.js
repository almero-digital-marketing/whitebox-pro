// whitebox-pro-server-plugin-conversions
//
// Receives standard/custom conversion events from the browser
// (POST /conversions/events, via whitebox-pro-client-plugin-conversions), records
// each as a first-party awareness signal, and — consent permitting — fans it
// out to the ad networks (Meta CAPI / GA4 MP / TikTok Events API) through the
// shared whitebox-pro-adnetworks adapters, deduped against the browser pixels by
// event_id. The standard-event payloads validate against the SAME schemas the
// client uses (whitebox-pro-adnetworks/schemas).
//
// Factory: conversions({ networks, auth: { secret }, consent }).

import path from 'path'
import { fileURLToPath } from 'url'

import { resolveAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'
import { money, pathOf } from 'whitebox-pro-server/event-format'
import * as store from './store.js'
import * as ingest from './ingest.js'
import { createReporter } from './reporter.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function conversions(options = {}) {
  return {
    name: 'conversions',

    // What our events mean (see server/src/event-catalog.js). We emit two
    // genuinely different things and they must not be conflated:
    //
    //   conversion.${name}   the VISITOR converted. Inbound. A prefix because the
    //                        name is the host's (purchase, lead, view_content, or
    //                        anything they invent) — there is no closed set.
    //                        NB the type is singular; live used to declare
    //                        'conversions.' plural, which matched nothing, so
    //                        every conversion classified as `unknown`.
    //
    //   adnetwork.${status}  OUR server-to-server call to Meta/TikTok/GA4.
    //                        Outbound even when it fails — the call left the
    //                        building, which is exactly what makes a rejection
    //                        worth seeing in a monitoring view rather than only
    //                        in a log. The conversion already counted as a
    //                        success, so it cannot express this.
    //
    // Enumerated for adnetwork because the vocabulary is OURS: reporter.js only
    // notifies for adapters it actually called, with res.status ∈ accepted |
    // rejected | error. `skipped` is deliberately absent — an ineligible network
    // `continue`s before the notify, so no adnetwork.skipped event has ever
    // existed. It's a counter in our status(), not an event.
    events: {
      'conversion.': 'in',
      'adnetwork.accepted': 'out',
      'adnetwork.rejected': 'out',
      'adnetwork.error': 'out',
    },

    // What one of our events was ABOUT, for a feed row. Two functions, because
    // the two event families answer completely different questions: what the
    // conversion was WORTH, versus why a network refused it.
    detail: {
      // Value first — it's why anyone looks at a conversion. Then where it
      // happened, which at least locates it when there's no money attached.
      'conversion.': (d) => money(d.value, d.currency) || pathOf(d.url) || d.kind || null,

      // The failure reason is the entire point of the event when there is one.
      'adnetwork.': (d) => {
        const head = [d.network, d.event].filter(Boolean).join(' · ')
        return d.error ? `${head} — ${d.error}` : head || null
      },
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_conversions_migrations',
      })
    },

    async register(app, ctx) {
      const { db, passports, awareness, events, webhooks, eventRegistry, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'conversions' })

      // The public POST ingress needs no secret. Auth only guards the admin GET
      // audit endpoint — so it's optional: lock that route with a 401 until it's
      // configured (a secret, or a composed verifier like auth0()), rather than
      // refusing to boot without one.
      const authVerifier = resolveAuth(options.auth, { logger })
      const requireAuth = authVerifier
        ? authVerifier.middleware
        : (req, res) => res.status(401).json({ error: 'conversions: set auth to use the audit endpoint' })

      // notify first: the reporter emits per-network delivery events through it,
      // so it has to exist before the reporter is constructed.
      const { notify } = createNotify({ webhooksConfig: options.webhooks, events, webhooks, eventRegistry })

      const reporter = createReporter({ networks: options.networks || [], passports, logger, notify })

      // Consent gate for ad-network fan-out. The client already gates on
      // marketing consent before sending, so the default is to honour that
      // (forward). Set consent.require:true to ALSO enforce a server-side source
      // — provide consent.check(passportId) or it default-denies.
      const consentCfg = options.consent || {}
      const consentOk = async (passportId) => {
        if (!consentCfg.require) return true
        if (typeof consentCfg.check === 'function') return !!(await consentCfg.check(passportId))
        return false
      }

      // Init singletons in dependency order.
      store.init({ db, logger })
      ingest.init({ awareness, reporter, consentOk, logger, resolvePassport: passports.resolve, notify })

      mountRoutes(app, { requireAuth, logger })
      registerMcp(ctx, { store })

      const eligible = reporter.networks().filter(n => n.eligible).map(n => n.name)
      logger.info('Conversions plugin ready (%s)', eligible.length ? `networks: ${eligible.join(', ')}` : 'awareness-only, no networks configured')

      // `service.status` is the self-describing health form monitoring surfaces
      // discover (docs/10-plugin-status.md) — nothing has to be told this plugin
      // exists. It lives on the store because the audit table is where the
      // per-network verdicts were written; `reporter` stays exactly as it was.
      return { reporter, service: { status: store.status } }
    },
  }
}
