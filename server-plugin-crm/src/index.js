import path from 'path'
import { fileURLToPath } from 'url'

import { resolveAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'
import * as state from './state.js'
import * as ingest from './ingest.js'

import { mountRoutes, observeSchema } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: crm({ auth: { secret: process.env.WB_CRM_TOKEN } }) in whitebox.config.js.
//
// CRM is now a thin adapter: structured records land in the core *facts* memory
// (queryable by the selector as `filter.fact`), free-text notes land in awareness.
// It owns no store of its own — the migration only drops its retired records table.
export function crm(options = {}) {
  return {
    name: 'crm',

    // What our events mean (see server/src/event-catalog.js). A PREFIX, not a
    // list, and that is the honest declaration here: we emit `crm.${kind}` where
    // the kind is whatever record type the host system pushes (booking, deal,
    // client, subscription, …). There is no closed set to enumerate — the
    // vocabulary belongs to the CRM on the other side, not to us.
    //
    // Inbound in every case: a push from an external system is the outside world
    // telling us something happened, which is the same thing a reply is.
    events: {
      'crm.': 'in',
    },

    // What one of our events was ABOUT, for a feed row. The record's own
    // identifiers, because that is what lets an operator find it in the system
    // that pushed it.
    detail: {
      'crm.': (d) => [d.kind, d.external_id, d.status].filter(Boolean).join(' · ') || d.source || null,
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_crm_migrations',
      })
    },

    async register(app, ctx) {
      const { db, connect, passports, facts, awareness, context, events, webhooks, eventRegistry, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'crm' })
      const crmConfig = options

      const authVerifier = resolveAuth(crmConfig.auth, { logger })
      if (!authVerifier) throw new Error('crm: auth (a secret or a composed verifier) is required')
      const requireAuth = authVerifier.middleware

      // Singleton modules: capture deps once, in dependency order. ingest reaches
      // state directly via `import * as state`; state writes structured records
      // into core facts. Only non-module values come through init.
      const { notify } = createNotify({ webhooksConfig: crmConfig.webhooks, events, webhooks, eventRegistry })

      // `db` is passed for the health card only: CRM writes exclusively through
      // ctx.facts / ctx.awareness, but neither exposes a windowed count, so
      // status() reads those two core tables back directly (as analytics does).
      state.init({ facts, logger, notify, db })
      ingest.init({ passports, awareness, logger, db })

      mountRoutes(app, { requireAuth, state, ingest, logger })
      registerMcp(ctx, { state, ingest })

      // Client-reported observations arrive over the socket (whitebox-pro-client-plugin-crm).
      // Identity is the connection's passport — the trusted, handshake-bound one —
      // so the client can't report for someone else over the socket.
      connect?.onMessage(async ({ connectionId, event, data }) => {
        if (event !== 'crm.observe') return
        const visitor = connect.find(connectionId)
        if (!visitor?.passportId) return
        const parsed = observeSchema.safeParse(data)
        if (!parsed.success) { logger.warn({ err: parsed.error }, 'crm.observe validation failed'); return }
        await ingest.ingestObservations({ passport_id: visitor.passportId, observations: parsed.data.observations })
          .catch(err => logger.warn({ err }, 'crm.observe ingest failed'))
      })

      // Structured state flows into analytics' `/ask` via the generic context
      // registry. It now lives in core facts, so this surfaces the passport's
      // current facts ({ key: value }) as that customer's structured context.
      // (Free-text notes already live in awareness and surface via recall.)
      context?.register?.('crm', async (passportId) => {
        const current = await state.current(passportId)
        return Object.entries(current).map(([key, value]) => ({ key, value }))
      })

      logger.info('CRM plugin ready (facts adapter)')

      // `service.status` is the self-describing health form monitoring surfaces
      // discover (docs/10-plugin-status.md) — nothing has to be told this plugin
      // exists. `state` and `ingest` stay exposed as they were.
      return { state, ingest, service: { status: ingest.status } }
    },
  }
}
