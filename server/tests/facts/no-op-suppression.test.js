import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'

// A write that restates the CURRENT value of a key is invisible to every reader
// (current / asOf / matches / the selector's fact predicate all resolve to the
// latest row per passport+key) — so storing it buys nothing and costs heap,
// index, vacuum and backup.
//
// Found on the GPoint deployment: the geolocation plugin writes five facts on
// EVERY session resolve with no comparison against what is already stored, so a
// returning visitor from the same city wrote five identical rows per visit —
// ~107k redundant rows per geo key in a week, in a table whose indexes had grown
// to nearly 2x its heap.

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async (id) => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => { await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE') })

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
const rowsFor = (id, key) => db('whitebox_facts').where({ passport_id: id, key }).orderBy('observed_at')

describe('facts — no-op suppression', () => {
  it('a restatement of the current value writes no row', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia', source: 'geolocation' })
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia', source: 'geolocation' })
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia', source: 'geolocation' })

    expect(await rowsFor(id, 'geo_city')).toHaveLength(1)
  })

  it('still returns the current row when it suppresses', async () => {
    const id = await newPassport()
    const first = await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia' })
    const second = await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia' })

    // The contract is "what is now current for this key", not "what I inserted".
    expect(second.id).toBe(first.id)
    expect(second.value).toBe('Sofia')
  })

  it('a CHANGED value still writes, and becomes current', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia' })
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Plovdiv' })
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Plovdiv' })   // no-op
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia' })     // moved back — a real change

    const rows = await rowsFor(id, 'geo_city')
    expect(rows.map(r => r.value)).toEqual(['Sofia', 'Plovdiv', 'Sofia'])
    expect(await facts.get(id, 'geo_city')).toBe('Sofia')
  })

  it('does not confuse two keys, or two people', async () => {
    const a = await newPassport(), b = await newPassport()
    await facts.record({ passport_id: a, key: 'geo_city', value: 'Sofia' })
    await facts.record({ passport_id: a, key: 'geo_region', value: 'Sofia' })   // same VALUE, other key
    await facts.record({ passport_id: b, key: 'geo_city', value: 'Sofia' })     // same value+key, other person

    expect(await rowsFor(a, 'geo_city')).toHaveLength(1)
    expect(await rowsFor(a, 'geo_region')).toHaveLength(1)
    expect(await rowsFor(b, 'geo_city')).toHaveLength(1)
  })

  it('compares by value, not by key order, for object values', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'geo_point', value: { lat: 42.7, lon: 23.3 } })
    await facts.record({ passport_id: id, key: 'geo_point', value: { lon: 23.3, lat: 42.7 } })

    // A provider that reorders its JSON has not told us anything new.
    expect(await rowsFor(id, 'geo_point')).toHaveLength(1)
  })

  it('does not suppress a number/string mismatch', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'visits_total', value: 3 })
    await facts.record({ passport_id: id, key: 'visits_total', value: '3' })

    expect(await rowsFor(id, 'visits_total')).toHaveLength(2)
  })

  // ── the two carve-outs ────────────────────────────────────────────────────
  it('never suppresses a fact that carries an external_id', async () => {
    const id = await newPassport()
    // Two DIFFERENT bookings that happen to share a value. Collapsing these
    // would destroy real records — which is why booking keys, which carry an
    // external_id, did not duplicate on GPoint while geo keys did.
    await facts.record({ passport_id: id, key: 'booking_online', value: true, external_id: 'booking:1' })
    await facts.record({ passport_id: id, key: 'booking_online', value: true, external_id: 'booking:2' })
    await facts.record({ passport_id: id, key: 'booking_online', value: true, external_id: 'booking:3' })

    expect(await rowsFor(id, 'booking_online')).toHaveLength(3)
  })

  it('leaves resolve to settle a re-send of the SAME external_id', async () => {
    const id = await newPassport()
    const at = '2026-06-01'
    // Suppression must not shadow `resolve` — an identified re-send is the one
    // repeat the database can recognise, and 'replace' is the writer saying what
    // they sent was wrong.
    await facts.record({ passport_id: id, key: 'booking_total', value: 100, source: 'crm', external_id: 'booking:1', observed_at: at })
    await facts.record({ passport_id: id, key: 'booking_total', value: 140, source: 'crm', external_id: 'booking:1', observed_at: at, resolve: 'replace' })

    const rows = await rowsFor(id, 'booking_total')
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(140)
  })

  it('never suppresses a BACK-DATED restatement (asOf must stay correct)', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'plan', value: 'pro', observed_at: '2026-06-01' })
    await facts.record({ passport_id: id, key: 'plan', value: 'free', observed_at: '2026-07-01' })
    // Learned late: they were already 'free' back in May. Same value as current,
    // but it lands BEFORE it — so it changes what asOf(May) answers.
    await facts.record({ passport_id: id, key: 'plan', value: 'free', observed_at: '2026-05-01' })

    expect(await rowsFor(id, 'plan')).toHaveLength(3)
    expect(await facts.get(id, 'plan', { at: new Date('2026-05-15') })).toBe('free')
    expect(await facts.get(id, 'plan')).toBe('free')
  })

  it('force: true records the restatement anyway', async () => {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia' })
    await facts.record({ passport_id: id, key: 'geo_city', value: 'Sofia', force: true })

    expect(await rowsFor(id, 'geo_city')).toHaveLength(2)
  })

  // ── bulk paths ────────────────────────────────────────────────────────────
  it('recordBatch suppresses only the unchanged fields', async () => {
    const id = await newPassport()
    await facts.recordBatch([
      { passport_id: id, key: 'plan', value: 'pro' },
      { passport_id: id, key: 'mrr', value: 100 },
      { passport_id: id, key: 'city', value: 'Sofia' },
    ])
    // The CRM re-sync: same three fields pushed again, one has moved.
    const written = await facts.recordBatch([
      { passport_id: id, key: 'plan', value: 'pro' },
      { passport_id: id, key: 'mrr', value: 120 },
      { passport_id: id, key: 'city', value: 'Sofia' },
    ])

    expect(written).toHaveLength(1)
    expect(written[0].key).toBe('mrr')
    expect(await db('whitebox_facts').where({ passport_id: id }).count('* as n')).toEqual([{ n: '4' }])
  })

  it('recordMany suppresses people who already carry the tag', async () => {
    const a = await newPassport(), b = await newPassport(), c = await newPassport()
    await facts.recordMany({ passport_ids: [a, b], key: 'segment', value: 'vip' })
    // An audience refresh re-states the tag for everyone, and adds one person.
    const written = await facts.recordMany({ passport_ids: [a, b, c], key: 'segment', value: 'vip' })

    expect(written).toHaveLength(1)
    expect(written[0].passport_id).toBe(c)
  })
})
