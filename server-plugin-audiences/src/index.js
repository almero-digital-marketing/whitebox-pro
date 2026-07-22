// whitebox-pro-server-plugin-audiences
//
// AI audience plugin: segments (chart-derived dynamic sub-queries) compose
// into audiences (boolean AND/OR/NOT of segments), which sync to Meta, TikTok
// and Google (GA4) so the platforms build the audience. Management over REST + MCP.
//
// Plugin contract (see whitebox-pro-server/src/plugins.js):
//   - migrate(db)        run our knex migrations
//   - register(app, ctx) wire routes + MCP tools
//
// Full docs: ./docs

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.js'
import * as evaluator from './evaluator.js'
import * as identity from './identity.js'
import * as consent from './consent.js'
import * as service from './service.js'
import * as rest from './rest.js'
import * as mcpTools from './mcp.js'
import { resolveReadWriteAuth } from 'whitebox-pro-server/auth'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: audiences({ networks, auth: { secret }, privacy, evaluation }).
export function audiences(options = {}) {
  return {
    name: 'audiences',

    permissions: {
      items: [
        { key: 'audiences:read', label: 'View Audiences', description: 'View audience segments and delivery status' },
        { key: 'audiences:write', label: 'Edit Audiences', description: 'Create and deliver audience segments' },
      ],
      defaults: [],
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_audience_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const cfg = options
      const { logger } = ctx
      const { read: readAuth, write: writeAuth } = resolveReadWriteAuth(cfg.auth, { logger })
      if (!readAuth || !writeAuth) throw new Error('audiences: auth (a secret, a composed verifier, or { read, write }) is required')

      // --- wire the singletons (init() + free functions, like the core) ---
      store.init({ db: ctx.db })
      identity.init({ db: ctx.db, passports: ctx.passports })
      consent.init({ db: ctx.db, passports: ctx.passports, config: cfg.privacy })

      // Composed network descriptors — [ meta({…}), tiktok({…}) ]. (enabled:false
      // or an ineligible entry is simply skipped by delivery/manifest.)
      const adapters = cfg.networks || []

      // The selector engine owns all selection now — the evaluator is a thin
      // adapter over ctx.selector. ai names segments/audiences; db is for
      // fact-key discovery (distinct keys from core facts).
      evaluator.init({
        selector: ctx.selector,
        ai: ctx.ai,
        db: ctx.db,
        facts: ctx.facts,
        logger,
      })

      service.init({ store, evaluator, adapters, identity, consent, logger })

      // seed the built-in "Everyone" segment (idempotent) — the universal building block
      service.ensureDefaultSegments().catch(err => logger.warn({ err }, 'audiences: ensureDefaultSegments failed'))

      // --- REST (privileged management tier) ---
      rest.register(app, { service, requireRead: readAuth.middleware, requireWrite: writeAuth.middleware })

      // --- MCP tools (behind config.mcp.auth.secret) ---
      mcpTools.register(ctx.mcp, { service, logger })

      // --- identity manifest onto the session-resolve response (decoupled) ---
      // The client capture shim reads this to know what to collect. See docs/06.
      if (ctx.sessions?.onResolve) {
        ctx.sessions.onResolve(() => ({ ad_identity_manifest: identity.manifest(adapters) }))
      }

      logger.info('Audiences plugin ready (%d networks)', adapters.length)

      return { service }   // exposed on ctx.plugins.audiences for other plugins/tests
    },
  }
}
