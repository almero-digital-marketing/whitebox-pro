import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'

// Real Postgres (a Neon branch provisioned by tests/setup/neon.js), same as
// passports.test.js — facts uses DISTINCT ON + jsonb, so we test against pg.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })

// passport-merge stub: resolve(absorbed) → survivor
let mergeMap = {}
const passports = { resolve: async id => mergeMap[id] ?? id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

const d = s => new Date(s)

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()                      // creates whitebox_facts in the branch
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  mergeMap = {}
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })   // facts FK → whitebox_passports
  return id
}

describe('facts.record + current', () => {
  it('records a fact and reads it back as the current value', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', source: 'stripe', observed_at: d('2026-04-10') })
    expect(await facts.current(p)).toEqual({ plan_tier: 'pro' })
    expect(await facts.get(p, 'plan_tier')).toBe('pro')
  })

  it('a value change is a new row; current returns the latest per key', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'free', source: 'stripe', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'mrr', value: 0, source: 'stripe', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', source: 'stripe', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, source: 'stripe', observed_at: d('2026-04-10') })
    expect(await facts.current(p)).toEqual({ plan_tier: 'pro', mrr: 240 })
  })

  it('current can be filtered to specific keys', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, observed_at: d('2026-04-10') })
    expect(await facts.current(p, 'mrr')).toEqual({ mrr: 240 })
    expect(await facts.current(p, ['plan_tier'])).toEqual({ plan_tier: 'pro' })
  })
})

describe('facts.recordMany (bulk)', () => {
  it('lands the same fact on every passport in one statement', async () => {
    const ps = [await newPassport(), await newPassport(), await newPassport()]
    const rows = await facts.recordMany({ passport_ids: ps, key: 'segment', value: 'vip', source: 'people' })
    expect(rows).toHaveLength(3)
    for (const p of ps) expect(await facts.current(p)).toEqual({ segment: 'vip' })
  })

  // one act, one timestamp — per-row clocks would order a single bulk write
  // arbitrarily against itself
  it('stamps the whole batch with one observed_at', async () => {
    const ps = [await newPassport(), await newPassport()]
    const rows = await facts.recordMany({ passport_ids: ps, key: 'segment', value: 'vip' })
    expect(new Set(rows.map(r => +r.observed_at)).size).toBe(1)
  })

  // the same merge resolution record() does — a row on a tombstone is invisible
  it('resolves merged ids and writes the survivor once, not twice', async () => {
    const survivor = await newPassport()
    const absorbed = await newPassport()
    mergeMap[absorbed] = survivor
    const rows = await facts.recordMany({ passport_ids: [survivor, absorbed], key: 'segment', value: 'vip' })
    // two ids in, ONE row out: they are the same person
    expect(rows).toHaveLength(1)
    expect(rows[0].passport_id).toBe(survivor)
  })

  it('infers types per value, the same way record() does', async () => {
    const ps = [await newPassport(), await newPassport()]
    await facts.recordMany({ passport_ids: ps, key: 'mrr', value: 240 })
    expect(await facts.current(ps[0])).toEqual({ mrr: 240 })
    expect(await facts.get(ps[1], 'mrr')).toBe(240)
  })

  it('is a no-op on an empty id list and validates like record()', async () => {
    expect(await facts.recordMany({ passport_ids: [], key: 'k', value: 'v' })).toEqual([])
    await expect(facts.recordMany({ passport_ids: ['x'], value: 'v' })).rejects.toThrow(/key is required/)
    await expect(facts.recordMany({ passport_ids: ['x'], key: 'k' })).rejects.toThrow(/value is required/)
  })
})

describe('facts.usedKeys', () => {
  // there is no fixed fact vocabulary, so the keys in use ARE the vocabulary
  it('returns every key in use, deduped and sorted, across all passports', async () => {
    const [a, b] = [await newPassport(), await newPassport()]
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro' })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'free' })
    await facts.record({ passport_id: b, key: 'mrr', value: 10 })
    expect(await facts.usedKeys()).toEqual(['mrr', 'plan_tier'])
  })

  it('is empty before anything is recorded', async () => {
    expect(await facts.usedKeys()).toEqual([])
  })
})

describe('facts.asOf (time travel)', () => {
  it('returns the value as it stood at a past instant', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'free', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.asOf(p, '2026-03-15')).toEqual({ plan_tier: 'free' })
    expect(await facts.asOf(p, '2026-05-01')).toEqual({ plan_tier: 'pro' })
    expect(await facts.get(p, 'plan_tier', { at: '2026-03-15' })).toBe('free')
  })

  it('a key with no row before the instant is absent', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.asOf(p, '2026-04-01')).toEqual({})
  })
})

