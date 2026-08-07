import path from 'path'
import { fileURLToPath } from 'url'

import * as outbox from './outbox.js'
import * as sender from './sender.js'
import * as inbox from './inbox.js'
import * as status from './status.js'
import * as bulk from './bulk.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import { createRouter } from './router.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import { resolveAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'
import { attribution } from 'whitebox-pro-server/event-format'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: sms({ provider: twilio({…}), routes: { '+359': mobica({…}) }, auth }).
// `provider` is the default/fallback SMS provider; `routes` maps E.164 prefixes
// to provider overrides (longest match wins). Providers own send + webhook auth
// + payload parsing; the plugin owns outbox/status/suppressions/awareness.
export function sms(options = {}) {
  return {
    name: 'sms',

    // What our events mean (see server/src/event-catalog.js). Same reading as
    // mail: a delivery report is the provider telling us about OUR send, so it
    // stays on the outbound leg; only a reply is genuinely inbound. SMS has no
    // open or click to speak of, so `sms.received` is the whole inbound side.
    //
    // `severity` reads the same as mail's, for the same two events: failed is
    // ours (the message never went), bounced is the network refusing a number
    // we sent to.
    events: {
      'sms.queued': 'out',
      'sms.sent': 'out',
      'sms.failed': { direction: 'out', severity: 'error' },
      'sms.delivered': 'out',
      'sms.bounced': { direction: 'out', severity: 'warn' },
      'sms.bulk.queued': 'out',
      'sms.bulk.cancelled': 'internal',
      'sms.received': 'in',
    },

    // What one of our events was ABOUT, for a feed row.
    detail: {
      'sms.bulk.': (d) => {
        const n = d.accepted ?? d.cancelled ?? null
        if (n !== null) return `${n} recipients`
        return d.batch_id ? `batch ${d.batch_id}` : null
      },
      // Recipient and outcome only — NEVER the message text. The event registry
      // strips `body` at the write (it's message content, and the log crosses
      // permission boundaries), so reading it here would make a backfilled row
      // describe itself differently from the same event arriving live off the
      // firehose — the one thing computing detail in a single place prevents.
      // Segment count is the useful non-sensitive extra.
      'sms.': (d) => {
        const who = d.to || d.phone || null
        const why = d.failure_reason || d.reason || d.error_message || null
        const what = why
          ? `— ${why}`
          : (d.segments ? `${d.segments} segment${d.segments === 1 ? '' : 's'}` : null)
        const head = [who, what].filter(Boolean).join(who && why ? ' ' : ' · ')
        // WHY it went out — the outbox row carries campaign_id / journey_id and we
        // notify with the row itself, so this was always available and never shown.
        return [head || null, attribution(d)].filter(Boolean).join(' · ') || null
      },
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_sms_migrations',
      })
    },

    async register(app, ctx) {
      const { db, queue: q, events, webhooks, passports, sessions, templates, awareness, eventRegistry, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'sms' })
      const smsConfig = options

      const router = createRouter({ provider: smsConfig.provider, routes: smsConfig.routes })
      const config = { ...ctx.config, sms: smsConfig }

      const { notify } = createNotify({ webhooksConfig: smsConfig.webhooks, events, webhooks, eventRegistry })
      const authVerifier = resolveAuth(smsConfig.auth, { logger })
      if (!authVerifier) throw new Error('sms: auth (a secret or a composed verifier) is required')
      const requireAuth = authVerifier.middleware

      suppressions.init({ db, logger, defaultCountry: smsConfig.defaultCountry })
      invalid.init({ db, logger, defaultCountry: smsConfig.defaultCountry })
      sender.init({ router })
      outbox.init({ db, q, templates, passports, sessions, awareness, notify, config, logger })
      inbox.init({ config, db, passports, sessions, awareness, notify, logger, router })
      status.init({ awareness, notify, logger, router })
      bulk.init({ notify, logger, config })

      mountRoutes(app, { requireAuth })
      registerMcp(ctx, { db })

      // Stuck-row reaper: queued rows that never resolved → failed (no double-send).
      const interval = setInterval(
        () => outbox.markStuck(smsConfig.outbox?.stuckThresholdMs).catch(() => {}),
        smsConfig.outbox?.stuckCheckIntervalMs ?? 60_000,
      )
      interval.unref?.()

      logger.info('SMS plugin ready (providers: %s)', router.names().join(', ') || 'none')

      // Exposed on ctx.plugins.sms for other plugins (e.g. journeys) to send SMS
      // internally — outbox.queueSend already does create()+enqueue(), so the
      // worker's preflightBlock (suppression/invalid) gate runs same as any
      // other queued send. `send` is an alias of the same function; there is
      // no separate raw/ungated path in this plugin (unlike mail's mailer.send).
      return { service: { send: outbox.queueSend, queueSend: outbox.queueSend, bulkSend: bulk.send, funnel: outbox.funnel , stats: outbox.stats, status: outbox.status } }
    },
  }
}

export default sms
