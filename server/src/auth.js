import crypto from 'crypto'

// Static shared-secret Bearer middleware (the default). Kept as the default
// export so `import createAuth from 'whitebox-pro-server/auth'` is unchanged.
export function createAuth({ secret, logger }) {
  if (!secret) {
    throw new Error('auth secret is required')
  }

  const expected = Buffer.from(secret, 'utf8')

  return function requireAuth(req, res, next) {
    const header = req.get('authorization') || ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) {
      logger?.warn?.({ reqId: req.id }, 'Missing bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const presented = Buffer.from(match[1], 'utf8')
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      logger?.warn?.({ reqId: req.id }, 'Invalid bearer auth')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    next()
  }
}

export default createAuth

// ── pluggable auth seam ─────────────────────────────────────────────────────
//
// An auth "verifier" is a provider-agnostic descriptor:
//   { middleware, authorizationServers?, resource?, scopesSupported? }
// The static secret is one verifier (`bearer`); external packages (e.g.
// whitebox-pro-auth-auth0) ship others. Nothing here is provider-specific.

// The static-secret verifier.
export const bearer = (opts) => ({ middleware: createAuth(opts) })

// Normalize a plugin's (or MCP's) `auth` option into a verifier (or null —
// "no auth configured"). Accepts:
//   undefined / null          → no auth
//   string                    → bearer secret
//   (req,res,next) => {}        → a bare middleware
//   { middleware, … }          → an already-composed verifier (auth0(), jwt(), …)
//   { secret }                 → bearer secret (legacy shape)
// Nothing here is MCP-specific — any plugin's REST auth can accept the same
// shapes (e.g. analytics({ auth: auth0({ … }) })). What "no auth" MEANS is the
// caller's call: MCP allows omitting it (dev only); most plugin REST surfaces
// treat a null result as "refuse to boot" — check resolveAuth()'s result.
export function resolveAuth(authConfig, { logger } = {}) {
  if (!authConfig) return null
  if (typeof authConfig === 'string') return { middleware: createAuth({ secret: authConfig, logger }) }
  if (typeof authConfig === 'function') return { middleware: authConfig }
  if (typeof authConfig.middleware === 'function') return authConfig
  if (authConfig.secret) return { middleware: createAuth({ secret: authConfig.secret, logger }) }
  return null
}

// Read/write split for plugins whose REST surface has a meaningful read vs
// write distinction (e.g. analytics/audiences/campaigns, gated by their own
// `:read`/`:write` permission catalog entries — see server/src/plugins.js).
// Accepts EITHER shape:
//   auth: <anything resolveAuth takes>       — legacy: one verifier for BOTH
//                                               read and write (a static
//                                               secret has no natural split).
//   auth: { read: <…>, write: <…> }          — independently resolved verifiers.
// Detected by presence of a `read`/`write` key — resolveAuth's own accepted
// shapes never use those keys, so there's no ambiguity between the two.
export function resolveReadWriteAuth(authConfig, { logger } = {}) {
  if (authConfig && (authConfig.read !== undefined || authConfig.write !== undefined)) {
    return { read: resolveAuth(authConfig.read, { logger }), write: resolveAuth(authConfig.write, { logger }) }
  }
  const shared = resolveAuth(authConfig, { logger })
  return { read: shared, write: shared }
}
