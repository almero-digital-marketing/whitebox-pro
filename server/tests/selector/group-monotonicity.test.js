import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as selector from '../../src/selector/index.js'

// The monotonicity invariant for `group` (§7):
//
//   for any grouped query Q and any filter F that NARROWS the population,
//   totalAggregate(Q + F) <= totalAggregate(Q), and per shared bucket too.
//
// Why a property test rather than a fixed repro: a filter that *raises* an
// aggregate means the engine computed something other than what it was asked,
// and the dangerous instances of that are the clause combinations nobody has
// tried. So this sweeps the whole matrix of bucket × aggregate × narrowing
// clause instead of asserting one pair of numbers.
//
// This encodes an invariant, not a bug. It is a REGRESSION GUARD and is expected
// to pass: an audit of the GPoint dataset (14 Aug 2026) that appeared to show a
// violation — a session-filtered day returning 13,012 against a claimed
// unfiltered 9,645 — did not reproduce. The true unfiltered count for that day
// was 63,805; the 9,645 baseline came from a differently-constrained query. Both
// mechanisms that could raise an aggregate were also ruled out: whitebox_sessions.id
// is a real PRIMARY KEY (so the LEFT JOIN in metric.js cannot fan out), and the
// time-grain path uses the same aggregate expression as every other bucket.
//
// Every aggregate here is non-negative and every clause is conjunctive, so the
// invariant is unconditional — if this ever fails, the resolver is switching
// aggregates or losing a join condition based on clause combination.

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async (id) => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = (s) => new Date(s)
const asMap = (series) => Object.fromEntries(series.map((r) => [r.bucket, r.value]))
const total = (series) => series.reduce((a, b) => a + (b.value || 0), 0)

// Buckets spanning every branch of bucketSql: time grains, exposure columns,
// the session join, and an open meta attribute.
const BUCKETS = ['day', 'week', 'month', 'channel', 'direction', 'attr:event', 'session:utm_source']
// Every group aggregate except `sum` (which needs a `field`; covered separately below).
const AGGS = ['count', 'distinct_passports', 'distinct_sessions', 'sum_dwell_ms']
// Clauses that can only ever REMOVE rows.
const NARROWERS = [
  { name: 'channel=web', clause: { channel: 'web' } },
  { name: 'direction=expression', clause: { direction: 'expression' } },
  { name: 'attrs.event=purchase', clause: { attrs: { event: 'purchase' } } },
  { name: 'session.utm_source in[adwords]', clause: { session: { utm_source: { in: ['adwords'] } } } },
  { name: 'session.utm_source present', clause: { session: { utm_source: { present: true } } } },
  { name: 'content=purchase', clause: { content: 'purchase' } },
]

beforeAll(async () => {
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
  await db.raw('TRUNCATE TABLE whitebox_awareness_exposures, whitebox_sessions, whitebox_passports CASCADE')
  await fixture()
})
afterAll(async () => { await db.destroy() })

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}

async function newSession(passport_id, utm_source, started_at) {
  const [row] = await db('whitebox_sessions')
    .insert({ passport_id, utm_source, started_at: d(started_at) })
    .returning('id')
  return typeof row === 'object' ? row.id : row
}

async function expose(passport_id, { ts, channel = 'web', direction = 'expression', content = 'purchase', session_id = null, dwell_ms = 100, event = 'purchase' }) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, session_id, ts: d(ts), channel, direction, text: 'x', content_id: content,
    dwell_ms, meta: JSON.stringify({ event }),
  })
}

// Deliberately heterogeneous: several people, attributed and unattributed
// sessions, multiple channels/directions/events, and rows spread across days,
// ISO weeks and months — so every bucket has >1 group and every narrower
// actually removes something (a filter that removes nothing proves nothing).
async function fixture() {
  const p1 = await newPassport(), p2 = await newPassport(), p3 = await newPassport()
  const sAd = await newSession(p1, 'adwords', '2026-05-01')
  const sMeta = await newSession(p2, 'meta', '2026-05-02')
  const sNull = await newSession(p3, null, '2026-06-10')

  await expose(p1, { ts: '2026-05-01', channel: 'web', session_id: sAd })
  await expose(p1, { ts: '2026-05-01', channel: 'web', session_id: sAd, event: 'view', content: 'pricing' })
  await expose(p2, { ts: '2026-05-02', channel: 'mail', direction: 'exposure', session_id: sMeta })
  await expose(p2, { ts: '2026-05-14', channel: 'web', session_id: sMeta, dwell_ms: 250 })
  await expose(p3, { ts: '2026-06-10', channel: 'web', session_id: sNull, event: 'view', content: 'pricing' })
  await expose(p3, { ts: '2026-06-11', channel: 'voip', direction: 'conversation', session_id: null, event: 'call', content: 'call' })
}

describe('selector group — monotonicity invariant (regression guard)', () => {
  // Sanity: the fixture must actually produce multi-bucket, non-zero baselines,
  // otherwise every assertion below would hold trivially (0 <= 0).
  it('fixture yields non-trivial baselines for every bucket', async () => {
    for (const by of BUCKETS) {
      const series = await selector.resolve({ filter: { metric: { count: {} } } }, { group: { by } })
      expect(total(series), `${by} total`).toBeGreaterThan(0)
      expect(series.length, `${by} bucket count`).toBeGreaterThan(1)
    }
  })

  for (const by of BUCKETS) {
    it(`by:${by} — no narrowing clause raises the aggregate`, async () => {
      for (const agg of AGGS) {
        const base = await selector.resolve({ filter: { metric: { [agg]: {} } } }, { group: { by } })
        const baseMap = asMap(base)
        const baseTotal = total(base)

        for (const n of NARROWERS) {
          const narrowed = await selector.resolve(
            { filter: { metric: { [agg]: {}, ...n.clause } } },
            { group: { by } },
          )
          const label = `by:${by} agg:${agg} +${n.name}`
          expect(total(narrowed), `${label} — total`).toBeLessThanOrEqual(baseTotal)
          for (const { bucket, value } of narrowed) {
            // A narrowed query must not invent a bucket the unfiltered one lacks…
            expect(baseMap, `${label} — bucket "${bucket}" absent unfiltered`).toHaveProperty(String(bucket))
            // …nor exceed it within a bucket they share.
            expect(value, `${label} — bucket "${bucket}"`).toBeLessThanOrEqual(baseMap[bucket])
          }
        }
      }
    })
  }

  it('sum: narrowing never raises a non-negative sum', async () => {
    const spec = (extra) => ({ filter: { metric: { sum: { field: 'dwell_ms' }, ...extra } } })
    for (const by of ['day', 'channel']) {
      const baseTotal = total(await selector.resolve(spec({}), { group: { by } }))
      for (const n of NARROWERS) {
        const got = total(await selector.resolve(spec(n.clause), { group: { by } }))
        expect(got, `sum by:${by} +${n.name}`).toBeLessThanOrEqual(baseTotal)
      }
    }
  })

  // The scope array is itself a narrowing device — restricting to a subset of
  // passports must behave the same way.
  it('scope narrowing never raises the aggregate', async () => {
    const one = (await db('whitebox_passports').select('id').limit(1))[0].id
    for (const by of BUCKETS) {
      const all = total(await selector.resolve({ filter: { metric: { count: {} } } }, { group: { by } }))
      const scoped = total(await selector.resolve({ filter: { metric: { count: {} } } }, { group: { by }, scope: [one] }))
      expect(scoped, `scoped by:${by}`).toBeLessThanOrEqual(all)
    }
  })
})
