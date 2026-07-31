// whitebox-pro-server-plugin-campaigns
//
// Plan & execute email/SMS campaigns to audiences. Mikser upserts campaign content from outside
// (by external_id); the UI attaches audiences (many-to-many) and schedules. Executing locks the
// campaign with real stats; a sent campaign can spawn an Analytics performance report.
//
// Delivery: when a scheduled campaign comes due it is handed to the host-wired `deliver` hook,
// which calls the mail / sms plugins for the channel. `dryRun` (whitebox config; DEFAULT ON) is
// the safety switch — it records the projected reach as "sent" WITHOUT actually sending, so a
// misconfigured or half-built campaign can't blast real inboxes. Flip campaigns.dryRun=false in
// the config to go live; it can be changed at any time.
//
// Plugin contract (see whitebox-pro-server/src/plugins.js):
//   - migrate(db)        run our knex migrations
//   - register(app, ctx) wire routes; reuse the audiences plugin's service for resolution+consent
//
// Reuses ctx.plugins.audiences.service (resolveAudience, previewCohort, deliverableCohort), passed
// in by the host. Register the audiences plugin BEFORE campaigns.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.js'
import * as service from './service.js'
import { makeDeliver } from './deliver.js'
import * as rest from './rest.js'
import * as mcpTools from './mcp.js'
import { resolveReadWriteAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: campaigns({ auth: { secret }, audiences, dryRun, deliver, mail, sms }).
//   audiences — the audiences plugin's service (default: ctx.plugins.audiences.service)
//   dryRun    — record-but-don't-send safety switch (default TRUE; set false in config to go live)
//   deliver   — async ({ campaign, channel, subject, message, passportIds }) => { batch_id? }
//               the host wires this to the mail/sms plugins; only called for a LIVE (non-dry) send.
//   mail/sms  — plugin services (default: ctx.plugins.<name>.service), used ONLY by
//               activateForPassport() — the per-customer send path, called directly rather than
//               through the `deliver` hook (which is bulk-oriented). Register mail/sms before
//               campaigns for the fallback to resolve.
export function campaigns(options = {}) {
  return {
    name: 'campaigns',

    // What our events mean (see server/src/event-catalog.js). Both `internal`,
    // including `campaigns.sent` — which is the one worth explaining. A campaign
    // never delivers anything itself: it hands the send to mail or sms, and THEY
    // emit the outbound events, one per message. Classifying this as `out` too
    // would count the same send twice and make the outbound number a figure
    // nobody can reconcile against the outbox.
    //
    // This is what `internal` is for: orchestration that touched nobody outside.
    events: {
      'campaigns.activated': 'internal',
      'campaigns.sent': 'internal',
    },

    permissions: {
      items: [
        { key: 'campaigns:read', label: 'View Campaigns', description: 'View campaigns and their delivery status' },
        { key: 'campaigns:write', label: 'Edit Campaigns', description: 'Create, schedule, and send email/SMS campaigns' },
      ],
      defaults: [],
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_campaign_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const cfg = options
      const { logger } = ctx
      const { read: readAuth, write: writeAuth } = resolveReadWriteAuth(cfg.auth, { logger })
      if (!readAuth || !writeAuth) throw new Error('campaigns: auth (a secret, a composed verifier, or { read, write }) is required')
      // HARD dependency, not a warning: a campaign's whole job is delivering to
      // an audience, and every send path goes through audiences' resolution +
      // consent (service.js never re-implements either). Warning here and
      // failing later meant a campaign you could build, save and schedule but
      // never send — and a Campaigns icon in the UI backed by nothing. Refusing
      // to register keeps campaigns:* out of the permission catalog, which is
      // what hides that icon (see oauth's expandPermissions).
      // mail/sms stay warnings below: those only gate activateForPassport, so
      // the rest of the module is still genuinely usable without them.
      const audiences = options.audiences || ctx.plugins?.audiences?.service
      if (!audiences) {
        throw new Error('campaigns: the audiences plugin is required (register it before campaigns, or pass `audiences` explicitly) — every campaign resolves its recipients through it')
      }
      const mail = options.mail || ctx.plugins?.mail?.service
      const sms = options.sms || ctx.plugins?.sms?.service
      if (!mail) logger.warn('campaigns: mail service not wired — activateForPassport on an email campaign will fail (register mail first)')
      if (!sms) logger.warn('campaigns: sms service not wired — activateForPassport on an sms campaign will fail (register sms first)')

      // Safety default: dry-run unless the config EXPLICITLY turns it off.
      const dryRun = options.dryRun !== false
      // The hook is an OVERRIDE now, not a requirement: without one, bulk goes
      // through the built-in mapping onto the channel plugins' own bulk send.
      // Previously an unwired hook meant "send this campaign to this audience"
      // threw at run time while every other path worked — a hole, not a seam.
      const deliver = options.deliver || makeDeliver({ mail, sms, passports: ctx.passports, logger })

      const { notify } = createNotify({ webhooksConfig: options.webhooks, events: ctx.events, webhooks: ctx.webhooks, eventRegistry: ctx.eventRegistry })

      store.init({ db: ctx.db })
      service.init({ store, audiences, dryRun, deliver, mail, sms, passports: ctx.passports, logger, notify })

      rest.register(app, { service, requireRead: readAuth.middleware, requireWrite: writeAuth.middleware })
      if (ctx.mcp) mcpTools.register(ctx.mcp, { service, logger })

      logger.info(`Campaigns plugin ready (delivery: ${dryRun ? 'dry-run' : 'live'})`)
      return { service }   // exposed for other plugins/tests
    },
  }
}
