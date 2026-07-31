// whitebox-pro-server-plugin-journeys
//
// Multi-step, trigger-driven customer automation — a thin orchestration
// layer over plugins that already exist. It never reimplements sending,
// targeting, or consent/suppression logic — a journey step doesn't carry
// its own message content; `trigger_campaign` triggers a Campaign (which
// owns the channel/message and calls mail/sms's gated `queueSend`
// internally via its own activateForPassport()). Journeys stays completely
// unaware of any external business semantics: a webhook step fires one
// pure, one-way, objective-fact notification and never waits for or reacts
// to anything the receiver does with it.
//
// Plugin contract (see whitebox-pro-server/src/plugins.js):
//   - migrate(db)        run our knex migrations
//   - register(app, ctx) wire routes/MCP tools; reuse campaigns/audiences'
//                        services plus core selector/facts/webhooks/events/
//                        queue/lock, passed in by the host.
//                        Register campaigns and audiences BEFORE journeys.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.js'
import * as service from './service.js'
import * as executor from './executor.js'
import * as triggers from './triggers.js'
import * as rest from './rest.js'
import * as mcpTools from './mcp.js'
import { resolveReadWriteAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: journeys({ auth: {read, write}, campaigns, audiences, webhookSecret,
//   debounceMs, sweepIntervalMs, webhooks: {enrolled, completed, exited} }).
//   campaigns/audiences — plugin services (default: ctx.plugins.<name>.service)
//   webhookSecret      — default HMAC secret for per-step webhook signing (a
//                        step's own config.secret overrides it)
//   debounceMs         — audience-trigger fast-path debounce window (default 5s)
//   sweepIntervalMs    — audience-trigger full-sweep interval (default 15 min)
//   webhooks           — plugin-LEVEL lifecycle notify config (enrolled/
//                        completed/exited), separate from per-step webhooks —
//                        same createNotify() shape mail/sms/awareness use.
export function journeys(options = {}) {
  return {
    name: 'journeys',

    // What our events mean (see server/src/event-catalog.js). Note the types are
    // `journey.*` SINGULAR while the plugin is named `journeys` — live carried a
    // defensive `'journeys.'` alias for years that could never match anything,
    // and offered `journey` as a channel filter option as a result.
    //
    // All three are `internal`, and this is the case `internal` exists for: an
    // enrollment is not traffic. Nobody outside was touched — a journey STEP that
    // sends something delegates to mail/sms, which emit their own outbound event.
    // Counting an enrollment as either direction inflates a number an operator is
    // using to judge whether the system is talking to anyone at all.
    //
    // `journey.step.webhook` is deliberately not here: it is a webhook PAYLOAD
    // type (executor.js), never passed to notify(), so it never reaches the event
    // log and declaring it would describe an event that doesn't exist.
    events: {
      'journey.enrolled': 'internal',
      'journey.completed': 'internal',
      'journey.exited': 'internal',
    },

    // What one of our events was ABOUT, for a feed row.
    //
    // Every journey row used to show a BLANK detail column, and had done since
    // the feed existed. live described journeys, campaigns and audiences with one
    // shared branch reading `name || title || slug || id` — and our payloads carry
    // none of those four. They carry `journey_id`, so even the `id` fallback
    // missed. Nobody could see it: the branch looked perfectly reasonable, and it
    // was in a different package from the payload it was guessing at.
    //
    // Fixed on both sides: enrolled and completed now carry `journey_name` (free
    // — the journey was already loaded at both call sites), and this falls back to
    // a short id for `exited`, which is a manual API/MCP path with no journey
    // loaded and not worth an extra query for a label.
    detail: {
      'journey.': (d) => {
        const which = d.journey_name || (d.journey_id ? `#${String(d.journey_id).slice(0, 8)}` : null)
        if (which && d.reason) return `${which} — ${d.reason}`
        return which || d.reason || null
      },
    },

    permissions: {
      items: [
        { key: 'journeys:read', label: 'View Journeys', description: 'View journeys, their steps, and enrollment status' },
        { key: 'journeys:write', label: 'Edit Journeys', description: 'Create, activate, and enroll passports into journeys' },
      ],
      defaults: [],
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_journey_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const cfg = options
      const { logger } = ctx
      const { read: readAuth, write: writeAuth } = resolveReadWriteAuth(cfg.auth, { logger })
      if (!readAuth || !writeAuth) throw new Error('journeys: auth (a secret, a composed verifier, or { read, write }) is required')

      const campaigns = options.campaigns || ctx.plugins?.campaigns?.service
      const audiences = options.audiences || ctx.plugins?.audiences?.service
      // Read-only, and only for results: journeys never sends through these
      // (that's campaigns' job) — it asks them what they did on its behalf,
      // using the journey_id their outboxes now carry. Absent ⇒ the results
      // simply omit delivery.
      const mail = options.mail || ctx.plugins?.mail?.service
      const sms = options.sms || ctx.plugins?.sms?.service
      if (!campaigns) logger.warn('journeys: campaigns service not wired — trigger_campaign steps will fail (register campaigns first)')
      if (!audiences) logger.warn('journeys: audiences service not wired — audience triggers and audience-branch steps will fail (register audiences first)')

      store.init({ db: ctx.db })

      const { notify: notifyLifecycle } = createNotify({ webhooksConfig: options.webhooks, events: ctx.events, webhooks: ctx.webhooks, eventRegistry: ctx.eventRegistry })

      triggers.init({ store, events: ctx.events, service, audiences, logger, debounceMs: options.debounceMs, sweepIntervalMs: options.sweepIntervalMs })
      triggers.initQueue(ctx.queue)

      executor.init({ store, campaigns, audiences, selector: ctx.selector, facts: ctx.facts, webhooks: ctx.webhooks, logger, notifyLifecycle, webhookSecret: options.webhookSecret })
      executor.initQueue(ctx.queue)

      // onTriggerChange fires after anything that could change the active set of
      // event/audience triggers (activate/pause/patch/delete) — keeps the Redis
      // subscription set in sync without a restart.
      service.init({ store, lock: ctx.lock, logger, notifyLifecycle, mail, sms, onTriggerChange: () => triggers.refresh().catch(err => logger.error({ err }, 'journeys: trigger refresh failed')) })

      await triggers.refresh()
      await triggers.startSweep()

      rest.register(app, { service, requireRead: readAuth.middleware, requireWrite: writeAuth.middleware })
      if (ctx.mcp) mcpTools.register(ctx.mcp, { service, logger })

      logger.info('Journeys plugin ready')
      return { service }   // exposed for other plugins/tests
    },
  }
}
