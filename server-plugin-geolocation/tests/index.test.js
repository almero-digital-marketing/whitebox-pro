import { describe, it, expect, vi } from 'vitest'
import { geolocation } from '../src/index.js'

// The plugin's whole surface is the sessions.onResolve hook it registers — no
// REST route, no migration (geo becomes core facts, an existing table). Stub
// sessions.onResolve to capture the hook and call it directly, exactly like
// core would on a real /sessions/resolve.
function makeCtx({ lookupImpl, providerName = 'test-provider', healthImpl } = {}) {
  let hook
  const facts = { record: vi.fn(async () => {}), describe: vi.fn() }
  const sessions = { onResolve: vi.fn(fn => { hook = fn }) }
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const provider = { name: providerName, lookup: vi.fn(lookupImpl ?? (async () => null)) }
  // health() is optional in the provider contract — only attached when a test
  // wants to exercise the database-age half of status().
  if (healthImpl) provider.health = vi.fn(healthImpl)
  return {
    ctx: { sessions, facts, logger },
    provider,
    callHook: (args) => hook(args),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
// A loaded, watched, freshly-updated database — the healthy baseline.
const freshDb = (over = {}) => () => ({
  provider: 'maxmind', dbPath: '/db/GeoLite2-City.mmdb',
  loaded: true, loadedAt: Date.now(), mtimeMs: Date.now() - 2 * DAY_MS, watching: true,
  ...over,
})
const metric = (s, key) => s.metrics.find(m => m.key === key)

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

describe('geolocation() — registers default fact labels', () => {
  it('describes all 5 geo_* keys with a human label when recordFacts is on (default)', async () => {
    const { ctx, provider } = makeCtx()
    await geolocation({ provider }).register({}, ctx)
    expect(ctx.facts.describe).toHaveBeenCalledWith('geo_country', 'Country')
    expect(ctx.facts.describe).toHaveBeenCalledWith('geo_region', 'Region')
    expect(ctx.facts.describe).toHaveBeenCalledWith('geo_city', 'City')
    expect(ctx.facts.describe).toHaveBeenCalledWith('geo_lat', 'Latitude')
    expect(ctx.facts.describe).toHaveBeenCalledWith('geo_lon', 'Longitude')
  })

  it('skips registering labels when recordFacts: false — nothing to label', async () => {
    const { ctx, provider } = makeCtx()
    await geolocation({ provider, recordFacts: false }).register({}, ctx)
    expect(ctx.facts.describe).not.toHaveBeenCalled()
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
    const ctx = { sessions: {}, facts: { record: vi.fn(), describe: vi.fn() }, logger }
    await expect(geolocation({ provider: { name: 'p', lookup: async () => null } }).register({}, ctx)).resolves.not.toThrow()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('still exposes status() — a plugin that reports nothing is absent from the board, which reads as unmonitored', async () => {
    const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const ctx = { sessions: {}, facts: { record: vi.fn(), describe: vi.fn() }, logger }
    const api = await geolocation({ provider: { name: 'p', lookup: async () => null } }).register({}, ctx)
    expect(typeof api.service.status).toBe('function')
  })
})

// The monitoring contract — docs/10-plugin-status.md. This plugin owns no tables,
// so status() reports live process/file state and nothing is windowed by `since`.
describe('geolocation() — status()', () => {
  const geo = { country: 'BG', city: 'Sofia' }

  it('register() returns { service: { status } } so the board can discover it', async () => {
    const { ctx, provider } = makeCtx()
    const api = await geolocation({ provider }).register({}, ctx)
    expect(typeof api.service.status).toBe('function')
  })

  it('counts lookups, no-data misses and failures from the resolve hook', async () => {
    let mode = 'hit'
    const { ctx, provider, callHook } = makeCtx({
      lookupImpl: async () => {
        if (mode === 'hit') return geo
        if (mode === 'miss') return null
        throw new Error('mmdb corrupt')
      },
    })
    const api = await geolocation({ provider }).register({}, ctx)

    await callHook({ passportId: 'p-1', req: { ip: '1.2.3.4' } })
    mode = 'miss'
    await callHook({ passportId: 'p-1', req: { ip: '10.0.0.1' } })
    await callHook({ passportId: 'p-1', req: { ip: '10.0.0.2' } })
    mode = 'boom'
    await callHook({ passportId: 'p-1', req: { ip: '9.9.9.9' } })
    await callHook({ passportId: 'p-1', req: {} })   // no ip — never attempted, so not counted

    const s = await api.service.status({ since: new Date() })
    expect(s.label).toBe('geolocation')
    expect(metric(s, 'lookups').value).toBe(4)
    expect(metric(s, 'no data').value).toBe(2)
    expect(metric(s, 'failed').value).toBe(1)
  })

  it('counters start from zero on each register()', async () => {
    const { ctx, provider } = makeCtx({ lookupImpl: async () => geo })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(metric(s, 'lookups').value).toBe(0)
  })

  it('marks a failed lookup as bad, and no-data as ordinary — a private IP is not a fault', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb() })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['failed', 'stale database'])
    expect(metric(s, 'no data').severity).toBeUndefined()
    expect(metric(s, 'lookups').severity).toBeUndefined()
  })

  it('reports the database file age and a clean bill of health when it is fresh', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb() })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(metric(s, 'database age (days)').value).toBe(2)
    expect(metric(s, 'stale database').value).toBe(0)
    expect(s.note).toBeNull()
  })

  // This plugin owns no tables. The three counters are process-lifetime totals in
  // memory and the database facts are read off the file now, so NOTHING here can be
  // windowed — and every metric has to say so, or the board shows the lot under a
  // window selector that doesn't govern any of it.
  // Every counter must say what it counts (docs/10-plugin-status.md) — the guard
  // that stops the next metric shipping as a bare key.
  it('gives every metric a description that says more than the key', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb() })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) {
      // Rendered inline in a 340px pane, so length is still the constraint — but
      // written for the person USING the system, not for whoever built it, which
      // needs a few more words than a terse engineering label.
      expect(m.description.length).toBeLessThanOrEqual(72)
      // ...and it must still say more than the key already does.
      expect(m.description.toLowerCase()).not.toBe(m.key.toLowerCase())
      expect(m.description.length).toBeGreaterThan(12)
    }
  })

  // `no data` is normal and `failed` is not — two adjacent zero-ish counters whose
  // difference an operator has to know before either number means anything.
  it('tells "no data" apart from "failed" in words', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb() })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    const at = k => s.metrics.find(m => m.key === k).description
    expect(at('no data')).toMatch(/could not be found/i)
    expect(at('failed')).toMatch(/broke|no location/i)
  })

  it('marks every metric live, since it has no history to window', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb() })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({ since: new Date('2026-07-30T00:00:00.000Z') })
    expect(s.metrics.length).toBeGreaterThan(3)
    expect(s.metrics.filter(m => !m.live)).toEqual([])
  })

  it('flags a stale database — the silent-degradation case this card exists for', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb({ mtimeMs: Date.now() - 400 * DAY_MS }) })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(metric(s, 'database age (days)').value).toBe(400)
    expect(metric(s, 'stale database')).toMatchObject({ value: 1, severity: 'bad' })
    expect(s.note).toMatch(/400 days old/)
    expect(s.note).toMatch(/geoipupdate/)
  })

  it('honours a custom staleAfterDays', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb({ mtimeMs: Date.now() - 3 * DAY_MS }) })
    const api = await geolocation({ provider, staleAfterDays: 2 }).register({}, ctx)
    const s = await api.service.status({})
    expect(metric(s, 'stale database').value).toBe(1)
  })

  it('notes an unwatched file — geoipupdate can swap it without the provider noticing', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: freshDb({ watching: false }) })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(s.note).toMatch(/not watched/)
    expect(metric(s, 'stale database').value).toBe(0)   // unwatched is a warning, not staleness
  })

  it('distinguishes "not read yet" (lazy open, no lookups) from "never loaded" (every lookup failed)', async () => {
    const notLoaded = { provider: 'maxmind', dbPath: '/db/x.mmdb', loaded: false, loadedAt: null, mtimeMs: null, watching: true }
    const a = makeCtx({ healthImpl: () => notLoaded })
    const apiA = await geolocation({ provider: a.provider }).register({}, a.ctx)
    expect((await apiA.service.status({})).note).toMatch(/not read yet/)

    const b = makeCtx({ healthImpl: () => notLoaded, lookupImpl: async () => { throw new Error('ENOENT') } })
    const apiB = await geolocation({ provider: b.provider }).register({}, b.ctx)
    await b.callHook({ passportId: 'p-1', req: { ip: '1.2.3.4' } })
    const s = await apiB.service.status({})
    expect(s.note).toMatch(/never loaded/)
    expect(metric(s, 'failed').value).toBe(1)
    expect(metric(s, 'database age (days)')).toBeUndefined()   // no mtime — nothing honest to report
  })

  it('says so when the provider cannot describe its data source at all', async () => {
    const { ctx, provider } = makeCtx()   // no health()
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(s.note).toMatch(/does not report database health/)
    expect(s.metrics.map(m => m.key)).toEqual(['lookups', 'no data', 'failed'])
  })

  it('never throws when the provider health() blows up — the board stays up', async () => {
    const { ctx, provider } = makeCtx({ healthImpl: () => { throw new Error('stat wedged') } })
    const api = await geolocation({ provider }).register({}, ctx)
    const s = await api.service.status({})
    expect(metric(s, 'lookups').value).toBe(0)
    expect(s.note).toMatch(/does not report database health/)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})
