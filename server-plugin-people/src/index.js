// whitebox-pro-server-plugin-people
//
// The people browser: look a person up, see everything held about them, fix a
// wrong identity, merge duplicates, and honour a right-to-be-forgotten erasure.
//
// OWNS NO TABLES and has no migrations. A person already exists as a core
// primitive — `whitebox_passports` plus the identities and facts hanging off
// it. What was missing was never storage, it was the query that assembles
// those joins and a surface over it. Everything here reads and writes through
// ctx.passports / ctx.facts / ctx.awareness.
//
// Why a plugin and not core: core is deliberately domain-neutral
// infrastructure, and — concretely — the permission catalog is aggregated from
// registered PLUGINS (server/src/plugins.js), so a browser mounted in core
// would have no key for the UI's module gate to read.
//
// Plugin contract (see whitebox-pro-server/src/plugins.js):
//   - register(app, ctx)  wire routes/MCP tools over core's primitives.
//                         journeys and audiences are OPTIONAL — register them
//                         first to get enrollments and suppression status on
//                         the detail view; without them those sections are
//                         simply omitted.

import * as service from './service.js'
import * as rest from './rest.js'
import * as mcpTools from './mcp.js'
import { resolveAuth, resolveReadWriteAuth } from 'whitebox-pro-server/auth'

// Factory: people({ auth: { read, write, erase }, journeys, audiences }).
//   auth   — the usual read/write split, PLUS an optional third `erase`
//            verifier. Erasure is deliberately its own authority: a support
//            role that needs to correct an email is not automatically a role
//            that may delete someone forever. Omitted → falls back to the
//            write verifier, so an existing two-scope config keeps working.
//   journeys/audiences — plugin services (default: ctx.plugins.<name>.service),
//            both optional.
export function people(options = {}) {
  return {
    name: 'people',

    permissions: {
      items: [
        { key: 'people:read', label: 'View People', description: 'Search people and view their identities, facts and history' },
        { key: 'people:write', label: 'Edit People', description: 'Link and unlink identities, record facts, and merge duplicate people' },
        { key: 'people:erase', label: 'Erase People', description: 'Permanently delete a person and all their data (right to be forgotten)' },
      ],
      defaults: [],
    },

    async register(app, ctx) {
      const { logger } = ctx
      const { read: readAuth, write: writeAuth } = resolveReadWriteAuth(options.auth, { logger })
      if (!readAuth || !writeAuth) throw new Error('people: auth (a secret, a composed verifier, or { read, write }) is required')
      // erase falls back to write rather than to read — if a deployment hasn't
      // thought about it yet, the safer of the two defaults is the stricter one
      const eraseAuth = resolveAuth(options.auth?.erase, { logger }) || writeAuth

      if (!ctx.passports) throw new Error('people: ctx.passports is required')
      if (!ctx.facts) throw new Error('people: ctx.facts is required')

      const journeys = options.journeys || ctx.plugins?.journeys?.service
      const audiences = options.audiences || ctx.plugins?.audiences?.service
      if (!journeys) logger.info('people: journeys not registered — the profile will omit journey enrollments')
      if (!audiences) logger.info('people: audiences not registered — the profile will omit suppression status')

      service.init({
        passports: ctx.passports,
        facts: ctx.facts,
        awareness: ctx.awareness,
        // Core's own sessions, for the visit count on a person — see the note at
        // historyFor(). Not optional in practice (core always has it), but read
        // from ctx the same way as the rest.
        sessions: ctx.sessions,
        journeys,
        audiences,
        logger,
      })

      rest.register(app, {
        service,
        requireRead: readAuth.middleware,
        requireWrite: writeAuth.middleware,
        requireErase: eraseAuth.middleware,
      })
      if (ctx.mcp) mcpTools.register(ctx.mcp, { service, logger })

      logger.info('People plugin ready')
      return { service }
    },
  }
}

export default people
