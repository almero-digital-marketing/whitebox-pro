// A funnel whose steps are both BEHAVIOUR — metric clauses over the exposure
// stream — rather than facts. This is the shape a site-to-booking report needs,
// and the one that could not be expressed before the anchor was threaded into
// the step: a metric's crossing was the first time the passport ever crossed
// the bound, so a customer who had done the thing before was judged on that
// old occurrence and dropped.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }

const visit = (pid, ts) => db('whitebox_awareness_exposures').insert({
  passport_id: pid, ts: d(ts), channel: 'web', direction: 'expression', text: 'page',
})
const booking = (pid, ts) => db('whitebox_awareness_exposures').insert({
  passport_id: pid, ts: d(ts), channel: 'crm', direction: 'expression', text: 'Booking',
  meta: { event: 'booking' },
})

// Visited the site, then booked within the window.
const SPEC = {
  steps: [
    { select: { filter: { metric: { count: { gte: 1 }, channel: 'web' } } }, name: 'visited' },
    { select: { filter: { metric: { count: { gte: 1 }, attrs: { event: 'booking' } } } }, name: 'booked', within: '30d' },
  ],
}
const reached = (res, step) => res.report.find(r => r.name === step).count

describe('funnel: metric → metric, anchored', () => {
  it('credits a repeat customer for the booking that FOLLOWED the visit', async () => {
    // The regression this whole change exists for. Before the anchor, this
    // passport's crossing was the 2024 booking — earlier than the visit it is
    // supposed to follow — so the funnel dropped a genuine conversion.
    const p = await newPassport()
    await booking(p, '2024-05-01')   // long-standing customer
    await visit(p, '2026-07-01')
    await booking(p, '2026-07-03')   // booked again, two days after visiting

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'visited')).toBe(1)
    expect(reached(res, 'booked')).toBe(1)
  })

  it('does not credit a booking that only predates the visit', async () => {
    const p = await newPassport()
    await booking(p, '2024-05-01')
    await visit(p, '2026-07-01')

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'visited')).toBe(1)
    expect(reached(res, 'booked')).toBe(0)
  })

  it('credits a brand-new customer', async () => {
    const p = await newPassport()
    await visit(p, '2026-07-01')
    await booking(p, '2026-07-02')

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'booked')).toBe(1)
  })

  it('still respects the window — a booking after it does not count', async () => {
    const p = await newPassport()
    await visit(p, '2026-05-01')
    await booking(p, '2026-07-01')   // 61 days later, outside 30d

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'visited')).toBe(1)
    expect(reached(res, 'booked')).toBe(0)
  })

  it('anchors on the FIRST visit, and counts the first booking after it', async () => {
    // Two visits; the anchor is the crossing of count>=1, i.e. the first.
    const p = await newPassport()
    await visit(p, '2026-07-01')
    await visit(p, '2026-07-20')
    await booking(p, '2026-07-05')

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'booked')).toBe(1)
  })

  it('separates a converting cohort from a non-converting one', async () => {
    const converted = []
    for (let i = 0; i < 3; i++) {
      const p = await newPassport()
      await booking(p, '2023-01-01')          // all are repeat customers
      await visit(p, '2026-07-01')
      await booking(p, '2026-07-04')
      converted.push(p)
    }
    for (let i = 0; i < 2; i++) {
      const p = await newPassport()
      await booking(p, '2023-01-01')
      await visit(p, '2026-07-01')            // visited, did not rebook
    }

    const res = await selector.funnel(SPEC, { asOf: '2026-08-01' })
    expect(reached(res, 'visited')).toBe(5)
    expect(reached(res, 'booked')).toBe(3)
    // 60%, not the ~0% the unanchored version reported for the same data.
    expect(res.report[1].stepConversion).toBeCloseTo(0.6, 5)
  })
})
