import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'
import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

// Event attributes take the FACT operator set.
//
// They took three things — a value, `{ in: [...] }`, `{ present: true }` — while a fact
// took fourteen. So `attrs: { event: 'booking' }` was equality and nothing else: no range,
// no negation, no "attribute between X and Y". "Who increased their visits" was trivial
// and "bookings over 100 lv" was not expressible at all.
//
// The asymmetry got worse when the six booking_* facts became booking EVENTS. cost, paid
// and first were per-booking data wrongly modelled as customer facts, so moving them was
// right — but it moved them from the surface with fourteen operators to the one with
// three. The model became more honest and less answerable in a single change.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const passports = { resolve: async id => id }
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

async function booking(meta) {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  await db('whitebox_awareness_exposures').insert({
    passport_id: id, ts: d('2026-07-01'), channel: 'crm', direction: 'expression',
    source: 'gpoint', text: 'booking', meta: JSON.stringify({ event: 'booking', ...meta }),
  })
  return id
}
const count = async (attrs) => (await selector.resolve(
  { filter: { metric: { attrs: { event: 'booking', ...attrs }, count: { gte: 1 } } } },
  { projection: 'count' })).count

describe('metric attrs: the fact operator set', () => {
  beforeEach(async () => {
    await booking({ paid: 0,   location: 'София - Лозенец',  online: true })
    await booking({ paid: 50,  location: 'София - Люлин 10', online: false })
    await booking({ paid: 120, location: 'Пловдив - Център', online: true })
    await booking({ paid: 500, location: 'Пловдив - Тракия', online: true })
    await booking({ location: 'Варна' })                              // no `paid` at all
  })

  it('compares numerically, which is the question that was inexpressible', async () => {
    expect(await count({ paid: { gte: 100 } })).toBe(2)
    expect(await count({ paid: { gt: 0 } })).toBe(3)
    expect(await count({ paid: { lt: 100 } })).toBe(2)
    expect(await count({ paid: { lte: 50 } })).toBe(2)
  })

  it('ANDs several operators, which is how a range is written', async () => {
    expect(await count({ paid: { gte: 100, lte: 200 } })).toBe(1)
    expect(await count({ paid: { gt: 0, lt: 500 } })).toBe(2)
  })

  it('does NOT compare numbers as text', async () => {
    // The bug this prevents: as strings, "50" > "120" and "500" < "60". The values here
    // are chosen so a lexical comparison gives a different answer.
    expect(await count({ paid: { gte: 100 } })).toBe(2)   // 120, 500 — lexically also "50"
    expect(await count({ paid: { lt: 100 } })).toBe(2)    // 0, 50 — lexically also "120"
  })

  it('ignores a row that does not carry the attribute at all', async () => {
    // Absent is not zero. The Варна booking has no `paid` and must not satisfy `lt: 100`.
    expect(await count({ paid: { lt: 1000 } })).toBe(4)
    expect(await count({ paid: { present: false } })).toBe(1)
    expect(await count({ paid: { present: true } })).toBe(4)
  })

  it('negates — and treats a missing attribute as unknown, not as "not X"', async () => {
    expect(await count({ location: { ne: 'Варна' } })).toBe(4)
    // A row with no `paid` is not "paid != 50": it is a row we know nothing about. In SQL
    // `null <> 50` is null and would drop out anyway; this states the intent.
    expect(await count({ paid: { ne: 50 } })).toBe(3)
  })

  it('matches substrings', async () => {
    expect(await count({ location: { contains: 'Пловдив' } })).toBe(2)
    expect(await count({ location: { startsWith: 'София' } })).toBe(2)
    expect(await count({ location: { endsWith: 'Тракия' } })).toBe(1)
  })

  it('treats LIKE metacharacters in the bound as literal', async () => {
    await booking({ location: '100% Laser_Studio' })
    expect(await count({ location: { contains: '100%' } })).toBe(1)
    expect(await count({ location: { contains: '_Studio' } })).toBe(1)
    // If `_` were a wildcard this would also match "100% Laser_Studio"
    expect(await count({ location: { contains: 'xStudio' } })).toBe(0)
  })

  it('compares a non-numeric bound as text, so an ISO date still works', async () => {
    await booking({ due: '2026-09-01' })
    await booking({ due: '2026-03-01' })
    expect(await count({ due: { gte: '2026-06-01' } })).toBe(1)
    expect(await count({ due: { lt: '2026-06-01' } })).toBe(1)
  })

  it('keeps the old sugar working', async () => {
    expect(await count({ location: 'Варна' })).toBe(1)
    expect(await count({ location: ['Варна', 'Пловдив - Център'] })).toBe(2)
    expect(await count({ location: { in: ['Варна'] } })).toBe(1)
  })

  it('names the operators when one is misspelled', async () => {
    await expect(selector.resolve(
      { filter: { metric: { attrs: { paid: { roughly: 100 } }, count: { gte: 1 } } } }, { projection: 'count' }))
      .rejects.toThrow(/has no operator "roughly" — one of eq, ne, in, gt, gte/)
    await expect(selector.resolve(
      { filter: { metric: { attrs: { paid: { in: 100 } }, count: { gte: 1 } } } }, { projection: 'count' }))
      .rejects.toThrow(/`in` takes an array/)
    await expect(selector.resolve(
      { filter: { metric: { attrs: { paid: {} }, count: { gte: 1 } } } }, { projection: 'count' }))
      .rejects.toThrow(/empty condition/)
  })

  it('works in a GROUPED query too, not only as a gate', async () => {
    const r = await selector.resolve(
      { filter: { metric: { attrs: { event: 'booking', paid: { gte: 100 } }, sum: { field: 'paid' } } } },
      { group: { by: 'month' } })
    expect(r[0].value).toBe(620)     // 120 + 500
  })
})