describe('facts type inference + round-trip', () => {
  it('infers number / bool / date / string and round-trips the value', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'mrr', value: 240 })
    await facts.record({ passport_id: p, key: 'active', value: true })
    await facts.record({ passport_id: p, key: 'renewal_date', value: '2026-07-01' })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro' })
    expect(await facts.current(p)).toEqual({ mrr: 240, active: true, renewal_date: '2026-07-01', plan_tier: 'pro' })
    expect((await facts.history(p, 'mrr'))[0].type).toBe('number')
    expect((await facts.history(p, 'renewal_date'))[0].type).toBe('date')
  })
})

describe('facts.history', () => {
  it('returns the full timeline of a key, oldest first', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'mrr', value: 0, observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 560, observed_at: d('2026-05-20') })
    expect((await facts.history(p, 'mrr')).map(h => h.value)).toEqual([0, 240, 560])
  })
})

describe('passport merge resolution', () => {
  it('writes + reads under the survivor when the id was merged away', async () => {
    const survivor = await newPassport()
    const absorbed = crypto.randomUUID()          // merged away — no row of its own
    mergeMap[absorbed] = survivor
    await facts.record({ passport_id: absorbed, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.current(survivor)).toEqual({ plan_tier: 'pro' })   // stored under survivor
    expect(await facts.current(absorbed)).toEqual({ plan_tier: 'pro' })   // read resolves too
  })
})

describe('facts.matches (population) + facts.test (per-passport)', () => {
  it('value op: who currently matches, per-passport test', async () => {
    const a = await newPassport(); const b = await newPassport(); const c = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: c, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(new Set(await facts.matches('plan_tier', { eq: 'pro' }))).toEqual(new Set([a, c]))
    expect(await facts.test(a, 'plan_tier', { eq: 'pro' })).toBe(true)
    expect(await facts.test(b, 'plan_tier', { eq: 'pro' })).toBe(false)
  })

  it('value op honors scope and as-of', async () => {
    const a = await newPassport(); const b = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'free', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'pro', observed_at: d('2026-02-01') })
    expect(new Set(await facts.matches('plan_tier', { eq: 'pro' }))).toEqual(new Set([a, b]))   // now: both
    expect(await facts.matches('plan_tier', { eq: 'pro' }, { scope: [a] })).toEqual([a])
    expect(await facts.matches('plan_tier', { eq: 'pro' }, { at: '2026-03-15' })).toEqual([b])  // a was 'free' then
  })

  it('temporal op: transition into a state within a window', async () => {
    const a = await newPassport(); const b = await newPassport()
    await facts.record({ passport_id: a, key: 'subscription_status', value: 'active', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: a, key: 'subscription_status', value: 'cancelled', observed_at: d('2026-06-15') })
    await facts.record({ passport_id: b, key: 'subscription_status', value: 'active', observed_at: d('2026-04-10') })
    const pred = { transition: { to: 'cancelled', last: '90d' } }
    expect(await facts.matches('subscription_status', pred, { at: '2026-06-20' })).toEqual([a])
    expect(await facts.test(a, 'subscription_status', pred, { at: '2026-06-20' })).toBe(true)
    expect(await facts.test(b, 'subscription_status', pred, { at: '2026-06-20' })).toBe(false)
  })
})

describe('validation', () => {
  it('throws on missing passport_id / key / value', async () => {
    await expect(facts.record({ key: 'k', value: 1 })).rejects.toThrow(/passport_id/)
    await expect(facts.record({ passport_id: 'p', value: 1 })).rejects.toThrow(/key/)
    await expect(facts.record({ passport_id: 'p', key: 'k' })).rejects.toThrow(/value/)
  })
})

