import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const asMap = series => Object.fromEntries(series.map(r => [r.bucket, r.value]))

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => { await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE') })

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function expose(passport_id, { channel = 'web', ts, content = 'purchase', value, direction = 'expression' }) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, ts: d(ts), channel, direction, text: 'x', content_id: content,
    meta: value == null ? null : JSON.stringify({ value }),
  })
}

// Two people, purchases across two days + channels, plus one non-purchase event.
async function fixture() {
  const p1 = await newPassport(), p2 = await newPassport()
  await expose(p1, { channel: 'web',   ts: '2026-05-01', value: 100 })
  await expose(p1, { channel: 'web',   ts: '2026-05-01', value: 50 })
  await expose(p2, { channel: 'email', ts: '2026-05-02', value: 200 })
  await expose(p2, { channel: 'web',   ts: '2026-05-02', content: 'pricing' })   // not a purchase
  return { p1, p2 }
}

const purchases = { filter: { metric: { content: 'purchase', count: {} } } }

// The DENOMINATOR. A series of per-bucket numbers cannot be turned into a reach
// percentage without knowing how many people the query was over, and getting it
// took another call — plus more calls again for each cohort being compared.
describe('selector group: cohortSize', () => {
  const purchases3 = { filter: { metric: { content: 'purchase', count: {} } } }

  it('returns a bare array unless asked — nothing that reads one has to change', async () => {
    await fixture()
    const r = await selector.resolve(purchases3, { group: { by: 'channel' } })
    expect(Array.isArray(r)).toBe(true)
  })

  it('returns { series, cohortSize, aggregate } when asked', async () => {
    await fixture()
    const r = await selector.resolve(purchases3, { group: { by: 'channel', cohortSize: true } })
    expect(Array.isArray(r)).toBe(false)
    expect(asMap(r.series)).toEqual({ web: 2, email: 1 })
    expect(r.cohortSize).toBe(2)            // two people, three purchases
    expect(r.aggregate).toBe('count')       // so the caller knows what the values ARE
  })

  it('counts PEOPLE even when the series counts events', async () => {
    // Otherwise a percentage divides events by people — two different units.
    await fixture()
    const r = await selector.resolve(purchases3, { group: { by: 'channel', cohortSize: true } })
    const events = r.series.reduce((n, x) => n + x.value, 0)
    expect(events).toBe(3)
    expect(r.cohortSize).toBe(2)
  })

  it('is NOT trimmed by `limit` — the top-N guardrail must not inflate percentages', async () => {
    await fixture()
    const r = await selector.resolve(purchases3, { group: { by: 'channel', limit: 1, cohortSize: true } })
    expect(r.series).toHaveLength(1)        // display trimmed
    expect(r.cohortSize).toBe(2)            // denominator intact
  })

  it('counts the cohort the FILTER selects, including people in no bucket', async () => {
    // Someone whose fact value is missing contributes to no bucket but is still in
    // the cohort. Excluding them would flatter every percentage computed from this.
    const a = await newPassport(), b = await newPassport()
    for (const p of [a, b]) await expose(p, { ts: '2026-05-01' })
    await facts.record({ passport_id: a, key: 'tier', value: 'pro', source: 't' })
    // b has no `tier` at all
    const r = await selector.resolve({ filter: { metric: { content: 'purchase', distinct_passports: {} } } },
      { group: { by: 'fact:tier', cohortSize: true } })
    expect(r.cohortSize).toBe(2)
    expect(asMap(r.series)).toEqual({ pro: 1, null: 1 })   // b lands in the null bucket
  })

  it('answers an empty cohort in the SAME shape', async () => {
    // A bare [] here would make a caller read `.series` off an array and get
    // undefined — indistinguishable from a bug in their own code.
    await fixture()
    const r = await selector.resolve(
      { filter: { all: [
        { metric: { content: 'purchase', count: {} } },
        { fact: { tier: { eq: 'nobody-has-this' } } },
      ] } },
      { group: { by: 'channel', cohortSize: true } })
    expect(r).toEqual({ series: [], cohortSize: 0, aggregate: 'count' })
  })

  it('names cohortSize in the unknown-key hint', async () => {
    await fixture()
    await expect(selector.resolve(purchases3, { group: { by: 'channel', cohortsize: true } }))
      .rejects.toThrow(/cohortSize: true/)
  })
})

