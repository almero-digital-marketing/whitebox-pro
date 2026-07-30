import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import * as store from '../src/store.js'
import { conversions } from '../src/index.js'

// No DB. The two health queries are structurally different — the per-network one
// expands `networks` through a CROSS JOIN LATERAL, the totals one doesn't — so the
// fake builder answers on that: a chain that saw joinRaw() resolves to the
// (network, verdict) rows, anything else to the single totals row. Each awaited
// chain is kept in db.seen so a test can assert HOW it was built (the window, the
// consent-key exclusion) without a server to run the SQL.
function makeDb({ totals = { events: 0, consent_skipped: 0 }, networkRows = [], fails = () => false } = {}) {
  const seen = []

  function db() {
    const state = { joined: false, wheres: [], raws: [], groups: [] }
    const chain = {
      joinRaw(sql) { state.joined = true; state.join = sql; return chain },
      whereRaw(sql) { state.raws.push(sql); return chain },
      where(...args) { state.wheres.push(args); return chain },
      select(...args) { state.selected = args; return chain },
      count(alias) { state.counted = alias; return chain },
      groupBy(...cols) { state.groups.push(...cols); return chain },
      // Knex builders are thenables; awaiting one runs it.
      then(resolve, reject) {
        seen.push(state)
        return (async () => {
          if (fails(state)) throw new Error('relation does not exist')
          return state.joined ? networkRows : [totals]
        })().then(resolve, reject)
      },
    }
    return chain
  }

  db.raw = sql => ({ sql })
  db.seen = seen
  return db
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function setup(opts) {
  const db = makeDb(opts)
  store.init({ db, logger })
  return db
}

// Shape assertions here stay EXACT — they assert the absence of `severity` as much
// as its presence, which toMatchObject would stop checking. So the prose is dropped,
// not the strictness; that every metric HAS prose is its own test below.
const shape = (m) => { const { description, ...rest } = m || {}; return rest }

describe('conversions store.status', () => {
  it('names its own numbers and marks only the failures bad', async () => {
    setup({
      totals: { events: 20, consent_skipped: 3 },
      networkRows: [
        { network: 'meta', verdict: 'accepted', calls: 15 },
        { network: 'meta', verdict: 'rejected', calls: 2 },
        { network: 'google', verdict: 'accepted', calls: 17 },
        { network: 'tiktok', verdict: 'error', calls: 1 },
        { network: 'tiktok', verdict: 'skipped', calls: 16 },
      ],
    })

    const s = await store.status({ since: new Date('2026-07-30T00:00:00Z') })

    expect(s.label).toBe('conversions')
    expect(s.metrics.map(shape)).toEqual([
      { key: 'events', value: 20 },
      { key: 'accepted', value: 32 },
      { key: 'rejected', value: 2, severity: 'bad' },
      { key: 'errors', value: 1, severity: 'bad' },
      { key: 'skipped', value: 16 },
      { key: 'consent withheld', value: 3 },
    ])
    // Only rejected/errors are bad — skipped and consent-withheld are the system
    // doing what it was told.
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['rejected', 'errors'])
  })

  it('names the failing networks first in the note — "2 rejected" alone is not actionable', async () => {
    setup({
      totals: { events: 9, consent_skipped: 0 },
      networkRows: [
        { network: 'google', verdict: 'accepted', calls: 9 },
        { network: 'meta', verdict: 'accepted', calls: 7 },
        { network: 'meta', verdict: 'rejected', calls: 2 },
      ],
    })
    const s = await store.status({})
    expect(s.note).toBe('meta 7 accepted, 2 rejected · google 9 accepted')
  })

  it('still shows a verdict a future adapter invents', async () => {
    setup({ totals: { events: 1, consent_skipped: 0 }, networkRows: [{ network: 'meta', verdict: 'throttled', calls: 4 }] })
    const s = await store.status({})
    expect(s.note).toBe('meta 4 throttled')
    // Unknown verdicts don't land in accepted/rejected/errors.
    expect(s.metrics.find(m => m.key === 'rejected').value).toBe(0)
  })

  it('windows both queries on received_at', async () => {
    const since = new Date('2026-07-01T00:00:00Z')
    const db = setup()
    await store.status({ since })
    expect(db.seen).toHaveLength(2)
    for (const q of db.seen) expect(q.wheres).toEqual([['received_at', '>=', since]])
  })

  it('accepts a since string as well as a Date', async () => {
    const db = setup()
    await store.status({ since: '2026-07-01T00:00:00Z' })
    for (const q of db.seen) expect(q.wheres[0][2]).toEqual(new Date('2026-07-01T00:00:00Z'))
  })

  it('excludes the consent pseudo-key from the per-network tally', async () => {
    // `{ skipped: 'consent' }` is a whole-event verdict, not a network named
    // "skipped" — it's counted once by the totals query and filtered out of the
    // lateral, or every consent-gated event would invent a network.
    const db = setup({ totals: { events: 4, consent_skipped: 4 } })
    const s = await store.status({})
    const lateral = db.seen.find(q => q.joined)
    expect(lateral.join).toMatch(/jsonb_each_text\(networks\)/)
    expect(lateral.raws.join()).toMatch(/net\.network <> 'skipped'/)
    expect(s.metrics.find(m => m.key === 'consent withheld').value).toBe(4)
    expect(s.metrics.find(m => m.key === 'skipped').value).toBe(0)
  })

  it('reports zeros and no note when nothing has arrived', async () => {
    setup()
    const s = await store.status({ since: new Date() })
    expect(s.metrics.map(m => m.value)).toEqual([0, 0, 0, 0, 0, 0])
    expect(s.note).toBeNull()
  })

  it('never throws — a failing query degrades to partial data and says so', async () => {
    setup({ totals: { events: 5, consent_skipped: 0 }, fails: q => q.joined })
    const s = await store.status({})
    expect(s.metrics.find(m => m.key === 'events').value).toBe(5)   // the half that worked
    expect(s.note).toBe('per-network verdicts unavailable — the numbers above are incomplete')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('survives both queries failing rather than taking the board down', async () => {
    setup({ fails: () => true })
    const s = await store.status({})
    expect(s.metrics.map(m => m.value)).toEqual([0, 0, 0, 0, 0, 0])
    expect(s.note).toMatch(/event totals and per-network verdicts unavailable/)
  })
})

describe('conversions register — service.status', () => {
  it('exposes status() on the service so monitoring surfaces discover it', async () => {
    const ctx = {
      db: makeDb(),
      passports: { identities: vi.fn(async () => []) },
      awareness: { record: vi.fn() },
      logger,
    }
    const api = await conversions({}).register(express(), ctx)
    expect(typeof api.service.status).toBe('function')
    expect(api).toHaveProperty('reporter')      // pre-existing surface is untouched
    const s = await api.service.status({ since: new Date() })
    expect(s.label).toBe('conversions')
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md) — the guard that
// stops the next metric shipping as a bare key.
describe('descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    setup()
    const s = await store.status({ since: new Date('2026-07-30T00:00:00Z') })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) expect(m.description.length).toBeGreaterThan(m.key.length + 20)
  })
})
