import { describe, it, expect, vi } from 'vitest'
import * as query from '../../src/query/index.js'

// The QUERY surface FAILS CLOSED.
//
// It used to read `config.query.auth.secret` directly and, finding nothing, mount
// `(req,res,next) => next()` behind a single startup warning. Two ways to reach that, and
// neither looked like a mistake:
//
//   · `auth: { secret: process.env.WB_QUERY_TOKEN }` with the variable unset or mistyped
//     — the shape the gpoint deployment actually uses.
//   · `auth: 'a-secret-token'` — the string shape the docs teach for every OTHER surface.
//     `.secret` on a string is undefined, so a config that READS as configured mounted the
//     whole surface open.
//
// What was open: POST /query is arbitrary selector access over every customer, and /ask
// spends model budget. That is not comparable to the cost of a failed boot, so the original
// reasoning — an always-on core surface must not fail boot — was the wrong way round.
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const app = { post: () => {}, get: () => {} }
const register = (queryConfig) =>
  query.register(app, { selector: {}, ai: {}, mcp: null, logger, config: queryConfig ? { query: queryConfig } : {} })

describe('query surface auth', () => {
  it('refuses to boot with no auth configured', () => {
    expect(() => register(undefined)).toThrow(/config\.query\.auth is required/)
    expect(() => register({})).toThrow(/config\.query\.auth is required/)
  })

  it('refuses to boot when the env var behind it is unset', () => {
    // The live shape, one missing variable away from an open surface.
    expect(() => register({ auth: { secret: process.env.DEFINITELY_NOT_SET_12345 } }))
      .toThrow(/resolves to no verifier/)
    expect(() => register({ auth: { secret: '' } })).toThrow(/config\.query\.auth is required/)
  })

  it('says WHY and WHAT to do, not just that it refused', () => {
    const err = (() => { try { register(undefined) } catch (e) { return e } })()
    expect(err.message).toMatch(/arbitrary selector access over every customer/)
    expect(err.message).toMatch(/jwt\(\{ issuer, audience, scope \}\)/)
    expect(err.message).toMatch(/query: \{ auth: false \}/)      // the deliberate opt-out
  })

  it('accepts a bare STRING, which used to silently disable auth', () => {
    // The regression that mattered most: this is the shape documented everywhere else, and
    // reading `.secret` off it yields undefined.
    expect(() => register({ auth: 'a-secret-token' })).not.toThrow()
  })

  it('accepts every shape the rest of core accepts', () => {
    expect(() => register({ auth: { secret: 'a-secret-token' } })).not.toThrow()
    expect(() => register({ auth: (req, res, next) => next() })).not.toThrow()
    // A composed verifier — jwt()/auth0(). /query was the one surface that could not take one.
    expect(() => register({ auth: { middleware: (req, res, next) => next() } })).not.toThrow()
  })

  it('allows running open only when SAID deliberately, and says so loudly', () => {
    const warn = vi.fn()
    const noisy = { child: () => ({ debug() {}, info() {}, warn, error() {} }) }
    expect(() => query.register(app, {
      selector: {}, ai: {}, mcp: null, logger: noisy, config: { query: { auth: false } },
    })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WITHOUT auth by explicit config/))
    expect(warn.mock.calls[0][0]).toMatch(/open to anyone who can reach this port/)
  })

  it('actually gates the routes it mounts', () => {
    // Not just "did it boot" — the middleware handed to the routes must be the verifier's.
    const mine = (req, res, next) => next()
    const mounted = []
    query.register({ post: (path, mw) => mounted.push([path, mw]), get: () => {} },
      { selector: {}, ai: {}, mcp: null, logger, config: { query: { auth: mine } } })
    expect(mounted.length).toBeGreaterThan(0)
    for (const [, mw] of mounted) expect(mw).toBe(mine)
  })
})
