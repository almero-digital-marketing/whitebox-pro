import { resolveAuth } from '../auth.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

// The core QUERY surface — REST (/query, /preview) + MCP (whitebox.query,
// whitebox.preview) over the selector engine. Mounted by server.js right after
// the engine is ready, so the query API is a first-class core capability (no
// plugin in the path). See docs/selector.md §13.
//
// AUTH FAILS CLOSED. This used to read `config.query.auth.secret` directly and, when it
// found nothing, mount `(req,res,next) => next()` behind one startup warning. Two ways to
// reach that state, and neither looked like a mistake:
//
//   · `auth: { secret: process.env.WB_QUERY_TOKEN }` with the variable unset or
//     mistyped — the shape this deployment actually uses.
//   · `auth: 'a-secret-token'` — the string shape the docs teach for every OTHER
//     surface. `.secret` on a string is undefined, so a config that reads as
//     configured mounted the whole surface open.
//
// What was open: an unauthenticated POST /query is arbitrary selector access over the
// entire customer base, plus /ask, which spends model budget. The cost of that is not
// comparable to the cost of a failed boot, so the trade the old comment made — "QUERY is
// an always-on core surface, so a missing secret can't be allowed to fail boot" — was the
// wrong way round. A surface that cannot authenticate should not answer.
//
// Running without auth is still possible, because local development needs it — but only
// by SAYING SO: `query: { auth: false }`. The dangerous state is now unreachable by
// omission or by typo, which is the only property that matters here.
const OPEN = (req, res, next) => next()

export function register(app, { selector, ai, mcp, config = {}, logger }) {
  const log = logger.child({ component: 'query' })
  const declared = config.query?.auth
  // resolveAuth accepts every shape the rest of core does — a string, { secret },
  // a bare middleware, or a composed verifier (jwt()/auth0()) — so /query is no longer
  // the one surface that only understands a static token.
  const verifier = resolveAuth(declared, { logger: log })

  if (!verifier && declared !== false) {
    throw new Error(
      'config.query.auth is required — POST /query is arbitrary selector access over every ' +
      'customer, and /ask spends model budget. Set it to a secret string, { secret }, a ' +
      'middleware, or a composed verifier such as jwt({ issuer, audience, scope }). ' +
      (declared === undefined
        ? 'It is currently absent.'
        : `It was given as ${JSON.stringify(declared)}, which resolves to no verifier — ` +
          'the usual cause is an env var that is unset or misspelled.') +
      ' To run without auth deliberately (development only), set `query: { auth: false }`.')
  }
  if (!verifier) {
    log.warn('Query surface mounted WITHOUT auth by explicit config (query.auth = false) — ' +
             '/query, /preview, /ask and /funnel are open to anyone who can reach this port')
  }
  const requireAuth = verifier ? verifier.middleware : OPEN

  mountRoutes(app, {
    requireAuth, selector, ai, logger: log,
    queryPath:   config.query?.path        ?? '/query',
    previewPath: config.query?.previewPath ?? '/preview',
    askPath:     config.query?.askPath     ?? '/ask',
    funnelPath:  config.query?.funnelPath  ?? '/funnel',
  })
  registerMcp({ mcp }, { selector })

  log.info('Query surface ready (REST + MCP)')
}