describe('facts.describe / label — human labels for fact keys', () => {
  it('label() falls back to the raw key when nothing is registered', () => {
    facts.init({ db, passports, logger })
    expect(facts.label('geo_city')).toBe('geo_city')
  })

  it('describe() registers a label that label() then returns', () => {
    facts.init({ db, passports, logger })
    facts.describe('geo_city', 'City')
    expect(facts.label('geo_city')).toBe('City')
  })

  it('a later describe() for the same key is a no-op — first write wins', () => {
    facts.init({ db, passports, logger })
    facts.describe('geo_city', 'City')
    facts.describe('geo_city', 'Town')   // e.g. a second plugin describing the same key
    expect(facts.label('geo_city')).toBe('City')
  })

  it('config-seeded labels (init deps.config.facts.labels) win over a plugin default', () => {
    facts.init({ db, passports, logger, config: { facts: { labels: { geo_city: 'Location' } } } })
    facts.describe('geo_city', 'City')   // a plugin's default, registered after boot
    expect(facts.label('geo_city')).toBe('Location')
  })

  it('describedKeys() lists every registered { key, label } pair', () => {
    facts.init({ db, passports, logger, config: { facts: { labels: { geo_city: 'City' } } } })
    facts.describe('geo_region', 'Region')
    expect(facts.describedKeys()).toEqual(
      expect.arrayContaining([{ key: 'geo_city', label: 'City' }, { key: 'geo_region', label: 'Region' }])
    )
  })

  it('init() resets the registry — a fresh boot has no labels until re-registered', () => {
    facts.init({ db, passports, logger, config: { facts: { labels: { geo_city: 'City' } } } })
    facts.init({ db, passports, logger })   // simulate a reboot with no config labels
    expect(facts.label('geo_city')).toBe('geo_city')
  })
})

// The complement of recordMany: many DIFFERENT facts in one statement. Exists
// because the shape it serves — an external system pushing a customer's whole
// structured state — had no bulk path, and the CRM adapter was doing a round
// trip per field. That measured 7.5 customers/minute on the gpoint import.
describe('facts.recordBatch (many keys, one statement)', () => {
  it('writes every fact and reads back as current state', async () => {
    const p = await newPassport()
    const rows = await facts.recordBatch([
      { passport_id: p, key: 'plan_tier', value: 'pro', source: 'crm' },
      { passport_id: p, key: 'mrr', value: 240, source: 'crm' },
      { passport_id: p, key: 'seats', value: 3, source: 'crm' },
    ])
    expect(rows).toHaveLength(3)
    expect(await facts.current(p)).toEqual({ plan_tier: 'pro', mrr: 240, seats: 3 })
  })

  // Unlike recordMany, these are NOT one act: a booking from 2023 and a total
  // computed today belong at their own instants, and collapsing them would
  // flatten the history the temporal operators read.
  it('keeps a per-row observed_at', async () => {
    const p = await newPassport()
    const rows = await facts.recordBatch([
      { passport_id: p, key: 'mrr', value: 100, observed_at: d('2026-01-10') },
      { passport_id: p, key: 'mrr', value: 200, observed_at: d('2026-02-10') },
    ])
    expect(new Set(rows.map(r => +r.observed_at)).size).toBe(2)
    // and the later one is what `current` resolves to
    expect(await facts.get(p, 'mrr')).toBe(200)
  })

  it('spans passports as happily as keys', async () => {
    const a = await newPassport()
    const b = await newPassport()
    await facts.recordBatch([
      { passport_id: a, key: 'plan_tier', value: 'pro' },
      { passport_id: b, key: 'plan_tier', value: 'free' },
    ])
    expect(await facts.get(a, 'plan_tier')).toBe('pro')
    expect(await facts.get(b, 'plan_tier')).toBe('free')
  })

  it('resolves merged ids, like record() and recordMany()', async () => {
    const survivor = await newPassport()
    const absorbed = await newPassport()
    mergeMap[absorbed] = survivor
    const rows = await facts.recordBatch([
      { passport_id: absorbed, key: 'plan_tier', value: 'pro' },
    ])
    expect(rows[0].passport_id).toBe(survivor)
  })

  // Built by code, not by users: a missing key is a bug, and skipping it would
  // write a partial state that looks complete.
  it('throws on a malformed entry rather than writing a partial batch', async () => {
    const p = await newPassport()
    await expect(facts.recordBatch([
      { passport_id: p, key: 'plan_tier', value: 'pro' },
      { passport_id: p, value: 'orphan' },
    ])).rejects.toThrow(/key is required/)
    // nothing from the batch landed
    expect(await facts.current(p)).toEqual({})
  })

  it('is a no-op for an empty batch', async () => {
    expect(await facts.recordBatch([])).toEqual([])
    expect(await facts.recordBatch()).toEqual([])
  })
})

