import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReadWriteAuth } from 'whitebox-pro-server/auth'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import * as compositionStore from './composition/store.js'
import * as compose from './composition/compose.js'
import { mountComposition } from './composition/routes.js'
import { registerMcp as registerCompositionMcp } from './composition/mcp.js'

// Factory: import { analytics } from 'whitebox-pro-server-plugin-analytics' and call
// it with options in whitebox.config.js — analytics({ auth: { secret } }).
//
// Two surfaces:
//   - the original query/recall over awareness (recall · population · ask · …)
//   - the COMPOSITION layer (docs/analytics-concept.md): reports + widgets over the
//     core selector engine, the backend for the three-pane analytics console.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function analytics(options = {}) {
  return {
    name: 'analytics',

    // Basic Analytics access is a sane default for any teammate — unlike
    // Audiences/Campaigns, asking questions and viewing reports isn't
    // something that needs an admin's explicit opt-in. Both keys default on:
    // even `:write` covers routes like /compose (the "just ask" flow creates
    // a report) that were already available to everyone under the old single
    // analytics:use scope — this split adds the ABILITY to restrict a given
    // teammate to view-only later, without narrowing anyone's access today.
    permissions: {
      items: [
        { key: 'analytics:read', label: 'View Analytics', description: 'View reports and ask grounded questions' },
        { key: 'analytics:write', label: 'Edit Analytics', description: 'Create and edit reports and widgets' },
      ],
      defaults: ['analytics:read', 'analytics:write'],
    },

    // Own state: whitebox_reports / whitebox_widgets (the composition surface).
    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_analytics_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const { awareness, context, selector, ai, db, connect, passports, facts, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'analytics' })
      const analyticsConfig = options

      // auth accepts a bare secret string, { secret }, a composed verifier like
      // auth0({ … }), or { read, write } to gate the two independently — see
      // whitebox-pro-server/auth's resolveReadWriteAuth(). A legacy single
      // value (or a bare `{secret}`) resolves to the SAME verifier for both,
      // matching pre-split behavior exactly.
      const { read: readAuth, write: writeAuth } = resolveReadWriteAuth(analyticsConfig.auth, { logger })
      if (!readAuth || !writeAuth) throw new Error('analytics: auth (a secret, a composed verifier, or { read, write }) is required')
      const requireRead = readAuth.middleware
      const requireWrite = writeAuth.middleware

      // Original awareness query/recall conveniences (unchanged).
      mountRoutes(app, { requireRead, requireWrite, awareness, context, logger })
      registerMcp(ctx, { awareness, context })

      // Composition surface — reports/widgets/resolve/compose over the core
      // selector + AI. Guarded: db + selector are absent in some unit tests.
      if (db && selector) {
        compositionStore.init({ db, connect })   // store broadcasts every mutation → all clients live
        compose.init({ db, ai, selector, awareness, facts, logger })
        mountComposition(app, { requireRead, requireWrite, selector, awareness, passports, logger })
        registerCompositionMcp(ctx, { selector, awareness, passports, logger })
        logger.info('Analytics composition surface ready (reports · resolve · compose)')
      } else {
        logger.warn('Analytics composition surface skipped (no db/selector in ctx)')
      }

      logger.info('Analytics plugin ready')
    },
  }
}
