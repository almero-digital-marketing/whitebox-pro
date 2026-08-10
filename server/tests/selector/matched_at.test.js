import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const iso = v => (v == null ? null : new Date(v).toISOString())

// about/judge stubs (so we can assert they produce no matched_at)
let aboutMap = {}
let verdictMap = {}
const awareness = {
  population: async ({ query }) => ({ passports: (aboutMap[query] || []).map(passport_id => ({ passport_id })) }),
  recall: async ({ passport_id }) => [{ channel: 'web', direction: 'expression', text: passport_id }],
}
const ai = { object: async (_s, user) => { for (const [id, v] of Object.entries(verdictMap)) if (user.includes(id)) return v; return { match: false, score: 0 } } }

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness, ai, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  aboutMap = {}; verdictMap = {}
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
const matchedAt = (res, id) => res.passports.find(p => p.id === id)?.matched_at
async function expose(passport_id, ts) {
  await db('whitebox_awareness_exposures').insert({ passport_id, ts: d(ts), channel: 'web', direction: 'expression', text: 'x' })
}

describe('selector matched_at (the funnel anchor)', () => {
  it('value-op fact → matched_at is the fact’s observed_at', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    const res = await selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'people' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-04-10').toISOString())
  })

  it('temporal transition → matched_at is the transition event time', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'stage', value: 'trial', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: a, key: 'stage', value: 'activated', observed_at: d('2026-03-05') })
    const res = await selector.resolve({ filter: { fact: { stage: { transition: { to: 'activated', last: '90d' } } } } },
      { projection: 'people', asOf: '2026-03-10' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-03-05').toISOString())
  })

  it('all → the LATEST positive leaf time (when every condition was met)', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: a, key: 'seat_count', value: 9, observed_at: d('2026-05-20') })
    const res = await selector.resolve(
      { filter: { all: [ { fact: { plan_tier: { eq: 'pro' } } }, { fact: { seat_count: { gte: 5 } } } ] } },
      { projection: 'people' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-05-20').toISOString())   // the later of the two
  })

  it('any → the EARLIEST qualifying branch time', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'k1', value: 'yes', observed_at: d('2026-05-09') })
    await facts.record({ passport_id: a, key: 'k2', value: 'yes', observed_at: d('2026-01-02') })
    const res = await selector.resolve(
      { filter: { any: [ { fact: { k1: { eq: 'yes' } } }, { fact: { k2: { eq: 'yes' } } } ] } },
      { projection: 'people' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-01-02').toISOString())   // the earlier branch
  })

  it('a `not` subtraction preserves the surviving member’s anchor', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    const res = await selector.resolve(
      { filter: { all: [ { fact: { plan_tier: { eq: 'pro' } } }, { not: { fact: { churned: { eq: true } } } } ] } },
      { projection: 'people' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-04-10').toISOString())
  })

  it('metric gte → matched_at is the moment the running total crossed the bound', async () => {
    const a = await newPassport()
    await expose(a, '2026-05-01')
    await expose(a, '2026-05-08')
    await expose(a, '2026-05-20')

    const first = await selector.resolve({ filter: { metric: { count: { gte: 1 } } } }, { projection: 'people' })
    expect(iso(matchedAt(first, a))).toBe(d('2026-05-01').toISOString())

    // the CROSSING, not the earliest exposure — the third one is what reached 3
    const third = await selector.resolve({ filter: { metric: { count: { gte: 3 } } } }, { projection: 'people' })
    expect(iso(matchedAt(third, a))).toBe(d('2026-05-20').toISOString())
  })

  it('metric gte counts a session once, at its first exposure', async () => {
    const a = await newPassport()
    const [s1, s2] = [8801, 8802]
    for (const [id, ts] of [[s1, '2026-05-01'], [s1, '2026-05-02'], [s2, '2026-05-09']]) {
      await db('whitebox_sessions').insert({ id, passport_id: a }).onConflict('id').ignore()
      await db('whitebox_awareness_exposures')
        .insert({ passport_id: a, session_id: id, ts: d(ts), channel: 'web', direction: 'expression', text: 'x' })
    }
    // 2 distinct sessions is reached by s2, on the 9th — not by s1's second hit
    const res = await selector.resolve(
      { filter: { metric: { distinct_sessions: { gte: 2 } } } }, { projection: 'people' })
    expect(iso(matchedAt(res, a))).toBe(d('2026-05-09').toISOString())
  })

  it('metric bounds with no crossing (lte, recency_days) still carry no matched_at', async () => {
    const a = await newPassport()
    await expose(a, '2026-05-01')
    for (const metric of [{ count: { lte: 5 } }, { recency_days: { lte: 3650 } }]) {
      const res = await selector.resolve({ filter: { metric } }, { projection: 'people' })
      expect(res.passports.find(p => p.id === a)).toEqual({ id: a })   // matched, but no anchor
    }
  })

  it('about-only and judge matches carry no matched_at', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    aboutMap['x'] = [a]
    const aboutRes = await selector.resolve({ about: 'x' }, { projection: 'people' })
    expect(aboutRes.passports[0]).toEqual({ id: a })                 // about gates, no event time

    verdictMap[a] = { match: true, score: 0.9, reason: 'r' }
    const judgeRes = await selector.resolve({ about: 'x', judge: { criteria: 'c', confidence: 0.7 } }, { projection: 'people' })
    expect(judgeRes.passports[0]).not.toHaveProperty('matched_at')   // LLM match → no clean anchor
  })
})
