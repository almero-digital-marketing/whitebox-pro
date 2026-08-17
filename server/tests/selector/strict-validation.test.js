import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

// Strict clause validation: a clause the resolver does not honour must THROW,
// never be accepted-and-ignored. An ignored filter returns a confident answer to
// a different question, and the caller has nothing in the payload to detect it
// with — so silence is the failure mode worth engineering against.
//
// Each case below was a real silent drop, found by auditing the GPoint dataset
// on 14 Aug 2026.

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async (id) => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE')
})

async function seed() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  await db('whitebox_awareness_exposures').insert({
    passport_id: id, ts: new Date('2026-05-01'), channel: 'web', direction: 'expression',
    text: 'x', content_id: 'purchase', dwell_ms: 10, meta: JSON.stringify({ event: 'purchase' }),
  })
  await facts.record({ passport_id: id, key: 'plan_tier', value: 'pro', type: 'text', source: 'test' })
  return id
}

const metricOnly = { filter: { metric: { count: {} } } }

describe('selector — strict clause validation', () => {
  describe('filter clause arity', () => {
    // The ordered if-chain in filter.js evaluated `fact` and discarded `metric`;
    // resolveGroup did the opposite. Same input, two different half-answers.
    it('rejects `fact` and `metric` as siblings in one clause', async () => {
      await seed()
      await expect(selector.resolve({
        filter: { fact: { plan_tier: { eq: 'pro' } }, metric: { count: { gte: 1 } } },
      }, { projection: 'count' })).rejects.toThrow(/exactly one of/)
    })

    it('names the explicit AND form in the error', async () => {
      await seed()
      await expect(selector.resolve({
        filter: { fact: { plan_tier: { eq: 'pro' } }, metric: { count: { gte: 1 } } },
      }, { projection: 'count' })).rejects.toThrow(/\{ all: \[/)
    })

    it('accepts the same two conditions under `all`', async () => {
      const id = await seed()
      const r = await selector.resolve({
        filter: { all: [{ fact: { plan_tier: { eq: 'pro' } } }, { metric: { count: { gte: 1 } } }] },
      }, { projection: 'people' })
      expect(r.passports.map((p) => p.id)).toEqual([id])
    })

    it('rejects an unknown key inside a clause', async () => {
      await seed()
      await expect(selector.resolve({ filter: { facts: { plan_tier: { eq: 'pro' } } } }, { projection: 'count' }))
        .rejects.toThrow(/unknown key "facts"/)
    })

    it('still rejects a nested sibling pair inside `all`', async () => {
      await seed()
      await expect(selector.resolve({
        filter: { all: [{ fact: { plan_tier: { eq: 'pro' } }, metric: { count: {} } }] },
      }, { projection: 'count' })).rejects.toThrow(/exactly one of/)
    })
  })

  describe('group', () => {
    // resolveGroup forwards only `by` and `limit`; `grain`/`key` were dropped, so
    // a grain request returned raw-timestamp buckets and a top-N-by-value order.
    it('rejects group.grain (the grain is chosen by `by`)', async () => {
      await seed()
      await expect(selector.resolve(metricOnly, { group: { by: 'day', grain: 'day' } }))
        .rejects.toThrow(/unknown key "grain"/)
    })

    it('rejects group.key', async () => {
      await seed()
      await expect(selector.resolve(metricOnly, { group: { by: 'day', key: 'first_booked_at' } }))
        .rejects.toThrow(/unknown key "key"/)
    })

    it('still accepts by + limit', async () => {
      await seed()
      const series = await selector.resolve(metricOnly, { group: { by: 'day', limit: 5 } })
      expect(series).toHaveLength(1)
      expect(series[0]).toMatchObject({ bucket: '2026-05-01', value: 1 })
    })

    // The ~550x error: a cohort-restricted breakdown silently returned global totals.
    it('still rejects `{ metric, fact }` as siblings in ONE clause', async () => {
      await seed()
      // Not a grouping rule — a clause carries exactly one of all/any/not/fact/metric,
      // and this shape is refused by filter.js wherever it appears. `all` is how AND
      // is written, and that form IS accepted when grouping (see below).
      await expect(selector.resolve({
        filter: { metric: { count: {} }, fact: { plan_tier: { eq: 'pro' } } },
      }, { group: { by: 'day' } })).rejects.toThrow(/exactly one of/)
    })

    it('ACCEPTS a cohort clause beside the metric via `all`, and applies it', async () => {
      await seed()                                  // one 'pro' passport with an exposure
      // A second passport on a different tier, so there is something for the cohort
      // to exclude — with only the seeded 'pro' row, a narrowed series and the base
      // are identical and the assertion would pass without the filter doing anything.
      const other = crypto.randomUUID()
      await db('whitebox_passports').insert({ id: other })
      await db('whitebox_awareness_exposures').insert({
        passport_id: other, ts: new Date('2026-05-01'), channel: 'web', direction: 'expression',
        text: 'y', content_id: 'purchase', dwell_ms: 10, meta: JSON.stringify({ event: 'purchase' }),
      })
      await facts.record({ passport_id: other, key: 'plan_tier', value: 'free', type: 'text', source: 'test' })

      const sum = (r) => (r || []).reduce((acc, x) => acc + (x.value || 0), 0)
      const all = await selector.resolve({ filter: { metric: { count: {} } } }, { group: { by: 'day' } })
      const pro = await selector.resolve({
        filter: { all: [{ metric: { count: {} } }, { fact: { plan_tier: { eq: 'pro' } } }] },
      }, { group: { by: 'day' } })
      expect(sum(all)).toBe(2)
      expect(sum(pro)).toBe(1)                      // the cohort actually narrowed it
    })

    it('a cohort clause matching nobody gives an empty series, not the base', async () => {
      await seed()
      const r = await selector.resolve({
        filter: { all: [{ metric: { count: {} } }, { fact: { plan_tier: { eq: '__none__' } } }] },
      }, { group: { by: 'day' } })
      expect(r).toEqual([])
    })

    it('rejects selector.about when grouping (it does not rank a series)', async () => {
      await seed()
      await expect(selector.resolve({ ...metricOnly, about: 'pricing' }, { group: { by: 'day' } }))
        .rejects.toThrow(/not applied when grouping/)
    })

    it('keeps rejecting a group with no metric', async () => {
      await seed()
      await expect(selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { group: { by: 'day' } }))
        .rejects.toThrow(/requires a `metric`/)
    })

    // scope IS honoured — it must not be swept up by the new checks.
    it('still applies scope to a grouped query', async () => {
      const id = await seed()
      const other = crypto.randomUUID()
      await db('whitebox_passports').insert({ id: other })
      expect(await selector.resolve(metricOnly, { group: { by: 'day' }, scope: [id] })).toHaveLength(1)
      expect(await selector.resolve(metricOnly, { group: { by: 'day' }, scope: [other] })).toHaveLength(0)
    })
  })
})
