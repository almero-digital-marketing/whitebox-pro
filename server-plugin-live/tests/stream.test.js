import { describe, it, expect, vi } from 'vitest'
import { authorize } from '../src/stream.js'

// This whole file exists because of one incident: the handshake adapter built a
// fake `req` with only `headers`, the real verifier called Express's
// `req.get()`, and the resulting rejection — from an ASYNC middleware, so
// invisible to a synchronous try/catch — crashed the entire API every time a
// dashboard opened its socket. A monitoring plugin taking down the system it
// monitors is the worst possible failure, so each mode is pinned here.
describe('authorize() — the socket handshake adapter', () => {
  it('gives the verifier a req it can actually read, Express accessors included', async () => {
    const seen = {}
    const middleware = (req, _res, next) => {
      seen.viaGet = req.get('authorization')
      seen.viaHeader = req.header('Authorization')   // case-insensitive, like Express
      seen.viaHeaders = req.headers.authorization
      next()
    }
    await expect(authorize(middleware, 'tok123')).resolves.toBeTruthy()
    expect(seen.viaGet).toBe('Bearer tok123')
    expect(seen.viaHeader).toBe('Bearer tok123')
    expect(seen.viaHeaders).toBe('Bearer tok123')
  })

  // the exact crash: async throw → rejected promise → invisible to try/catch
  it('rejects rather than escaping when an ASYNC verifier throws', async () => {
    const middleware = async () => { throw new TypeError('req.get is not a function') }
    await expect(authorize(middleware, 'tok')).rejects.toThrow(/req\.get/)
  })

  it('rejects when a synchronous verifier throws', async () => {
    const middleware = () => { throw new Error('boom') }
    await expect(authorize(middleware, 'tok')).rejects.toThrow('boom')
  })

  it('treats next(err) as a denial', async () => {
    await expect(authorize((_q, _s, next) => next(new Error('bad token')), 'tok')).rejects.toThrow('bad token')
  })

  // a verifier that answers the request instead of calling next() has rejected it
  it('treats any attempt to respond as a denial', async () => {
    const middleware = (_req, res) => res.status(401).json({ error: 'nope' })
    await expect(authorize(middleware, 'tok')).rejects.toThrow('unauthorized')
  })

  it('refuses a missing token without troubling the verifier', async () => {
    const middleware = vi.fn()
    await expect(authorize(middleware, undefined)).rejects.toThrow('unauthorized')
    expect(middleware).not.toHaveBeenCalled()
  })
})
