// docs/10-plugin-status.md — the plugin describes its own health and the
// monitoring board holds no audiences knowledge.
//
// The number that justifies the card is `not delivering`: migration 011 dropped
// whitebox_audience_deliveries with the rule system, so an audience's `delivery`
// jsonb is the ONLY record of what activation was asked for — and setDelivery()
// stamps dry_run there when no eligible adapter is wired, which leaves delivery
// reading as ON while nothing reaches the ad network. Nothing else reports that.
import { describe, it, expect, vi } from 'vitest'
import knexFactory from 'knex'
import * as store from '../src/store.js'
import * as service from '../src/service.js'

// Real knex.raw() compiles the SQL so it can be inspected without a live
// database — genuine verification of the jsonb walk, not a hand-rolled fake.
const knex = knexFactory({ client: 'pg' })

describe('store.healthCounts — current state, one count per table', () => {
  function makeDb(rows = {}) {
    const captured = []
    const db = table => ({
      select: async (...raws) => { captured.push({ table, sql: raws.map(r => r.toString()).join(' | ') }); return [rows[table] ?? {}] },
    })
    db.raw = (sql, bindings) => knex.raw(sql, bindings)
    return { db, captured }
  }

  it('counts both tables and merges them into one answer', async () => {
    const { db } = makeDb({
      whitebox_audience_segments: { segments: 12 },
      whitebox_audiences: { audiences: 4 },
    })
    store.init({ db })
    expect(await store.healthCounts()).toEqual({ segments: 12, audiences: 4 })
  })

  // No created_at filter anywhere: "how many audiences are there" is not an
  // event that happened at a time.
  it('takes no window at all', async () => {
    const { db, captured } = makeDb()
    store.init({ db })
    await store.healthCounts()
    for (const { sql } of captured) expect(sql).not.toContain('created_at')
  })
})

describe('store.deliveryByNetwork — reading activation out of the delivery jsonb', () => {
  function makeRawDb(rows) {
    const captured = {}
    const db = () => ({})
    db.raw = async (sql) => { captured.sql = sql; return { rows } }
    return { db, captured }
  }

  it('groups enabled deliveries per network, counting the dry-run ones separately', async () => {
    const { db } = makeRawDb([
      { network: 'meta', enabled: '5', dry_run: '4' },
      { network: 'tiktok', enabled: '2', dry_run: '0' },
    ])
    store.init({ db })
    expect(await store.deliveryByNetwork()).toEqual([
      { network: 'meta', enabled: 5, dry_run: 4 },
      { network: 'tiktok', enabled: 2, dry_run: 0 },
    ])
  })

  it('counts only networks that are switched on', async () => {
    const { db, captured } = makeRawDb([])
    store.init({ db })
    await store.deliveryByNetwork()
    expect(captured.sql).toContain(`d.value->>'enabled' = 'true'`)
    expect(captured.sql).toContain(`d.value->>'dry_run' = 'true'`)
    expect(captured.sql).toContain('whitebox_audiences')
  })

  // jsonb_each() raises on a non-object, and a WHERE clause is evaluated after
  // the lateral — too late to prevent it. status() must not throw.
  it('normalises a null or non-object delivery inside the lateral, not in WHERE', async () => {
    const { db, captured } = makeRawDb([])
    store.init({ db })
    await store.deliveryByNetwork()
    expect(captured.sql).toContain(`CASE WHEN jsonb_typeof(a.delivery) = 'object'`)
    expect(captured.sql).toContain(`ELSE '{}'::jsonb END`)
  })

  it('returns an empty list when nothing is activated', async () => {
    const { db } = makeRawDb([])
    store.init({ db })
    expect(await store.deliveryByNetwork()).toEqual([])
  })
})

// Shape assertions here stay EXACT — they assert the absence of `severity` as much
// as its presence, which toMatchObject would stop checking. So the prose is dropped,
// not the strictness; that every metric HAS prose is its own test below.
const shape = (m) => { const { description, ...rest } = m || {}; return rest }

