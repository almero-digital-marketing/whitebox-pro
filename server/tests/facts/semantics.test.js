import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

// WHICH of a passport's values a key MEANS.
//
// A fact is single-valued per passport, so any read that needs one value picks one.
// It picked the latest write, silently, and there was no way to say otherwise. On live
// data that made `{ first_booked_at: { gte: '2026-01-01' } }` answer 16,741 where the
// truth is 16,155 — because ~2,500 duplicate CRM customer records and 832 passport
// merges give one passport several legitimate "first booking" dates, and a first
// booking cannot move forward.
//
// The rule belongs with the WRITER, which is the only party that knows: the code that
// computes the minimum booking date does so precisely because it understands the key.
// Hence describe(), which already carried labels on the same first-write-wins terms.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const passports = { resolve: async id => id }
const d = s => new Date(s)

const boot = (config = {}) => {
  facts.init({ db, passports, logger, config })
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
}

beforeAll(async () => { boot(); await facts.migrate() })
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_facts_current, whitebox_awareness_exposures, whitebox_passports CASCADE')
  boot()
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
// A passport holding two legitimate "first booking" dates, as a merge or a duplicate
// customer record produces: the EARLIER one written first, the later one written last.
async function twoBookingDates() {
  const p = await newPassport()
  await facts.record({ passport_id: p, key: 'first_booked_at', value: '2025-03-01', source: 'crm', external_id: 'cust-a', observed_at: d('2025-03-01') })
  await facts.record({ passport_id: p, key: 'first_booked_at', value: '2026-06-01', source: 'crm', external_id: 'cust-b', observed_at: d('2026-06-01') })
  return p
}
const matches = async (pred) =>
  (await selector.resolve({ filter: { fact: { first_booked_at: pred } } }, { projection: 'count' })).count

describe('facts: declared semantics', () => {
  it('works with NO declaration — the behaviour that exists today', async () => {
    await twoBookingDates()
    expect(facts.useFor('first_booked_at')).toBe(null)     // undeclared is null, not 'last'
    // falls through to `last`: the 2026 date, which is why this was wrong
    expect(await matches({ gte: '2026-01-01' })).toBe(1)
    expect(await matches({ lt: '2026-01-01' })).toBe(0)
  })

  it('a declaration makes the key correct everywhere, with no caller action', async () => {
    await twoBookingDates()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    expect(facts.useFor('first_booked_at')).toBe('min')
    expect(await matches({ gte: '2026-01-01' })).toBe(0)   // the 2025 date is the first one
    expect(await matches({ lt: '2026-01-01' })).toBe(1)
  })

  it('the query can still override the declaration', async () => {
    await twoBookingDates()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    expect(await matches({ gte: '2026-01-01', use: 'max' })).toBe(1)
  })

  it('describe() carries it, and the old string form still sets a label', async () => {
    facts.describe('geo_city', 'City')                      // original form
    expect(facts.label('geo_city')).toBe('City')
    expect(facts.useFor('geo_city')).toBe(null)

    facts.describe('visits_total', { label: 'Visits', use: 'max' })
    expect(facts.label('visits_total')).toBe('Visits')
    expect(facts.useFor('visits_total')).toBe('max')
  })

  it('config WINS over a plugin declaration — the operator has the final word', async () => {
    boot({ facts: { use: { first_booked_at: 'min' } } })
    facts.describe('first_booked_at', { use: 'last' })       // a plugin, seeded second
    expect(facts.useFor('first_booked_at')).toBe('min')
  })

  it('rejects an unknown rule at BOOT, not at query time', () => {
    expect(() => boot({ facts: { use: { first_booked_at: 'earliest' } } }))
      .toThrow(/unknown value "earliest".*last\/first\/max\/min/s)
    expect(() => facts.describe('x', { use: 'nope' })).toThrow(/unknown `use` "nope"/)
  })

  it('the window anchor honours the same declaration', async () => {
    // The failure this prevents: a filter and the window that anchors on the same key
    // disagreeing about which value it means.
    const p = await twoBookingDates()
    await db('whitebox_awareness_exposures').insert({
      passport_id: p, ts: d('2025-06-01'), channel: 'web', direction: 'expression',
      source: 'video', text: 'x', content_url: 'https://x/a.mp4',
    })
    const before = async () => {
      const r = await selector.resolve(
        { filter: { metric: { source: 'video', window: { before: { fact: 'first_booked_at' } }, count: {} } } },
        { group: { by: 'source' } })
      return r[0]?.value ?? 0
    }
    boot()                                                   // undeclared -> last (2026): the view precedes it
    expect(await before()).toBe(1)
    boot({ facts: { use: { first_booked_at: 'min' } } })      // min (2025-03): the view is AFTER it
    expect(await before()).toBe(0)
  })
})

describe('facts: the ambiguity report', () => {
  it('names an undeclared ambiguous key, with scale and who wrote it', async () => {
    await twoBookingDates()
    const report = await facts.undeclaredAmbiguous()
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({
      key: 'first_booked_at',
      ambiguous_passports: 1,
      passports_with_key: 1,
      pct: 100,
      max_values_for_one_passport: 2,
    })
    expect(report[0].sources).toContain('crm')               // accountability
  })

  it('goes quiet once the key is declared — a config gap, not a data property', async () => {
    await twoBookingDates()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    expect(await facts.undeclaredAmbiguous()).toEqual([])
    // still visible to a full data-health view, which is a different question
    expect((await facts.allAmbiguous()).map(a => a.key)).toEqual(['first_booked_at'])
  })

  it('says nothing about a key with ONE value, however many rows', async () => {
    // The reason value_count counts DISTINCT VALUES: row count would have made this a
    // warning, and on live data 99.5% of promo_dependency's warnings would be false.
    const p = await newPassport()
    for (const ext of ['b1', 'b2', 'b3']) {
      await facts.record({ passport_id: p, key: 'booking_online', value: true, source: 'crm', external_id: ext })
    }
    const rows = await db('whitebox_facts').where({ passport_id: p, key: 'booking_online' }).count('* as n')
    expect(Number(rows[0].n)).toBe(3)                        // three rows
    expect(await facts.undeclaredAmbiguous()).toEqual([])    // one value — not ambiguous
  })

  it('tracks value_count through a merge and a delete', async () => {
    const survivor = await newPassport(), absorbed = await newPassport()
    await facts.record({ passport_id: survivor, key: 'tier', value: 'pro', source: 't' })
    await facts.record({ passport_id: absorbed, key: 'tier', value: 'free', source: 't' })
    const vc = async (id) => (await db('whitebox_facts_current').where({ passport_id: id, key: 'tier' }).first())?.value_count
    expect(await vc(survivor)).toBe(1)

    await db('whitebox_facts').where({ passport_id: absorbed }).update({ passport_id: survivor })
    expect(await vc(survivor)).toBe(2)                       // the merge made it ambiguous
    expect((await facts.undeclaredAmbiguous()).map(a => a.key)).toEqual(['tier'])

    await db('whitebox_facts').where({ passport_id: survivor, key: 'tier', value: JSON.stringify('free') }).del()
    expect(await vc(survivor)).toBe(1)                       // and removing it resolves the ambiguity
    expect(await facts.undeclaredAmbiguous()).toEqual([])
  })
})
