import path from 'path'
import { mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'

import * as outbox from './outbox.js'
import * as mailer from './mailer.js'
import * as inbox from './inbox.js'
import * as tracking from './tracking.js'
import * as attachments from './attachments.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as bulk from './bulk.js'
import { resolveAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'

import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import { startStuckReaper } from './stuck-reaper.js'
import { short, attribution } from 'whitebox-pro-server/event-format'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REQUIRED_PROVIDER_METHODS = ['send', 'verifySignature', 'parseInbound', 'parseTracking']

// Factory: mail({ provider: mailgun({ … }), company, auth: { secret } }).
// `provider` is a composed mail-provider descriptor (whitebox-pro-mail-mailgun,
// whitebox-pro-mail-postmark, …) — it owns the SDK/transport, webhook authenticity,
// and the inbound/tracking payload shapes. The plugin stays provider-agnostic.
export function mail(options = {}) {
  return {
    name: 'mail',

    // What our events mean (see server/src/event-catalog.js).
    //
    // The split that matters: delivered/bounced are the provider reporting on a
    // message WE sent, so they belong to the outbound leg — not a reply. What the
    // RECIPIENT does is inbound: an open, a click ('engaged'), a complaint. That
    // is deliberately a different reading from how the same open is recorded in
    // awareness, where it counts as `exposure` (content reaching them) — because
    // "was this seen" and "did someone react" are different questions.
    //
    // The tracked statuses are exactly what tracking.js's statusMap produces —
    // delivered, opened, engaged, bounced, complained. Enumerated rather than
    // declared as a `'mail.'` prefix on purpose: a prefix would swallow a new
    // event type silently, and an unclassified one showing up as `unknown` is
    // the signal that it needs a decision here.
    events: {
      'mail.queued': 'out',
      'mail.sent': 'out',
      'mail.failed': 'out',
      'mail.delivered': 'out',
      'mail.bounced': 'out',
      'mail.bulk.queued': 'out',
      // Nothing left the building — a cancelled batch is bookkeeping.
      'mail.bulk.cancelled': 'internal',
      'mail.received': 'in',
      'mail.opened': 'in',
      'mail.engaged': 'in',
      'mail.complained': 'in',
    },

    // What one of our events was ABOUT, for a feed row. Two functions for eleven
    // event types, which is why `detail` is keyed separately from `events`:
    // a batch is described by its size, a single message by its recipient.
    detail: {
      // Size AND which batch. "240 recipients" on its own is unreadable the
      // moment two batches are in flight — they read identically.
      'mail.bulk.': (d) => {
        const n = d.accepted ?? d.cancelled ?? null
        const which = d.batch_id ? `batch ${short(d.batch_id)}` : null
        return [n !== null ? `${n} recipients` : null, which].filter(Boolean).join(' · ') || null
      },
      'mail.': (d) => {
        // A failure reason is the entire point of the row when there is one, so
        // it displaces the subject rather than crowding in beside it.
        const who = d.to || null
        const why = d.failure_reason || null
        const what = why ? `— ${why}` : (d.subject || null)
        const head = [who, what].filter(Boolean).join(who && why ? ' ' : ' · ')
        // WHY this went out. The outbox row carries campaign_id / journey_id (we
        // notify with the row itself), and "this was a campaign send" vs "this was
        // transactional" is the first thing you want to know about an unexpected
        // send — it was in the payload all along and never shown.
        return [head || null, attribution(d)].filter(Boolean).join(' · ') || null
      },
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_mail_migrations',
      })
    },

    async register(app, ctx) {
      const { db, queue: q, events, webhooks, passports, sessions, templates, awareness, eventRegistry, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'mail' })
      const mailConfig = options

      const provider = mailConfig.provider
      if (!provider || typeof provider.send !== 'function') {
        throw new Error('mail(): a provider is required, e.g. mail({ provider: mailgun({ … }) })')
      }
      for (const m of REQUIRED_PROVIDER_METHODS) {
        if (typeof provider[m] !== 'function') {
          throw new Error(`mail(): provider "${provider.name || 'unknown'}" is missing required method ${m}()`)
        }
      }

      // Sub-module inits (outbox/inbox) read `config.mail`; give them a local
      // config with this plugin's options as the mail block so they stay unchanged.
      const config = { ...ctx.config, mail: mailConfig }

      // Resolve relative to cwd with a default (like voip's recordsFolder) so mkdir
      // never gets undefined when attachmentsFolder is omitted.
      const attachmentsFolder = path.resolve(process.cwd(), mailConfig.attachmentsFolder || 'mail-attachments')
      await mkdir(attachmentsFolder, { recursive: true })

      const { notify }  = createNotify({ webhooksConfig: mailConfig.webhooks, events, webhooks, eventRegistry })
      const authVerifier = resolveAuth(mailConfig.auth, { logger })
      if (!authVerifier) throw new Error('mail: auth (a secret or a composed verifier) is required')
      const requireAuth = authVerifier.middleware

      // Singleton modules: capture deps once via init(), in dependency order.
      // Leaf modules first (no cross-module deps), then modules that import them.
      attachments.init({ folder: attachmentsFolder, baseUrl: '/mail/attachments' })
      mailer.init({ provider, attachmentsFolder })
      suppressions.init({ db, logger })
      invalid.init({ db, logger })

      // Lazy lookup so plugin load order doesn't matter: the shortener may load
      // after mail. Returns its service (for personalized short links) or undefined.
      const getShortener = () => ctx.plugins?.shortener?.service
      outbox.init({ db, q, templates, passports, sessions, awareness, notify, config, logger, provider, getShortener })
      inbox.init({ config, db, q, passports, sessions, awareness, notify, logger, provider })
      tracking.init({ notify, awareness, logger, provider })
      bulk.init({ notify, logger, provider })

      logger.info('Mail provider: %s', provider.name || 'unknown')

      mountRoutes(app, { attachmentsFolder, requireAuth })
      registerMcp(ctx, { db })
      startStuckReaper(mailConfig, logger)

      logger.info('Mail plugin ready')

      // Exposed on ctx.plugins.mail for other plugins to send mail directly.
      // `send` (mailer.send) is provider-agnostic and UNGATED — no suppression/
      // invalid check, no outbox row — for transactional mail that
      // deliberately bypasses consent gating (server-plugin-oauth's invite
      // emails). `queueSend` (outbox.queueSend) is the gated, customer-facing
      // path — same create()+enqueue()+preflight-check pipeline the HTTP
      // /mail/outbox route uses. Callers sending to an actual customer
      // (e.g. journeys) must use queueSend, never send.
      return { service: { send: mailer.send, queueSend: outbox.queueSend, bulkSend: bulk.send, funnel: outbox.funnel, stats: outbox.stats, status: outbox.status } }
    },
  }
}