// `fact:<key>` — the bucket comes from whitebox_facts, so it needs its own join.
// Core could not group by a fact at all; the analytics layer answered it with a
// separate per-key query, which is why a fact breakdown could not be combined with
// an event window or aggregate.
// Every projection used to end in a COUNT of passports, sessions or events. There
// was no way to ask what the numbers themselves were — the sum, the middle, the
// spread — grouped by anything.
// "Which content do people consume" was not expressible: content_url was not a
// bucket, so asking for one returned an empty series in silence.
// Aggregating a FACT is per PERSON, which is why it cannot be one GROUP BY over the
// exposure stream: exposures are many-per-passport, so averaging the joined fact
// weights each customer by how many events they have.
describe('selector group: aggregates over a fact', () => {
  const purchase = (agg) => ({ filter: { metric: { content: 'purchase', ...agg } } })

  it('counts each passport ONCE per bucket, however many events they have', async () => {
    const heavy = await newPassport(), light = await newPassport()
    // heavy has 4 purchases, light has 1. Their values are 100 and 200.
    for (const ts of ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']) await expose(heavy, { ts })
    await expose(light, { ts: '2026-05-05' })
    await facts.record({ passport_id: heavy, key: 'ltv', value: 100, source: 't' })
    await facts.record({ passport_id: light, key: 'ltv', value: 200, source: 't' })

    const r = await selector.resolve(purchase({ avg: { fact: 'ltv' } }), { group: { by: 'month' } })
    // Deduped: (100 + 200) / 2 = 150. Event-weighted would be
    // (100*4 + 200) / 5 = 120 — a per-VISIT mean wearing a per-customer label.
    expect(r[0].value).toBe(150)
  })

  it('puts a passport in every bucket it was active in, once each', async () => {
    const p = await newPassport()
    await expose(p, { ts: '2026-05-01' })
    await expose(p, { ts: '2026-05-02' })      // same month, twice
    await expose(p, { ts: '2026-06-01' })
    await facts.record({ passport_id: p, key: 'ltv', value: 50, source: 't' })
    const r = await selector.resolve(purchase({ avg: { fact: 'ltv' } }), { group: { by: 'month' } })
    expect(asMap(r)).toEqual({ '2026-05': 50, '2026-06': 50 })
  })

  it('sums per person, not per event', async () => {
    const a = await newPassport(), b = await newPassport()
    await expose(a, { ts: '2026-05-01' }); await expose(a, { ts: '2026-05-02' })
    await expose(b, { ts: '2026-05-03' })
    await facts.record({ passport_id: a, key: 'ltv', value: 10, source: 't' })
    await facts.record({ passport_id: b, key: 'ltv', value: 5, source: 't' })
    const r = await selector.resolve(purchase({ sum: { fact: 'ltv' } }), { group: { by: 'month' } })
    expect(r[0].value).toBe(15)                // not 25
  })

  it('takes min/max/median over the deduped values', async () => {
    const a = await newPassport(), b = await newPassport(), c = await newPassport()
    for (const [p, v] of [[a, 10], [b, 20], [c, 60]]) {
      await expose(p, { ts: '2026-05-01' })
      await facts.record({ passport_id: p, key: 'ltv', value: v, source: 't' })
    }
    const at = (agg) => selector.resolve(purchase(agg), { group: { by: 'month' } })
    expect((await at({ min: { fact: 'ltv' } }))[0].value).toBe(10)
    expect((await at({ max: { fact: 'ltv' } }))[0].value).toBe(60)
    expect((await at({ median: { fact: 'ltv' } }))[0].value).toBe(20)
  })

  it('ignores a passport without the fact, and a non-numeric value', async () => {
    const a = await newPassport(), b = await newPassport(), c = await newPassport()
    for (const p of [a, b, c]) await expose(p, { ts: '2026-05-01' })
    await facts.record({ passport_id: a, key: 'ltv', value: 100, source: 't' })
    await facts.record({ passport_id: b, key: 'ltv', value: 'n/a', source: 't' })
    // c has no ltv at all
    const r = await selector.resolve(purchase({ avg: { fact: 'ltv' } }), { group: { by: 'month' } })
    expect(r[0].value).toBe(100)               // neither contributes a zero
  })

  it('combines a fact aggregate with a fact BUCKET', async () => {
    const a = await newPassport(), b = await newPassport()
    for (const [p, tier, v] of [[a, 'pro', 100], [b, 'free', 20]]) {
      await expose(p, { ts: '2026-05-01' })
      await facts.record({ passport_id: p, key: 'tier', value: tier, source: 't' })
      await facts.record({ passport_id: p, key: 'ltv', value: v, source: 't' })
    }
    const r = await selector.resolve(purchase({ avg: { fact: 'ltv' } }), { group: { by: 'fact:tier' } })
    expect(asMap(r)).toEqual({ pro: 100, free: 20 })
  })

  it('refuses earliest/latest over a fact — it has one current value', async () => {
    await fixture()
    await expect(selector.resolve(purchase({ earliest: { fact: 'ltv' } }), { group: { by: 'month' } }))
      .rejects.toThrow(/orders by event time/)
  })

  it('refuses two sources at once', async () => {
    await fixture()
    await expect(selector.resolve(purchase({ avg: { fact: 'ltv', field: 'value' } }), { group: { by: 'month' } }))
      .rejects.toThrow(/one of `field`\/`column`\/`fact`/)
  })
})

// WHICH value the aggregate and the bucket mean, when a passport holds several.
//
// A fact predicate has honoured `use` (last/first/max/min) since the key semantics
// landed, and these two paths did not: `avg: { fact: 'ltv' }` and
// `group.by: 'fact:ltv'` both took the latest write regardless of what the key was
// declared to mean. So one query could contradict itself — filter on
// `first_booked_at` under the declared `min` while bucketing the same key by `last`,
// and the rows in a bucket were not the rows the filter selected.
describe('selector group: `use` on a fact aggregate and a fact bucket', () => {
  const purchase = (agg, opts) => selector.resolve(
    { filter: { metric: { content: 'purchase', ...agg } } }, { group: opts })
  const boot = (config = {}) => facts.init({ db, passports, logger, config })
  afterEach(() => boot())                        // module state; don't leak a declaration

  // One passport holding two legitimate values, as a passport merge or a duplicate
  // CRM record produces: 100 written first, 300 written last. Plus a single-valued
  // one, so an avg that silently picked the wrong value is still a plausible number
  // rather than an obvious outlier — which is how this went unnoticed on live data.
  async function conflicted() {
    const p = await newPassport(), q = await newPassport()
    await expose(p, { ts: '2026-05-01' }); await expose(q, { ts: '2026-05-01' })
    await facts.record({ passport_id: p, key: 'ltv', value: 100, source: 'crm', external_id: 'a', observed_at: d('2026-01-01') })
    await facts.record({ passport_id: p, key: 'ltv', value: 300, source: 'crm', external_id: 'b', observed_at: d('2026-04-01') })
    await facts.record({ passport_id: q, key: 'ltv', value: 200, source: 'crm', external_id: 'c', observed_at: d('2026-01-01') })
    return { p, q }
  }

  it('aggregates the latest value when nothing is declared', async () => {
    await conflicted()
    expect((await purchase({ avg: { fact: 'ltv' } }, { by: 'month' }))[0].value).toBe(250)   // (300 + 200) / 2
  })

  it('honours the declaration, with nothing changed at the call site', async () => {
    await conflicted()
    boot({ facts: { use: { ltv: 'min' } } })
    expect((await purchase({ avg: { fact: 'ltv' } }, { by: 'month' }))[0].value).toBe(150)   // (100 + 200) / 2
    boot({ facts: { use: { ltv: 'max' } } })
    expect((await purchase({ avg: { fact: 'ltv' } }, { by: 'month' }))[0].value).toBe(250)
  })

  it('lets the aggregate override the declaration', async () => {
    await conflicted()
    boot({ facts: { use: { ltv: 'max' } } })
    expect((await purchase({ avg: { fact: 'ltv', use: 'min' } }, { by: 'month' }))[0].value).toBe(150)
    expect((await purchase({ sum: { fact: 'ltv', use: 'min' } }, { by: 'month' }))[0].value).toBe(300)
  })

  it('`first`/`last` are about WRITE ORDER, `min`/`max` about the value', async () => {
    const p = await newPassport()
    await expose(p, { ts: '2026-05-01' })
    // Written earliest-first but DESCENDING in value, so the two rules disagree: a
    // test where the earliest value is also the smallest proves nothing.
    await facts.record({ passport_id: p, key: 'ltv', value: 500, source: 'crm', external_id: 'a', observed_at: d('2026-01-01') })
    await facts.record({ passport_id: p, key: 'ltv', value: 50, source: 'crm', external_id: 'b', observed_at: d('2026-04-01') })
    const at = async (use) => (await purchase({ avg: { fact: 'ltv', use } }, { by: 'month' }))[0].value
    expect(await at('first')).toBe(500)
    expect(await at('last')).toBe(50)
    expect(await at('min')).toBe(50)
    expect(await at('max')).toBe(500)
  })

  it('the fact BUCKET honours the declaration too', async () => {
    const { p, q } = await conflicted()
    boot({ facts: { use: { ltv: 'min' } } })
    expect(asMap(await purchase({ count: {} }, { by: 'fact:ltv' }))).toEqual({ 100: 1, 200: 1 })
    boot({ facts: { use: { ltv: 'max' } } })
    expect(asMap(await purchase({ count: {} }, { by: 'fact:ltv' }))).toEqual({ 300: 1, 200: 1 })
    expect(p && q).toBeTruthy()
  })

  it('the bucket can override it, via group.use', async () => {
    await conflicted()
    boot({ facts: { use: { ltv: 'min' } } })
    expect(asMap(await purchase({ count: {} }, { by: 'fact:ltv', use: 'max' })))
      .toEqual({ 300: 1, 200: 1 })
  })

  it('the bucket rule and the aggregate rule are independent', async () => {
    // Two keys in one query, each meaning a different thing: the bucket takes the
    // earliest tier, the aggregate the largest value. Sharing one `use` between them
    // would make the honest spec unexpressible.
    const p = await newPassport()
    await expose(p, { ts: '2026-05-01' })
    await facts.record({ passport_id: p, key: 'tier', value: 'free', source: 'crm', external_id: 'a', observed_at: d('2026-01-01') })
    await facts.record({ passport_id: p, key: 'tier', value: 'pro', source: 'crm', external_id: 'b', observed_at: d('2026-04-01') })
    await facts.record({ passport_id: p, key: 'ltv', value: 100, source: 'crm', external_id: 'a', observed_at: d('2026-01-01') })
    await facts.record({ passport_id: p, key: 'ltv', value: 300, source: 'crm', external_id: 'b', observed_at: d('2026-04-01') })
    const r = await purchase({ avg: { fact: 'ltv', use: 'max' } }, { by: 'fact:tier', use: 'first' })
    expect(asMap(r)).toEqual({ free: 300 })
  })

  it('refuses `use` on an aggregate that is not over a fact', async () => {
    await fixture()
    await expect(purchase({ avg: { field: 'value', use: 'min' } }, { by: 'month' }))
      .rejects.toThrow(/only applies with `fact`/)
    await expect(purchase({ count: {} }, { by: 'month', use: 'min' }))
      .rejects.toThrow(/only applies to a `fact:<key>` bucket/)
  })

  it('rejects an unknown rule rather than falling back to last', async () => {
    await fixture()
    await expect(purchase({ avg: { fact: 'ltv', use: 'biggest' } }, { by: 'month' }))
      .rejects.toThrow(/one of last\/first\/max\/min/)
  })
})

// Bounding events in TIME. `last`/`since`/`until` always did this; what did not exist
// was a month unit, and what actively misled was every error message around them.
// `window: { between: [dateA, dateB] }` answered "window anchor must be { fact }" and
// `window: { last: '6M' }` answered "window has no last" — neither mentioning that the
// keys for a time range sit one level up. The reported consequence was that "revenue
// per studio for the last 6 months" looked inexpressible, when it was one key away.
describe('selector group: bounding events in time', () => {
  const paid = async (spec) => selector.resolve(
    { filter: { metric: { content: 'purchase', ...spec, sum: { field: 'value' } } } },
    { group: { by: 'channel' } })

  beforeEach(async () => {
    const p = await newPassport()
    await expose(p, { channel: 'web', ts: '2026-08-17', value: 10 })   // yesterday
    await expose(p, { channel: 'web', ts: '2026-05-01', value: 100 })  // ~3.5 months back
    await expose(p, { channel: 'web', ts: '2025-01-01', value: 1000 }) // over a year back
  })

  it('accepts a calendar month unit, which is what a half-year is written in', async () => {
    const at = { asOf: '2026-08-18' }
    const only = async (spec, opts) => (await selector.resolve(
      { filter: { metric: { content: 'purchase', ...spec, sum: { field: 'value' } } } },
      { group: { by: 'channel' }, ...opts }))[0]?.value
    expect(await only({ last: '7d' }, at)).toBe(10)
    expect(await only({ last: '6M' }, at)).toBe(110)      // yesterday + May
    expect(await only({ last: '1y' }, at)).toBe(110)
    expect(await only({ last: '2y' }, at)).toBe(1110)     // everything
  })

  it('accepts absolute bounds, and both together', async () => {
    const only = async (spec) => (await selector.resolve(
      { filter: { metric: { content: 'purchase', ...spec, sum: { field: 'value' } } } },
      { group: { by: 'channel' }, asOf: '2026-08-18' }))[0]?.value
    expect(await only({ since: '2026-01-01' })).toBe(110)
    expect(await only({ since: '2026-01-01', until: '2026-06-01' })).toBe(100)
    expect(await only({ until: '2025-06-01' })).toBe(1000)
  })

  it('points at `last`/`since`/`until` when a DATE is handed to `window`', async () => {
    // The error that cost the reporter the afternoon: it described what `window` is
    // and never said where a time bound lives.
    await expect(paid({ window: { between: ['2026-02-16', '2026-08-18'] } }))
      .rejects.toThrow(/bound events by TIME.*`last` for relative.*`since`\/`until` for absolute/s)
    await expect(paid({ window: { after: '2026-02-16' } }))
      .rejects.toThrow(/bound events by TIME/)
  })

  it('tells `window: { last }` to move up a level, and shows the move', async () => {
    await expect(paid({ window: { last: '6M' } }))
      .rejects.toThrow(/`last` is a METRIC key, not a window one — move it up/)
  })

  it('names the unit when the duration is unparseable', async () => {
    await expect(paid({ last: '6m' })).rejects.toThrow(/bad duration "6m" for `last`/)
    await expect(paid({ last: 'six months' })).rejects.toThrow(/bad duration "six months"/)
  })

  it('still anchors on a fact, which is what `window` is for', async () => {
    // The pointer must not have broken the feature it points away from.
    const r = await paid({ window: { after: { fact: 'signed_up_at' } } })
    expect(Array.isArray(r)).toBe(true)
  })
})

// TWO dimensions in one query. "Revenue per studio per month" needed one query per
// period before this, and the results could not be compared without reassembling them
// by hand — `group.by: ["month","attr:location"]` answered "unknown bucket
// month,attr:location".
describe('selector group: cross-tabulating two dimensions', () => {
  const purchase = (agg) => ({ filter: { metric: { content: 'purchase', ...agg } } })
  const byName = (r) => Object.fromEntries(r.series.map(s => [s.name, asMap(s.points)]))

  beforeEach(async () => {
    // Two studios, two months, distinct values so every cell is identifiable.
    const p1 = await newPassport(), p2 = await newPassport()
    const rows = [
      [p1, '2026-05-01', 'sofia', 10], [p1, '2026-05-02', 'sofia', 5],
      [p1, '2026-06-01', 'sofia', 20], [p2, '2026-05-01', 'plovdiv', 100],
      [p2, '2026-06-01', 'plovdiv', 200], [p2, '2026-06-02', 'burgas', 1],
    ]
    for (const [p, ts, location, value] of rows) {
      await db('whitebox_awareness_exposures').insert({
        passport_id: p, ts: d(ts), channel: 'web', direction: 'expression', text: 'x',
        content_id: 'purchase', meta: JSON.stringify({ value, location }),
      })
    }
  })

  it('returns one series per value of the SECOND dimension, bucketed by the first', async () => {
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['month', 'attr:location'] } })
    expect(r.multi).toBe(true)
    expect(r.aggregate).toBe('sum')
    expect(byName(r)).toEqual({
      sofia:   { '2026-05': 15, '2026-06': 20 },
      plovdiv: { '2026-05': 100, '2026-06': 200 },
      burgas:  { '2026-06': 1 },
    })
  })

  it('the ORDER of the dimensions decides which is the axis', async () => {
    // Swapped: one series per month, bucketed by studio. Same numbers, transposed —
    // and a chart drawn with the axes the wrong way round is not a small mistake.
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['attr:location', 'month'] } })
    expect(byName(r)).toEqual({
      '2026-05': { sofia: 15, plovdiv: 100 },
      '2026-06': { sofia: 20, plovdiv: 200, burgas: 1 },
    })
  })

  it('caps the SERIES dimension and says that it did, naming the knob', async () => {
    // Without a cap, `['month','attr:location']` returned 123 series on live data:
    // unreadable, and indistinguishable from a complete answer.
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['month', 'attr:location'], seriesLimit: 2 } })
    expect(r.series).toHaveLength(2)
    expect(r.seriesTruncated).toMatchObject({ shown: 2, cap: 2, dimension: 'attr:location' })
    // The notice has to say how to see more. Reporting "showing 2" and nothing else was
    // read as a hard ceiling — a 125-studio network apparently visible 6 at a time.
    expect(r.seriesTruncated.raise).toMatch(/group\.seriesLimit \(up to 200\)/)
    expect(r.seriesTruncated.raise).toMatch(/`limit` bounds the other dimension/)
    // Top-N BY VALUE, so the two biggest studios survive, not an arbitrary two.
    expect(Object.keys(byName(r)).sort()).toEqual(['plovdiv', 'sofia'])
  })

  it('`limit` and `seriesLimit` bound different dimensions, independently', async () => {
    // The reported confusion: `limit` was expected to cap the series too, so lowering it
    // changed the months and left the same 6 studios.
    const at = (opts) => selector.resolve(purchase({ sum: { field: 'value' } }), { group: opts })
    const few = await at({ by: ['month', 'attr:location'], limit: 1, seriesLimit: 3 })
    expect(few.series).toHaveLength(3)                       // three studios
    for (const s of few.series) expect(s.points).toHaveLength(1)   // one month each

    const wide = await at({ by: ['month', 'attr:location'], limit: 2, seriesLimit: 3 })
    expect(wide.series).toHaveLength(3)                      // unchanged by `limit`
  })

  it('accepts a seriesLimit far above the default, and refuses an impossible one', async () => {
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['month', 'attr:location'], seriesLimit: 100 } })
    expect(r.series).toHaveLength(3)              // all three, nothing truncated
    expect(r.seriesTruncated).toBeUndefined()

    const bad = (n) => selector.resolve(purchase({ count: {} }),
      { group: { by: ['month', 'attr:location'], seriesLimit: n } })
    await expect(bad(0)).rejects.toThrow(/between 1 and 200/)
    await expect(bad(201)).rejects.toThrow(/between 1 and 200/)
    await expect(bad(2.5)).rejects.toThrow(/whole number/)
  })

  it('says nothing about truncation when nothing was truncated', async () => {
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['month', 'attr:location'], seriesLimit: 10 } })
    expect(r.seriesTruncated).toBeUndefined()
  })

  it('`limit` still bounds the x-axis, independently of the series cap', async () => {
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['month', 'attr:location'], limit: 1 } })
    for (const s of r.series) expect(Object.keys(s.points)).toHaveLength(1)
  })

  it('gives ONE cohortSize — every series is the same cohort sliced again', async () => {
    // Not one per series: they are not separate cohorts, and a per-series "size" would
    // invite dividing a slice by itself.
    const r = await selector.resolve(purchase({ distinct_passports: {} }),
      { group: { by: ['month', 'attr:location'], cohortSize: true } })
    expect(r.cohortSize).toBe(2)
    expect(r.sizes).toBeUndefined()
  })

  it('cross-tabs a FACT dimension against an event one', async () => {
    const p = await newPassport()
    await db('whitebox_awareness_exposures').insert({
      passport_id: p, ts: d('2026-05-01'), channel: 'web', direction: 'expression',
      text: 'x', content_id: 'purchase', meta: JSON.stringify({ value: 7, location: 'sofia' }),
    })
    await facts.record({ passport_id: p, key: 'tier', value: 'gold', source: 't' })
    const r = await selector.resolve(purchase({ sum: { field: 'value' } }),
      { group: { by: ['fact:tier', 'attr:location'] } })
    // The fixture's own rows have no `tier`, so they bucket as null — an absent value
    // is a real bucket here, which is the point of the LEFT join.
    expect(byName(r).sofia).toEqual({ gold: 7, null: 35 })   // 10 + 5 + 20, all months
  })

  it('refuses the shapes that cannot mean anything', async () => {
    const bad = (opts) => selector.resolve(purchase({ count: {} }), { group: opts })
    await expect(bad({ by: ['month', 'attr:location', 'channel'] }))
      .rejects.toThrow(/exactly two to cross-tabulate.*got 3/s)
    await expect(bad({ by: ['month'] })).rejects.toThrow(/got 1/)
    await expect(bad({ by: ['month', 'month'] })).rejects.toThrow(/both `by` dimensions are "month"/)
    await expect(bad({ by: ['month', 42] })).rejects.toThrow(/must be a string/)
    await expect(bad({ by: ['fact:tier', 'fact:city'] }))
      .rejects.toThrow(/at most one `fact:<key>` dimension/)
  })

  it('refuses to combine with missingAnchor:"bucket" — both want the series', async () => {
    await expect(selector.resolve(
      { filter: { metric: { content: 'purchase', count: {},
        window: { after: { fact: 'tier' }, missingAnchor: 'bucket' } } } },
      { group: { by: ['month', 'attr:location'] } }))
      .rejects.toThrow(/already splits the result into one series per cohort/)
  })
})