describe('service.status', () => {
  function setup({ counts = { segments: 12, audiences: 4 }, networks = [] } = {}) {
    const store = {
      healthCounts: vi.fn(async () => { if (counts instanceof Error) throw counts; return counts }),
      deliveryByNetwork: vi.fn(async () => { if (networks instanceof Error) throw networks; return networks }),
    }
    service.init({ store, evaluator: {}, adapters: [], identity: {}, consent: {}, passports: {}, logger: { warn: vi.fn() } })
    return store
  }
  const at = (s, key) => s.metrics.find(m => m.key === key)

  it('reports how much of the audience layer exists, and how much of it reaches a network', async () => {
    setup({ networks: [{ network: 'meta', enabled: 5, dry_run: 2 }, { network: 'tiktok', enabled: 2, dry_run: 0 }] })
    const s = await service.status({ since: new Date() })
    expect(s.label).toBe('audiences')
    // Totals first, then the per-network breakdown of those same totals.
    expect(s.metrics.map(m => m.key))
      .toEqual(['audiences', 'segments', 'delivering', 'not delivering', 'meta', 'tiktok'])
    expect(at(s, 'audiences').value).toBe(4)
    expect(at(s, 'segments').value).toBe(12)
    expect(at(s, 'delivering').value).toBe(5)        // (5-2) + (2-0)
    expect(at(s, 'not delivering').value).toBe(2)
  })

  // Nothing in audiences is windowed, so every metric must say so — otherwise the
  // board shows them under a window selector that doesn't govern them.
  it('marks every metric live, because none of them are windowed', async () => {
    setup({ networks: [{ network: 'meta', enabled: 5, dry_run: 2 }] })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.every(m => m.live === true)).toBe(true)
  })

  // Switched on, reaching nobody — the silent failure. Nothing else marks it.
  it('marks only `not delivering` bad', async () => {
    setup({ networks: [{ network: 'meta', enabled: 5, dry_run: 2 }] })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['not delivering'])
  })

  // Every number here is current state, so a `since` has nothing to window —
  // pretending otherwise would claim a measurement that was never made.
  it('ignores `since` entirely rather than pretending to window', async () => {
    const store = setup()
    await service.status({ since: new Date('2026-07-30T00:00:00.000Z') })
    expect(store.healthCounts).toHaveBeenCalledWith()
    expect(store.deliveryByNetwork).toHaveBeenCalledWith()
  })

  it('answers with no argument at all', async () => {
    setup()
    expect((await service.status()).label).toBe('audiences')
  })

  // These were `gauges`, a parallel array for bounded resources. Nothing here is a
  // bounded resource — no ceiling is consumed — and once the board stopped drawing
  // a track for gauges there was no reason for a second shape, so they are metrics
  // carrying `of`.
  describe('per-network breakdown — a ratio, because either number alone says nothing', () => {
    it('reports how many of an activated network\'s audiences actually reach it', async () => {
      setup({ networks: [{ network: 'meta', enabled: 5, dry_run: 2 }] })
      const s = await service.status({ since: new Date() })
      expect(shape(at(s, 'meta'))).toEqual({ key: 'meta', value: 3, of: 5, live: true })
    })

    // The severity trap this design has to avoid: "not one of meta's audiences gets
    // through" means value === 0, and `severity: 'bad'` fires on NON-zero. Marking
    // it bad here would be a signal that can never appear; `not delivering` is the
    // metric that goes non-zero in exactly this case, so that's where it lives.
    it('leaves a wholly dark network unmarked, and lets `not delivering` carry it', async () => {
      setup({ networks: [{ network: 'meta', enabled: 3, dry_run: 3 }, { network: 'google', enabled: 1, dry_run: 0 }] })
      const s = await service.status({ since: new Date() })
      expect(shape(at(s, 'meta'))).toEqual({ key: 'meta', value: 0, of: 3, live: true })
      expect(shape(at(s, 'google'))).toEqual({ key: 'google', value: 1, of: 1, live: true })
      expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['not delivering'])
      expect(at(s, 'not delivering').value).toBe(3)
    })

    it('adds no per-network rows when no audience is activated anywhere', async () => {
      setup({ networks: [] })
      const s = await service.status({ since: new Date() })
      expect(s.metrics.map(m => m.key)).toEqual(['audiences', 'segments', 'delivering', 'not delivering'])
    })

    // The array is gone from the contract, not merely unused.
    it('no longer returns a gauges array at all', async () => {
      setup({ networks: [{ network: 'meta', enabled: 5, dry_run: 2 }] })
      expect((await service.status({ since: new Date() })).gauges).toBeUndefined()
    })
  })

  describe('notes', () => {
    it('spells out the misconfiguration when an audience is activated with no eligible adapter', async () => {
      setup({ networks: [{ network: 'meta', enabled: 1, dry_run: 1 }] })
      expect((await service.status({ since: new Date() })).note)
        .toMatch(/1 activated audience has no eligible ad-network adapter/)
    })

    it('stays quiet when everything activated is getting through', async () => {
      setup({ networks: [{ network: 'meta', enabled: 2, dry_run: 0 }] })
      expect((await service.status({ since: new Date() })).note).toBeNull()
    })
  })

  // A failing status() must not take the board down, and must not report zeros:
  // zero means "there are none", which is a different claim from "no idea".
  describe('failure', () => {
    it('reports the half it got when one read fails', async () => {
      setup({ counts: new Error('db down'), networks: [{ network: 'meta', enabled: 1, dry_run: 0 }] })
      const s = await service.status({ since: new Date() })
      expect(s.metrics.map(m => m.key)).toEqual(['delivering', 'not delivering', 'meta'])
      expect(s.note).toMatch(/could not be read/)
    })

    it('does not throw when both reads fail', async () => {
      setup({ counts: new Error('db down'), networks: new Error('db down') })
      const s = await service.status({ since: new Date() })
      expect(s.metrics).toEqual([])
      expect(s.note).toMatch(/could not be read/)
    })
  })
})

describe('descriptions', () => {
  // Its own setup: the suite's `setup` helper is scoped inside describe('service.status').
  const init = (networks) => service.init({
    store: {
      healthCounts: vi.fn(async () => ({ segments: 12, audiences: 4 })),
      deliveryByNetwork: vi.fn(async () => networks),
    },
    evaluator: {}, adapters: [], identity: {}, consent: {}, passports: {}, logger: { warn: vi.fn() },
  })

  it('gives every metric a description that says more than the key', async () => {
    init([{ network: 'meta', enabled: 5, dry_run: 2 }])
    const s = await service.status({ since: new Date() })
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

  // The per-network rows are generated, so their prose has to be generated too —
  // a shared constant would say "of 5 audiences" on every network.
  it('names the network and its totals in the generated per-network prose', async () => {
    init([{ network: 'meta', enabled: 5, dry_run: 2 }, { network: 'tiktok', enabled: 2, dry_run: 0 }])
    const s = await service.status({ since: new Date() })
    const at = k => s.metrics.find(m => m.key === k).description
    expect(at('meta')).toContain('meta')
    expect(at('meta')).toContain('5')
    expect(at('tiktok')).toContain('tiktok')
    expect(at('meta')).not.toBe(at('tiktok'))
  })
})