// external_id — the writer's idempotency handle (migrations/003).
//
// These run against real Postgres deliberately. The mechanism IS the partial
// unique index and the ON CONFLICT target that has to repeat its predicate; a
// mocked knex would accept a conflict target Postgres rejects outright with
// "no unique or exclusion constraint matching the ON CONFLICT specification".
describe('facts external_id + resolve', () => {
  const base = (p, over = {}) => ({
    passport_id: p, key: 'booking', value: true,
    source: 'gpoint', external_id: 'booking:558231',
    observed_at: d('2026-03-01T10:00:00Z'), ...over,
  })
  const rows = (p) => db('whitebox_facts').where({ passport_id: p }).orderBy('id')

  it('appends as before when no external_id is given', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'visits', value: 1, source: 'x', observed_at: d('2026-01-01') })
    await facts.record({ passport_id: p, key: 'visits', value: 1, source: 'x', observed_at: d('2026-01-01') })
    expect(await rows(p)).toHaveLength(2)      // untouched: the index is partial
  })

  it('resolve:skip makes a re-send free', async () => {
    const p = await newPassport()
    const first = await facts.record({ ...base(p), resolve: 'skip' })
    const again = await facts.record({ ...base(p), resolve: 'skip' })
    expect(first).toBeTruthy()
    expect(again).toBeUndefined()              // nothing returned — nothing written
    expect(await rows(p)).toHaveLength(1)
  })

  it('resolve:replace corrects what was already sent', async () => {
    const p = await newPassport()
    await facts.record({ ...base(p, { value: 'pending' }), resolve: 'replace' })
    await facts.record({ ...base(p, { value: 'confirmed' }), resolve: 'replace' })
    const all = await rows(p)
    expect(all).toHaveLength(1)
    expect(all[0].value).toBe('confirmed')
  })

  it('keeps the TIMELINE — a later observation of the same id is a new row', async () => {
    // observed_at is in the key precisely so this still appends. Without it a
    // fact with a stable external_id could hold one row ever and history() would
    // have nothing to return.
    const p = await newPassport()
    await facts.record({ ...base(p, { value: 'pending' }), resolve: 'skip' })
    await facts.record({ ...base(p, { value: 'confirmed', observed_at: d('2026-03-02T10:00:00Z') }), resolve: 'skip' })
    expect(await rows(p)).toHaveLength(2)
    expect(await facts.get(p, 'booking')).toBe('confirmed')
  })

  it('scopes identity to the source — two systems can both observe it', async () => {
    const p = await newPassport()
    await facts.record({ ...base(p), resolve: 'skip' })
    await facts.record({ ...base(p, { source: 'altegio' }), resolve: 'skip' })
    expect(await rows(p)).toHaveLength(2)
  })

  it('throws on a conflict when the caller named no resolution', async () => {
    // No default, on purpose: only the writer knows whether a repeat means
    // "already sent" or "was wrong". Loud beats guessing.
    const p = await newPassport()
    await facts.record(base(p))
    await expect(facts.record(base(p))).rejects.toThrow()
  })

  it('rejects resolve without an external_id to resolve against', async () => {
    const p = await newPassport()
    await expect(facts.record({ passport_id: p, key: 'k', value: 1, resolve: 'skip' }))
      .rejects.toThrow(/external_id/)
  })

  it('recordBatch: skips only the rows already sent, keeps the rest', async () => {
    const p = await newPassport()
    await facts.recordBatch([base(p)], { resolve: 'skip' })
    const out = await facts.recordBatch([
      base(p),                                              // already sent
      base(p, { external_id: 'booking:558232', value: 1 }), // new
    ], { resolve: 'skip' })
    expect(out).toHaveLength(1)
    expect(await rows(p)).toHaveLength(2)
  })

  it('recordBatch: a batch may mix identified and anonymous facts', async () => {
    const p = await newPassport()
    await facts.recordBatch([
      base(p),
      { passport_id: p, key: 'visits_total', value: 12, source: 'gpoint', observed_at: d('2026-03-01T10:00:00Z') },
    ], { resolve: 'skip' })
    // Re-send both: the identified one is skipped, the anonymous one appends.
    await facts.recordBatch([
      base(p),
      { passport_id: p, key: 'visits_total', value: 12, source: 'gpoint', observed_at: d('2026-03-01T10:00:00Z') },
    ], { resolve: 'skip' })
    const all = await rows(p)
    expect(all.filter(r => r.key === 'booking')).toHaveLength(1)
    expect(all.filter(r => r.key === 'visits_total')).toHaveLength(2)
  })
})
