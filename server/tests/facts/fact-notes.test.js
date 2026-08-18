import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'

// What a caller is TOLD about the facts an answer rested on.
//
// The first proposal here was a warning whenever a query touched a key holding several
// values. On this data that fires on every query touching first_booked_at — 3,350
// passports — while the answer is correct, because the key is declared `min`. A warning
// that is usually noise trains people to ignore the ones that matter, so the split is:
//
//   declared   → `applied`, a statement of the rule used. No alarm, and NO DATABASE
//                WORK, because the declaration is already in memory.
//   undeclared → a warning. Nobody chose, `last` won by default, and the caller cannot
//                see that from the result.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const passports = { resolve: async id => id }
const boot = (config = {}) => facts.init({ db, passports, logger, config })

beforeAll(async () => { boot(); await facts.migrate() })
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_facts_current, whitebox_passports CASCADE')
  boot()
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
// Two people who each hold two values for the key, and one who holds a single value.
async function conflicted(key = 'first_booked_at') {
  const a = await newPassport(), b = await newPassport(), c = await newPassport()
  for (const [p, ext, v] of [[a, 'x', '2025-01-01'], [a, 'y', '2026-01-01'],
                             [b, 'x', '2025-06-01'], [b, 'y', '2026-06-01'],
                             [c, 'x', '2025-03-01']]) {
    await facts.record({ passport_id: p, key, value: v, source: 'crm', external_id: ext, observed_at: new Date(v) })
  }
  return { a, b, c }
}