// WHEN a bucket first and last saw an event.
//
// earliest/latest order BY event time and return a FIELD's value, so "when did this bucket
// first see anything" had no expression: `column: 'ts'` was refused (AGG_COLS is dwell_ms
// alone, deliberately — an average of a timestamp is a question about buckets), and every
// other shape asked for a value to read. A studio's opening date is min(ts) grouped by
// attr:location and a dormant location is max(ts); both had to be written in raw SQL.
describe('selector group: first_seen / last_seen', () => {
  const purchase = (agg) => ({ filter: { metric: { content: 'purchase', ...agg } } })

  beforeEach(async () => {
    const p = await newPassport()
    await expose(p, { channel: 'web', ts: '2026-05-01', value: 1 })
    await expose(p, { channel: 'web', ts: '2026-05-20', value: 2 })
    await expose(p, { channel: 'email', ts: '2026-06-10', value: 3 })
  })

  it('returns the event TIME, as an ISO instant', async () => {
    const first = await selector.resolve(purchase({ first_seen: {} }), { group: { by: 'channel' } })
    expect(asMap(first)).toEqual({ web: '2026-05-01T00:00:00.000Z', email: '2026-06-10T00:00:00.000Z' })
    const last = await selector.resolve(purchase({ last_seen: {} }), { group: { by: 'channel' } })
    expect(asMap(last)).toEqual({ web: '2026-05-20T00:00:00.000Z', email: '2026-06-10T00:00:00.000Z' })
  })

  it('is NOT coerced through Number(), which would make every value NaN', async () => {
    const r = await selector.resolve(purchase({ first_seen: {} }), { group: { by: 'channel' } })
    for (const row of r) {
      expect(row.value).toEqual(expect.any(String))
      expect(Number.isNaN(Number(row.value))).toBe(true)   // it IS a timestamp, not a number
    }
  })

  it('keeps null for a bucket with nothing in it', async () => {
    // A bucket where nothing matched has no first event, and the epoch would plot as one.
    const r = await selector.resolve(
      { filter: { metric: { content: 'nothing-matches-this', first_seen: {} } } },
      { group: { by: 'channel' } })
    expect(r).toEqual([])
  })

  it('takes NO source — the answer is the time, not a value', async () => {
    // Refused by the ENGINE as well as the validator. Ignoring the source would answer a
    // question about time while naming one about money.
    for (const bad of [{ field: 'value' }, { column: 'dwell_ms' }, { fact: 'ltv' }]) {
      await expect(selector.resolve(purchase({ first_seen: bad }), { group: { by: 'channel' } }))
        .rejects.toThrow(/takes no source — it returns the event TIME/)
    }
    await expect(selector.resolve(purchase({ last_seen: { field: 'value' } }), { group: { by: 'month' } }))
      .rejects.toThrow(/For the value AT the first\/last event use earliest\/latest/)
  })

  it('works on a fact bucket and in a cross-tab', async () => {
    const p = await newPassport()
    await expose(p, { channel: 'web', ts: '2026-04-01', value: 9 })
    await facts.record({ passport_id: p, key: 'tier', value: 'gold', source: 't' })
    const byFact = await selector.resolve(purchase({ first_seen: {} }), { group: { by: 'fact:tier' } })
    expect(asMap(byFact).gold).toBe('2026-04-01T00:00:00.000Z')

    const cross = await selector.resolve(purchase({ last_seen: {} }), { group: { by: ['channel', 'fact:tier'] } })
    expect(cross.multi).toBe(true)
    for (const s of cross.series) for (const pt of s.points) expect(pt.value).toEqual(expect.any(String))
  })
})

