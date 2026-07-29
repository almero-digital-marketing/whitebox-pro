// Ad signals moved from one jsonb blob per passport to one row per signal
// (migration 013). The contract that had to survive that is
// identity.resolve()'s output shape — adapters consume `signals` as a flat
// { name: value } object, and none of them should be able to tell the storage
// changed underneath.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as store from '../src/store.js'
import * as identity from '../src/identity.js'

// A knex-lookalike for one table. Records what was inserted/merged so the
// upsert semantics can be asserted without a database.
function makeDb(rows = []) {
  const state = { rows: [...rows], lastInsert: null, lastMerge: null }
  const api = {
    where: vi.fn(function (cond) { this._where = cond; return this }),
    select: vi.fn(async function () {
      const { passport_id } = this._where || {}
      return state.rows.filter(r => r.passport_id === passport_id)
    }),
    insert: vi.fn(function (payload) { state.lastInsert = payload; return this }),
    onConflict: vi.fn(function (cols) { state.lastConflict = cols; return this }),
    merge: vi.fn(async function (patch) { state.lastMerge = patch; return 1 }),
  }
  const db = vi.fn(() => Object.create(api))
  db.raw = vi.fn(v => ({ __raw: v }))
  db.fn = { now: () => '__now' }
  return { db, state }
}

describe('store.getSignals — the shape adapters depend on', () => {
  it('reassembles rows into the flat { name: value } object the old blob held', async () => {
    const { db } = makeDb([
      { passport_id: 'p1', name: 'fbp', value: 'fb.1.2.3' },
      { passport_id: 'p1', name: 'gclid', value: 'Cj0KC' },
      { passport_id: 'p2', name: 'ttclid', value: 'other-person' },
    ])
    store.init({ db })
    expect(await store.getSignals('p1')).toEqual({ fbp: 'fb.1.2.3', gclid: 'Cj0KC' })
  })

  it('returns {} for a passport with no signals — never null', async () => {
    const { db } = makeDb()
    store.init({ db })
    expect(await store.getSignals('nobody')).toEqual({})
  })
})

describe('store.saveSignals — per-key upsert', () => {
  beforeEach(() => { /* fresh db per test below */ })

  it('writes one row per key and upserts on (passport_id, name)', async () => {
    const { db, state } = makeDb()
    store.init({ db })
    await store.saveSignals('p1', { fbp: 'a', gclid: 'b' })
    expect(state.lastInsert).toEqual([
      { passport_id: 'p1', name: 'fbp', value: 'a' },
      { passport_id: 'p1', name: 'gclid', value: 'b' },
    ])
    // the whole point of the reshape: one signal updates one row, not a blob
    expect(state.lastConflict).toEqual(['passport_id', 'name'])
    expect(state.lastMerge).toHaveProperty('last_seen_at')
  })

  it('drops empty, null and object values rather than storing them', async () => {
    const { db, state } = makeDb()
    store.init({ db })
    await store.saveSignals('p1', { good: 'x', empty: '', nothing: null, nested: { a: 1 } })
    expect(state.lastInsert).toEqual([{ passport_id: 'p1', name: 'good', value: 'x' }])
  })

  it('does not touch the table when there is nothing worth writing', async () => {
    const { db, state } = makeDb()
    store.init({ db })
    await store.saveSignals('p1', {})
    expect(state.lastInsert).toBeNull()
  })

  it('coerces a scalar to text — the column is a string', async () => {
    const { db, state } = makeDb()
    store.init({ db })
    await store.saveSignals('p1', { count: 42 })
    expect(state.lastInsert).toEqual([{ passport_id: 'p1', name: 'count', value: '42' }])
  })
})

describe('identity.resolve — the adapter contract across the migration', () => {
  it('still returns hashed PII plus a flat signals object', async () => {
    const { db } = makeDb([{ passport_id: 'p1', name: 'fbp', value: 'fb.1.2.3' }])
    store.init({ db })
    identity.init({
      passports: {
        identities: async () => [
          { type: 'email', value: 'a@b.com' },
          { type: 'phone', value: '+15550001111' },
        ],
      },
    })
    const out = await identity.resolve('p1')
    expect(Object.keys(out).sort()).toEqual(['email_sha256', 'external_id', 'phone_sha256', 'signals'])
    expect(out.signals).toEqual({ fbp: 'fb.1.2.3' })
    // no external_id identity → falls back to the passport id, unchanged behaviour
    expect(out.external_id).toBe('p1')
    expect(out.email_sha256).toEqual(expect.any(String))
  })
})