describe('facts.factNotes', () => {
  it('states the rule for a declared key and does NOT warn', async () => {
    await conflicted()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    const n = await facts.factNotes(['first_booked_at'])
    expect(n.applied).toEqual({ first_booked_at: 'min' })
    expect(n.warnings).toEqual([])
  })

  it('warns for an ambiguous key nobody declared, and says how to settle it', async () => {
    await conflicted()
    const n = await facts.factNotes(['first_booked_at'])
    expect(n.applied).toEqual({})
    expect(n.warnings).toHaveLength(1)
    expect(n.warnings[0]).toMatchObject({
      code: 'ambiguous_fact_value',
      fact: 'first_booked_at',
      affected_passports: 2,        // a and b; c holds one value
      used: 'last',
    })
    expect(n.warnings[0].pct_of_cohort).toBeCloseTo(66.7, 0)
    expect(n.warnings[0].remedy).toMatch(/facts\.use.*first_booked_at/s)
  })

  it('says nothing about an undeclared key that is NOT ambiguous', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'pro', source: 't' })
    expect(await facts.factNotes(['tier'])).toEqual({ applied: {}, warnings: [] })
  })

  it('scopes to the COHORT, which is a different denominator', async () => {
    // The reason this is not computed over the whole base: a key ambiguous for a small
    // share of everyone can be ambiguous for all of the people a query just selected,
    // and reporting the base rate would understate it to nothing.
    const { a, b } = await conflicted()
    const all = await facts.factNotes(['first_booked_at'])
    expect(all.warnings[0].pct_of_cohort).toBeCloseTo(66.7, 0)

    const scoped = await facts.factNotes(['first_booked_at'], { scope: [a, b] })
    expect(scoped.warnings[0].affected_passports).toBe(2)
    expect(scoped.warnings[0].pct_of_cohort).toBe(100)
  })

  it('an empty cohort is no question, not an all-clear', async () => {
    await conflicted()
    expect(await facts.factNotes(['first_booked_at'], { scope: [] })).toEqual({ applied: {}, warnings: [] })
  })

  it('costs NOTHING when every key is declared', async () => {
    // The design claim worth protecting: a deployment that declares its vocabulary pays
    // no per-query database work for this. Asserted by counting queries.
    await conflicted()
    boot({ facts: { use: { first_booked_at: 'min', tier: 'last' } } })
    let queries = 0
    const count = () => { queries++ }
    db.on('query', count)
    const n = await facts.factNotes(['first_booked_at', 'tier'])
    db.off('query', count)
    expect(n.applied).toEqual({ first_booked_at: 'min', tier: 'last' })
    expect(queries).toBe(0)
  })

  it('mixes the two — a declaration for one key, a warning for the other', async () => {
    await conflicted('first_booked_at')
    await conflicted('mystery_key')
    boot({ facts: { use: { first_booked_at: 'min' } } })
    const n = await facts.factNotes(['first_booked_at', 'mystery_key'])
    expect(n.applied).toEqual({ first_booked_at: 'min' })
    expect(n.warnings.map(w => w.fact)).toEqual(['mystery_key'])
  })


  // A WINDOW ANCHOR is held to a stricter rule than a filter.
  //
  // A declaration answers "which value does this key mean", and for a filter that closes
  // the question. An anchor asks something it does not close — where each person's
  // boundary falls — and when a person has several candidate dates the window contains a
  // different set of events depending on which was taken. So an anchor on an ambiguous
  // key is reported whether or not the key is declared, with the rule that was applied.
  it('flags an ambiguous anchor even when the key IS declared', async () => {
    await conflicted()
    boot({ facts: { use: { first_booked_at: 'min' } } })

    // As a filter: settled, silent.
    const asFilter = await facts.factNotes(['first_booked_at'])
    expect(asFilter.warnings).toEqual([])

    // As an anchor: same key, same declaration, now reported.
    const asAnchor = await facts.factNotes(['first_booked_at'], { anchors: ['first_booked_at'] })
    expect(asAnchor.applied).toEqual({ first_booked_at: 'min' })
    expect(asAnchor.warnings).toHaveLength(1)
    expect(asAnchor.warnings[0]).toMatchObject({
      code: 'ambiguous_anchor_fact',
      fact: 'first_booked_at',
      affected_passports: 2,
      used: 'min',                       // the rule applied, not a default
    })
  })

  it('says `used: last` for an anchor nobody declared', async () => {
    await conflicted()
    const n = await facts.factNotes(['first_booked_at'], { anchors: ['first_booked_at'] })
    expect(n.warnings[0]).toMatchObject({ code: 'ambiguous_anchor_fact', used: 'last' })
  })

  it('stays quiet on an anchor whose values do not conflict', async () => {
    // The trigger is ambiguity, not anchoring: an anchor everyone has one value for
    // draws one boundary and there is nothing to say about it.
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'signed_up_at', value: '2025-01-01', source: 'crm' })
    boot({ facts: { use: { signed_up_at: 'min' } } })
    const n = await facts.factNotes(['signed_up_at'], { anchors: ['signed_up_at'] })
    expect(n.applied).toEqual({ signed_up_at: 'min' })
    expect(n.warnings).toEqual([])
  })

  it('scopes the anchor warning to the cohort too', async () => {
    const { a, b } = await conflicted()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    const n = await facts.factNotes(['first_booked_at'],
      { anchors: ['first_booked_at'], scope: [a, b] })
    expect(n.warnings[0].pct_of_cohort).toBe(100)
  })

  it('keeps a declared NON-anchor key free of database work', async () => {
    // The anchor rule must not cost the common case its exemption.
    await conflicted()
    boot({ facts: { use: { first_booked_at: 'min' } } })
    let queries = 0
    const count = () => { queries++ }
    db.on('query', count)
    await facts.factNotes(['first_booked_at'], { anchors: [] })
    db.off('query', count)
    expect(queries).toBe(0)
  })

  it('reports both kinds at once, each with its own code', async () => {
    await conflicted('first_booked_at')
    await conflicted('mystery_key')
    boot({ facts: { use: { first_booked_at: 'min' } } })
    const n = await facts.factNotes(['first_booked_at', 'mystery_key'], { anchors: ['first_booked_at'] })
    const byFact = Object.fromEntries(n.warnings.map(w => [w.fact, w]))
    expect(byFact.first_booked_at.code).toBe('ambiguous_anchor_fact')
    expect(byFact.first_booked_at.used).toBe('min')
    expect(byFact.mystery_key.code).toBe('ambiguous_fact_value')
    expect(byFact.mystery_key.used).toBe('last')
  })

  it('handles no keys, unknown keys and duplicates without a query', async () => {
    expect(await facts.factNotes([])).toEqual({ applied: {}, warnings: [] })
    expect(await facts.factNotes(undefined)).toEqual({ applied: {}, warnings: [] })
    expect(await facts.factNotes(['never_recorded'])).toEqual({ applied: {}, warnings: [] })
  })
})
