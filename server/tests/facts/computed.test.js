import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'
import * as computed from '../../src/facts/computed.js'

// A key DERIVED from a stored one, on read.
//
// `age` cannot be stored: written down it is wrong tomorrow, and a nightly job to
// bump an integer across 111k rows is a lot of machinery for a number that is just
// a reading of `birthdate` taken now. Without it every cohort question needs the
// date computed by the caller — `last_visit_at >= '2026-02-16'` — which answers
// "since 16 February", not "in the last six months", and quietly means something
// different the next day.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }), warn() {}, info() {}, debug() {}, error() {} }
const config = { facts: { computed: {
  age:          { from: 'birthdate', unit: 'years' },
  months_since: { from: 'seen_at', unit: 'months' },
  days_since:   { from: 'seen_at', unit: 'days' },
} } }

beforeAll(async () => {
  facts.init({ db, passports: { resolve: async (id) => id }, logger, config })
  await facts.migrate()
  selector.init({ db, passports: { resolve: async (id) => id }, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE')
  facts.init({ db, passports: { resolve: async (id) => id }, logger, config })
})

const newPassport = async () => { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
const daysAgo = (n) => new Date(Date.now() - n * 864e5)
const ids = (r) => r.passports.map((p) => p.id).sort()

describe('computed facts', () => {
  it('derives whole years from a stored date', async () => {
    const a = await newPassport(), b = await newPassport()
    await facts.record({ passport_id: a, key: 'birthdate', value: '1987-04-12', source: 't' })
    await facts.record({ passport_id: b, key: 'birthdate', value: '2010-04-12', source: 't' })

    const older = await selector.resolve({ filter: { fact: { age: { gte: 30 } } } }, { projection: 'people' })
    expect(ids(older)).toEqual([a])
  })

  it('is a RANGE like any other numeric fact', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'birthdate', value: '1987-04-12', source: 't' })
    const inBand = await selector.resolve({ filter: { fact: { age: { gte: 30, lte: 60 } } } }, { projection: 'count' })
    expect(inBand.count).toBe(1)
    const outside = await selector.resolve({ filter: { fact: { age: { lte: 20 } } } }, { projection: 'count' })
    expect(outside.count).toBe(0)
  })

  it('counts months and days from the same source key', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'seen_at', value: daysAgo(70).toISOString().slice(0, 10), source: 't' })
    // 70 days ≈ 2 whole months
    expect((await selector.resolve({ filter: { fact: { months_since: { gte: 2 } } } }, { projection: 'count' })).count).toBe(1)
    expect((await selector.resolve({ filter: { fact: { months_since: { gte: 4 } } } }, { projection: 'count' })).count).toBe(0)
    expect((await selector.resolve({ filter: { fact: { days_since: { gte: 69, lte: 71 } } } }, { projection: 'count' })).count).toBe(1)
  })

  it('moves with the clock — the whole point', async () => {
    const a = await newPassport()
    // Someone who turns 30 tomorrow is 29 today. A stored `age` would have to be
    // rewritten to stay true; a derived one simply is.
    const turns30Tomorrow = new Date(Date.now() + 864e5)
    turns30Tomorrow.setFullYear(turns30Tomorrow.getFullYear() - 30)
    await facts.record({ passport_id: a, key: 'birthdate', value: turns30Tomorrow.toISOString().slice(0, 10), source: 't' })
    expect((await selector.resolve({ filter: { fact: { age: { gte: 30 } } } }, { projection: 'count' })).count).toBe(0)
    expect((await selector.resolve({ filter: { fact: { age: { eq: 29 } } } }, { projection: 'count' })).count).toBe(1)
  })

  it('a passport without the source fact simply does not match', async () => {
    const a = await newPassport()
    await newPassport()                                   // no birthdate at all
    await facts.record({ passport_id: a, key: 'birthdate', value: '1987-04-12', source: 't' })
    expect(ids(await selector.resolve({ filter: { fact: { age: { gte: 1 } } } }, { projection: 'people' }))).toEqual([a])
  })

  it('an unparseable source value does not fail the query', async () => {
    const a = await newPassport(), b = await newPassport()
    await facts.record({ passport_id: a, key: 'birthdate', value: '1987-04-12', source: 't' })
    await facts.record({ passport_id: b, key: 'birthdate', value: '', source: 't' })
    // one bad row must not empty the cohort
    expect(ids(await selector.resolve({ filter: { fact: { age: { gte: 1 } } } }, { projection: 'people' }))).toEqual([a])
  })

  it('the FILTER and the BUCKET agree, because they share one expression', async () => {
    const a = await newPassport(), b = await newPassport()
    for (const [p, bd] of [[a, '1987-04-12'], [b, '1988-04-12']]) {
      await facts.record({ passport_id: p, key: 'birthdate', value: bd, source: 't' })
      await db('whitebox_awareness_exposures').insert({
        passport_id: p, ts: new Date(), channel: 'web', direction: 'expression',
        text: 'x', content_id: 'purchase', dwell_ms: 1, meta: JSON.stringify({ event: 'purchase' }),
      })
    }
    const series = await selector.resolve(
      { filter: { metric: { content: 'purchase', distinct_passports: {} } } },
      { group: { by: 'fact:age', band: 5 } })
    const banded = series.filter((s) => s.bucket != null)
    const bucketTotal = banded.reduce((acc, s) => acc + s.value, 0)
    // whatever the band, everyone with a birthdate is in one
    expect(bucketTotal).toBe(2)
    for (const s of banded) {
      const [lo, hi] = s.bucket.split('-').map(Number)
      const viaFilter = await selector.resolve({ filter: { fact: { age: { gte: lo, lte: hi } } } }, { projection: 'count' })
      expect(viaFilter.count).toBe(s.value)
    }
  })

  it('rejects a bad declaration at boot, not at query time', () => {
    expect(() => computed.init({ age: { from: 'birthdate', unit: 'fortnights' } })).toThrow(/unknown unit/)
    expect(() => computed.init({ age: { unit: 'years' } })).toThrow(/needs `from`/)
    expect(() => computed.init({ age: { from: 'age', unit: 'years' } })).toThrow(/from itself/)
    expect(() => computed.init({
      age: { from: 'birthdate', unit: 'years' },
      decades: { from: 'age', unit: 'years' },
    })).toThrow(/must be a STORED fact/)
    computed.init(config.facts.computed)                  // restore for the rest of the file
  })

  it('lists computed keys in the queryable vocabulary', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'birthdate', value: '1987-04-12', source: 't' })
    const keys = await facts.usedKeys()
    expect(keys).toContain('birthdate')     // stored
    expect(keys).toContain('age')           // computed — otherwise nothing advertises it
  })
})
