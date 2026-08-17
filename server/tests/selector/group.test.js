import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