// A TIME GRAIN with `limit` is a series, not a ranking.
//
// `limit` switched the ordering to value-desc for every bucket type, so
// `by: 'week', limit: 8` returned the eight BUSIEST weeks in value order — W16, W23, W17,
// W19, W22, W09, W18, W24 on live data. Two things wrong at once: the order, and the
// SELECTION. Those eight weeks are not adjacent, so a line drawn through them joins periods
// with gaps between them and reads as a trend that never happened.
//
// A categorical dimension keeps ranking by value, because there it IS the guardrail: 449
// content urls have no natural order and the interesting ones are the big ones. `order` says
// which, so "the five busiest months" is still expressible — as a ranking, deliberately.
describe('selector group: ordering a time grain', () => {
  const purchases2 = { filter: { metric: { content: 'purchase', count: {} } } }
  const buckets = (r) => r.map(x => x.bucket)

  beforeEach(async () => {
    // Five months. April is the busiest and February the quietest, so a value ordering and
    // a chronological one disagree — and the busiest months are not contiguous.
    const counts = { '2026-01': 2, '2026-02': 1, '2026-03': 3, '2026-04': 5, '2026-05': 4 }
    for (const [month, n] of Object.entries(counts)) {
      const p = await newPassport()
      for (let i = 0; i < n; i++) await expose(p, { ts: `${month}-0${i + 1}` })
    }
  })

  it('returns the most RECENT n, in order, when limited', async () => {
    const r = await selector.resolve(purchases2, { group: { by: 'month', limit: 3 } })
    expect(buckets(r)).toEqual(['2026-03', '2026-04', '2026-05'])
  })

  it('is chronological with no limit, as it always was', async () => {
    const r = await selector.resolve(purchases2, { group: { by: 'month' } })
    expect(buckets(r)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'])
  })

  it('ranks by value only when ASKED, which keeps "the busiest n" expressible', async () => {
    const r = await selector.resolve(purchases2, { group: { by: 'month', limit: 3, order: 'value' } })
    expect(buckets(r)).toEqual(['2026-04', '2026-05', '2026-03'])   // 5, 4, 3
  })

  it('leaves a CATEGORICAL dimension ranked by value', async () => {
    // The guardrail this ordering exists for. Unchanged.
    const a = await newPassport()
    await expose(a, { channel: 'email', ts: '2026-06-01' })
    await expose(a, { channel: 'email', ts: '2026-06-02' })
    await expose(a, { channel: 'sms', ts: '2026-06-03' })
    const r = await selector.resolve(purchases2, { group: { by: 'channel', limit: 2 } })
    expect(buckets(r)[0]).toBe('web')        // the biggest bucket first
    expect(r[0].value).toBeGreaterThanOrEqual(r[1].value)
  })

  it('lets a categorical dimension be ordered by bucket on request', async () => {
    const r = await selector.resolve(purchases2, { group: { by: 'channel', order: 'bucket' } })
    expect(buckets(r)).toEqual([...buckets(r)].sort())
  })

  it('applies to a FACT aggregate over a time grain too', async () => {
    // The two-level path had its own copy of the ordering and the same defect.
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'ltv', value: 10, source: 't' })
    for (const ts of ['2026-01-05', '2026-04-05', '2026-05-05']) await expose(p, { ts })
    const r = await selector.resolve(
      { filter: { metric: { content: 'purchase', avg: { fact: 'ltv' } } } },
      { group: { by: 'month', limit: 2 } })
    expect(buckets(r)).toEqual(['2026-04', '2026-05'])
  })

  it('applies to the x-axis of a cross-tab', async () => {
    const r = await selector.resolve(purchases2,
      { group: { by: ['month', 'channel'], limit: 2, seriesLimit: 1 } })
    expect(buckets(r.series[0].points)).toEqual(['2026-04', '2026-05'])
  })

  it('names the two orders when given something else', async () => {
    await expect(selector.resolve(purchases2, { group: { by: 'month', order: 'chronological' } }))
      .rejects.toThrow(/`order` must be bucket or value/)
    await expect(selector.resolve(purchases2, { group: { by: 'month', order: 'desc' } }))
      .rejects.toThrow(/bucket` is chronological for a time grain/)
  })
})

describe('selector group: content buckets', () => {
  const withUrl = async (passport_id, { ts, url }) => {
    await db('whitebox_awareness_exposures').insert({
      passport_id, ts: d(ts), channel: 'web', direction: 'expression',
      text: 'x', content_id: 'purchase', content_url: url,
    })
  }
  const purchasesBy = (by) => selector.resolve(
    { filter: { metric: { content: 'purchase', count: {} } } }, { group: { by } })

  it('strips the query string, so one page is ONE bucket', async () => {
    const p = await newPassport()
    // Click IDs are unique per click by design — gclid alone had 76,836 distinct
    // values on the GPoint data, so raw bucketing gives one row per click.
    await withUrl(p, { ts: '2026-05-01', url: 'https://x.test/pricing?gclid=aaa' })
    await withUrl(p, { ts: '2026-05-02', url: 'https://x.test/pricing?gclid=bbb&utm_source=ads' })
    await withUrl(p, { ts: '2026-05-03', url: 'https://x.test/pricing' })
    expect(asMap(await purchasesBy('content_url'))).toEqual({ 'https://x.test/pricing': 3 })
  })

  it('keeps different paths apart', async () => {
    const p = await newPassport()
    await withUrl(p, { ts: '2026-05-01', url: 'https://x.test/a?utm_source=1' })
    await withUrl(p, { ts: '2026-05-02', url: 'https://x.test/b?utm_source=2' })
    expect(asMap(await purchasesBy('content_url'))).toEqual({ 'https://x.test/a': 1, 'https://x.test/b': 1 })
  })

  it('does not carry a secret into a bucket label', async () => {
    const p = await newPassport()
    // These URLs really did hold payment_intent_client_secret across 2,386 rows. A
    // bucket label is logged, cached, charted and shipped to an LLM to summarise.
    await withUrl(p, { ts: '2026-05-01', url: 'https://x.test/pay?payment_intent_client_secret=pi_secret_xyz' })
    const r = await purchasesBy('content_url')
    expect(r[0].bucket).toBe('https://x.test/pay')
    expect(JSON.stringify(r)).not.toContain('pi_secret_xyz')
  })

  it('buckets by content_hash too, unmodified — it is already opaque', async () => {
    const p = await newPassport()
    await db('whitebox_awareness_exposures').insert({
      passport_id: p, ts: d('2026-05-01'), channel: 'web', direction: 'expression',
      text: 'x', content_id: 'purchase', content_hash: 'abc123',
    })
    expect(asMap(await purchasesBy('content_hash'))).toEqual({ abc123: 1 })
  })

  it('names content_url in the unknown-bucket error', async () => {
    await fixture()
    await expect(purchasesBy('content_urls')).rejects.toThrow(/content_url/)
  })
})

describe('selector group: aggregates over a value', () => {
  // fixture(): p1 has purchases of 100 and 50 on 05-01 (web); p2 has 200 on 05-02
  // (email) plus a non-purchase web event carrying no value at all.
  const all = (agg) => ({ filter: { metric: { content: 'purchase', ...agg } } })

  it('sums, averages and bounds a meta attribute per bucket', async () => {
    await fixture()
    expect(asMap(await selector.resolve(all({ sum: { field: 'value' } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 150, '2026-05-02': 200 })
    expect(asMap(await selector.resolve(all({ avg: { field: 'value' } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 75, '2026-05-02': 200 })
    expect(asMap(await selector.resolve(all({ min: { field: 'value' } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 50, '2026-05-02': 200 })
    expect(asMap(await selector.resolve(all({ max: { field: 'value' } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 100, '2026-05-02': 200 })
  })

  it('takes a median and an arbitrary percentile', async () => {
    await fixture()
    expect(asMap(await selector.resolve(all({ median: { field: 'value' } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 75, '2026-05-02': 200 })      // interpolated between 50 and 100
    expect(asMap(await selector.resolve(all({ percentile: { field: 'value', p: 0 } }), { group: { by: 'day' } })))
      .toEqual({ '2026-05-01': 50, '2026-05-02': 200 })
  })

  it('earliest/latest answer "the value at" — not the smallest', async () => {
    const p = await newPassport()
    // Descending in time, so min() and earliest() must disagree.
    await expose(p, { ts: '2026-06-01', value: 90 })
    await expose(p, { ts: '2026-06-02', value: 10 })
    const at = (agg) => selector.resolve(all(agg), { group: { by: 'month' } })
    expect(asMap(await at({ earliest: { field: 'value' } }))).toEqual({ '2026-06': 90 })
    expect(asMap(await at({ latest: { field: 'value' } }))).toEqual({ '2026-06': 10 })
    expect(asMap(await at({ min: { field: 'value' } }))).toEqual({ '2026-06': 10 })
  })

  it('reads an exposure column instead, when asked', async () => {
    await fixture()
    const r = await selector.resolve(all({ avg: { column: 'dwell_ms' } }), { group: { by: 'day' } })
    expect(r.length).toBeGreaterThan(0)      // the fixture leaves dwell_ms null → avg is null
  })

  it('a bucket where nothing carries the field is NULL, not 0', async () => {
    await fixture()
    // 0 would plot as a real low value; null says "no data" and the caller can too.
    const r = await selector.resolve(all({ avg: { field: '__absent__' } }), { group: { by: 'day' } })
    expect(r.every((x) => x.value === null)).toBe(true)
    // sum is the exception and stays 0 — a sum of nothing genuinely is zero.
    const sums = await selector.resolve(all({ sum: { field: '__absent__' } }), { group: { by: 'day' } })
    expect(sums.every((x) => x.value === 0)).toBe(true)
  })

  it('ignores non-numeric values rather than failing the query', async () => {
    const p = await newPassport()
    await expose(p, { ts: '2026-07-01', value: 10 })
    await db('whitebox_awareness_exposures').insert({
      passport_id: p, ts: d('2026-07-02'), channel: 'web', direction: 'expression',
      text: 'x', content_id: 'purchase', meta: JSON.stringify({ value: 'n/a' }),
    })
    // One "n/a" must not abort with invalid-input-syntax, nor count as a zero.
    expect(asMap(await selector.resolve(all({ avg: { field: 'value' } }), { group: { by: 'month' } })))
      .toEqual({ '2026-07': 10 })
  })

  it('names the collision: `latest`, because `last` is the lookback window', async () => {
    await fixture()
    // `{ last: {...} }` is a WINDOW, so it can never also be an aggregate — it parses
    // as a filter and then reports no aggregate at all.
    await expect(selector.resolve({ filter: { metric: { content: 'purchase', last: { field: 'value' } } } }, { group: { by: 'day' } }))
      .rejects.toThrow(/needs one aggregate/)
  })

  it('rejects an unusable source', async () => {
    await fixture()
    await expect(selector.resolve(all({ avg: {} }), { group: { by: 'day' } })).rejects.toThrow(/needs a `field`/)
    await expect(selector.resolve(all({ avg: { column: 'ts' } }), { group: { by: 'day' } })).rejects.toThrow(/must be one of dwell_ms/)
    await expect(selector.resolve(all({ avg: { field: 'value', column: 'dwell_ms' } }), { group: { by: 'day' } })).rejects.toThrow(/not field \+ column/)
    await expect(selector.resolve(all({ percentile: { field: 'value' } }), { group: { by: 'day' } })).rejects.toThrow(/between 0 and 1/)
  })
})

describe('selector group: fact:<key> buckets', () => {
  it('buckets by a fact value', async () => {
    const { p1, p2 } = await fixture()
    await facts.record({ passport_id: p1, key: 'tier', value: 'pro', source: 't' })
    await facts.record({ passport_id: p2, key: 'tier', value: 'free', source: 't' })
    const series = await selector.resolve(purchases, { group: { by: 'fact:tier' } })
    expect(asMap(series)).toEqual({ pro: 2, free: 1 })
  })

  it('puts a passport with no such fact in a null bucket, rather than dropping it', async () => {
    const { p1 } = await fixture()
    await facts.record({ passport_id: p1, key: 'tier', value: 'pro', source: 't' })
    const series = await selector.resolve(purchases, { group: { by: 'fact:tier' } })
    // p2 purchased too and has no `tier` — an absent value is information, and
    // dropping the row would silently change the total.
    const total = series.reduce((a, b) => a + b.value, 0)
    expect(total).toBe(3)
    expect(series.find((s) => s.bucket == null)?.value).toBe(1)
  })

  it('uses the CURRENT value, the same rule the fact predicate uses', async () => {
    const { p1 } = await fixture()
    await facts.record({ passport_id: p1, key: 'tier', value: 'free', source: 't', observed_at: new Date('2026-01-01') })
    await facts.record({ passport_id: p1, key: 'tier', value: 'pro', source: 't', observed_at: new Date('2026-04-01') })
    const series = await selector.resolve(purchases, { group: { by: 'fact:tier' } })
    // latest wins — so a breakdown and `{ fact: { tier: { eq: 'pro' } } }` agree
    expect(series.find((s) => s.bucket === 'pro')?.value).toBe(2)
    expect(series.find((s) => s.bucket === 'free')).toBeUndefined()
  })

  it('bands a numeric fact into ranges', async () => {
    const { p1, p2 } = await fixture()
    await facts.record({ passport_id: p1, key: 'age', value: 34, source: 't' })
    await facts.record({ passport_id: p2, key: 'age', value: 41, source: 't' })
    const series = await selector.resolve(purchases, { group: { by: 'fact:age', band: 5 } })
    expect(asMap(series)).toEqual({ '30-34': 2, '40-44': 1 })
  })

  it('bands non-numeric values to null instead of erroring', async () => {
    const { p1 } = await fixture()
    await facts.record({ passport_id: p1, key: 'age', value: 'unknown', source: 't' })
    const series = await selector.resolve(purchases, { group: { by: 'fact:age', band: 5 } })
    // one bad row must not empty the chart
    expect(series.reduce((a, b) => a + b.value, 0)).toBe(3)
  })

  it('rejects band on a non-fact bucket, and a non-positive band', async () => {
    await fixture()
    await expect(selector.resolve(purchases, { group: { by: 'day', band: 5 } }))
      .rejects.toThrow(/only applies to a `fact:<key>` bucket/)
    await expect(selector.resolve(purchases, { group: { by: 'fact:age', band: 0 } }))
      .rejects.toThrow(/positive number/)
  })

  it('names fact:<key> in the unknown-bucket error', async () => {
    await fixture()
    await expect(selector.resolve(purchases, { group: { by: 'wibble' } })).rejects.toThrow(/fact:<key>/)
  })
})

describe('selector group (time-series + breakdown, §7)', () => {
  it('time-series: count of purchases by day', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' } })
    expect(asMap(series)).toEqual({ '2026-05-01': 2, '2026-05-02': 1 })
  })

  it('collapses same-week events; groups by month', async () => {
    await fixture()
    const byWeek = await selector.resolve(purchases, { group: { by: 'week' } })
    expect(byWeek).toHaveLength(1)                     // 05-01 (Fri) + 05-02 (Sat) are one ISO week
    expect(byWeek[0]).toMatchObject({ value: 3 })
    expect(byWeek[0].bucket).toMatch(/^2026-W\d{2}$/)  // ISO year-week label
    const byMonth = await selector.resolve(purchases, { group: { by: 'month' } })
    expect(asMap(byMonth)).toEqual({ '2026-05': 3 })
  })

  it('breakdown: count of purchases by channel', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'channel' } })
    expect(asMap(series)).toEqual({ web: 2, email: 1 })   // p2's web event was pricing, not purchase
  })

  it('sum aggregate bucketed by day', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { content: 'purchase', sum: { field: 'value' } } } }, { group: { by: 'day' } })
    expect(asMap(series)).toEqual({ '2026-05-01': 150, '2026-05-02': 200 })
  })

  it('distinct_passports breakdown by channel', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { content: 'purchase', distinct_passports: {} } } }, { group: { by: 'channel' } })
    expect(asMap(series)).toEqual({ web: 1, email: 1 })
  })

  it('restricts to a caller-provided scope (a cohort)', async () => {
    const { p1 } = await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' }, scope: [p1] })
    expect(asMap(series)).toEqual({ '2026-05-01': 2 })   // only p1's events
  })

  it('honours asOf (ignores future events)', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' }, asOf: '2026-05-01T23:59:59Z' })
    expect(asMap(series)).toEqual({ '2026-05-01': 2 })   // 05-02 events excluded
  })

  it('errors when group has no metric to aggregate', async () => {
    await fixture()
    await expect(selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { group: { by: 'day' } }))
      .rejects.toThrow(/requires a `metric`/)
  })

  it('errors on an unknown bucket', async () => {
    await fixture()
    await expect(selector.resolve(purchases, { group: { by: 'banana' } })).rejects.toThrow(/unknown bucket/)
  })
})
