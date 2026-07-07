import { describe, it, expect, vi } from 'vitest'
import { geolocation } from '../src/index.js'

// The plugin's whole surface is the sessions.onResolve hook it registers — no
// REST route, no migration (geo becomes core facts, an existing table). Stub
// sessions.onResolve to capture the hook and call it directly, exactly like
// core would on a real /sessions/resolve.
function makeCtx({ lookupImpl, providerName = 'test-provider' } = {}) {
  let hook
  const facts = { record: vi.fn(async () => {}) }
  const sessions = { onResolve: vi.fn(fn => { hook = fn }) }
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const provider = { name: providerName, lookup: vi.fn(lookupImpl ?? (async () => null)) }
  return {
    ctx: { sessions, facts, logger },
    provider,
    callHook: (args) => hook(args),
  }
}

describe('geolocation() — provider contract', () => {
  it('throws without a provider', async () => {
    const { ctx } = makeCtx()
    await expect(geolocation({}).register({}, ctx)).rejects.toThrow(/provider is required/)
  })

  it('throws when the provider is missing lookup()', async () => {
    const { ctx } = makeCtx()
    await expect(geolocation({ provider: { name: 'bad' } }).register({}, ctx)).rejects.toThrow(/missing required method lookup/)
  })
})

describe('geolocation() — the sessions.onResolve hook', () => {
  it('registers exactly one hook on sessions.onResolve', async () => {
    const { ctx, provider } = makeCtx()
    await geolocation({ provider }).register({}, ctx)
    expect(ctx.sessions.onResolve).toHaveBeenCalledOnce()
  })

  it('looks up req.ip and returns { geo } on a hit', async () => {
    const { ctx, provider, callHook } = makeCtx({
      lookupImpl: async (ip) => (ip === '1.2.3.4' ? { country: 'BG', region: 'Sofia-grad', city: 'Sofia', lat: 42.6977, lon: 23.3219 } : null),
    })
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(result).toEqual({ geo: { country: 'BG', region: 'Sofia-grad', city: 'Sofia', lat: 42.6977, lon: 23.3219 } })
    expect(provider.lookup).toHaveBeenCalledWith('1.2.3.4')
  })

  it('returns null (no geo key) when the provider has no data for the IP', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => null })
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '9.9.9.9' } })
    expect(result).toBeNull()
  })

  it('returns null and logs a warning when the provider throws (never breaks resolve)', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => { throw new Error('mmdb read failed') } })
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(result).toBeNull()
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('returns null without attempting a lookup when req.ip is absent', async () => {
    const { ctx, provider, callHook } = makeCtx()
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: 'p-1', sessionId: 1, req: {} })
    expect(result).toBeNull()
    expect(provider.lookup).not.toHaveBeenCalled()
  })
})

describe('geolocation() — recordFacts (default on)', () => {
  const geo = { country: 'BG', region: 'Sofia-grad', city: 'Sofia', lat: 42.6977, lon: 23.3219 }

  it('records one fact per present geo field, tagged source: geolocation', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => geo })
    await geolocation({ provider }).register({}, ctx)
    await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })

    expect(ctx.facts.record).toHaveBeenCalledTimes(5)
    expect(ctx.facts.record).toHaveBeenCalledWith(expect.objectContaining({ passport_id: 'p-1', key: 'geo_country', value: 'BG', source: 'geolocation' }))
    expect(ctx.facts.record).toHaveBeenCalledWith(expect.objectContaining({ passport_id: 'p-1', key: 'geo_city', value: 'Sofia', source: 'geolocation' }))
    expect(ctx.facts.record).toHaveBeenCalledWith(expect.objectContaining({ passport_id: 'p-1', key: 'geo_lat', value: 42.6977 }))
  })

  it('skips fields the provider omitted', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => ({ country: 'BG', city: 'Sofia' }) })
    await geolocation({ provider }).register({}, ctx)
    await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(ctx.facts.record).toHaveBeenCalledTimes(2)
  })

  it('does not record facts when recordFacts: false', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => geo })
    await geolocation({ provider, recordFacts: false }).register({}, ctx)
    await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(ctx.facts.record).not.toHaveBeenCalled()
  })

  it('does not record facts when there is no passportId to attach them to', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => geo })
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: null, sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(result).toEqual({ geo })   // the lookup itself doesn't need a passport
    expect(ctx.facts.record).not.toHaveBeenCalled()
  })

  it('a failed facts.record does not throw or block the response', async () => {
    const { ctx, provider, callHook } = makeCtx({ lookupImpl: async () => geo })
    ctx.facts.record = vi.fn(async () => { throw new Error('db down') })
    await geolocation({ provider }).register({}, ctx)
    const result = await callHook({ passportId: 'p-1', sessionId: 1, req: { ip: '1.2.3.4' } })
    expect(result).toEqual({ geo })
  })
})

describe('geolocation() — defensive when core sessions.onResolve is unavailable', () => {
  it('warns and does not throw', async () => {
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const ctx = { sessions: {}, facts: { record: vi.fn() }, logger }
    await expect(geolocation({ provider: { name: 'p', lookup: async () => null } }).register({}, ctx)).resolves.not.toThrow()
    expect(logger.warn).toHaveBeenCalled()
  })
})
