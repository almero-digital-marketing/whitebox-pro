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
import { money, urlPath } from 'whitebox-pro-server/event-format'
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
    //
    // `severity` splits the two failure modes the comment above already draws:
    // `error` is the call itself going wrong (timeout, 5xx, a broken adapter) —
    // ours to fix; `rejected` is the network answering and saying no, which is
    // a data problem with what we sent. Both matter, and conflating them would
    // send someone reading the feed to the wrong place.
    events: {
      'conversion.': 'in',
      'adnetwork.accepted': 'out',
      'adnetwork.rejected': { direction: 'out', severity: 'warn' },
      'adnetwork.error': { direction: 'out', severity: 'error' },
    },

    // What one of our events was ABOUT, for a feed row. Two functions, because
    // the two event families answer completely different questions: what the
    // conversion was WORTH, versus why a network refused it.
    detail: {
      // Value first — it's why anyone looks at a conversion — then WHERE. Both,
      // when there are both: "120 BGN · /checkout" answers more than either half.
      //
      // NOT `kind`. It holds 'standard' or 'custom', which is a fact about our own
      // schema and not about what happened — a row reading "standard · /" says
      // nothing the `conversion.contact` in the type column hasn't already said.
      // The page on its own is the better answer when there's no money.
      'conversion.': (d) =>
        [money(d.value, d.currency), urlPath(d.url)].filter(Boolean).join(' · ') || null,

      // network · event · page, and the failure reason when there is one — that
      // reason is the entire point of the event.
      //
      // The page matters as much as the rest: "tiktok · page_view" is unreadable
      // on a busy feed, because page_view of WHAT? Every row looks identical.
      'adnetwork.': (d) => {
        const head = [d.network, d.event, urlPath(d.url)].filter(Boolean).join(' · ')
        return d.error ? `${head} — ${d.error}` : head || null
      },

      // ── awareness rows WE recorded ────────────────────────────────────────
      //
      // `awareness.recorded` is CORE's event, but we compose its payload when we
      // call awareness.record(), so we are the only ones who can read it well.
      // Core's generic version rendered ours as "conversion · localhost": the
      // category (which just restates the channel column) and the hostname (the
      // same on every row). Neither says what happened or where.
      //
      // What we actually wrote is a `content_id` of `conversion:<name>:<uuid>`,
      // so the NAME is right there — and the page is in content_url.
      'awareness.recorded': (d) => {
        const name = String(d.content_id || '').split(':')[1] || d.source || null
        return [name, urlPath(d.content_url)].filter(Boolean).join(' · ') || null
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
