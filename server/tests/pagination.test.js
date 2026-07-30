import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import { randomUUID } from 'node:crypto'
import { parsePage, page, pageSlice, pagedList } from '../src/pagination.js'

// ---------------------------------------------------------------------------
// pagedList() runs against a REAL table. It is a thin wrapper over knex, so a
// fake builder would mostly assert that the fake behaves like the fake — and
// the one property that matters here (does LIMIT/OFFSET partition the result
// set) is a property of Postgres, not of the wrapper.
// ---------------------------------------------------------------------------

const TABLE = 'pagination_probe'

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 5 },
})

beforeAll(async () => {
  await db.schema.dropTableIfExists(TABLE)
  await db.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary()
    t.string('name')
    t.timestamp('created_at')
  })
})

afterAll(async () => {
  await db.schema.dropTableIfExists(TABLE)
  await db.destroy()
})

beforeEach(async () => { await db(TABLE).del() })

// Every row shares one created_at — a bulk import, or anything that writes a
// batch in a single pass. The realistic worst case, not a contrived one.
const TIED_AT = new Date('2026-01-01T00:00:00Z')
async function seedTied(n, prefix = 'row') {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: randomUUID(), name: `${prefix}-${i}`, created_at: TIED_AT,
  }))
  await db(TABLE).insert(rows)
  return rows.map(r => r.id)
}

describe('parsePage', () => {
  it('defaults, floors and caps', () => {
    expect(parsePage({})).toEqual({ limit: 50, offset: 0 })
    expect(parsePage({ limit: '10.9', offset: '5.9' })).toEqual({ limit: 10, offset: 5 })
    expect(parsePage({ limit: 9999 })).toEqual({ limit: 200, offset: 0 })
    // Junk falls back rather than propagating NaN into a LIMIT clause.
    expect(parsePage({ limit: 'abc', offset: -3 })).toEqual({ limit: 50, offset: 0 })
  })
})

describe('page / pageSlice', () => {
  it('page() reads has_more off the extra row and drops it', () => {
    expect(page([1, 2, 3], { limit: 2, offset: 0 }))
      .toEqual({ data: [1, 2], limit: 2, offset: 0, has_more: true })
    expect(page([1, 2], { limit: 2, offset: 0 }))
      .toEqual({ data: [1, 2], limit: 2, offset: 0, has_more: false })
  })

  it('pageSlice() windows a known set', () => {
    expect(pageSlice([1, 2, 3, 4, 5], { limit: 2, offset: 2 }))
      .toEqual({ data: [3, 4], limit: 2, offset: 2, total: 5, has_more: true })
  })
})

describe('pagedList', () => {
  it('returns the real total alongside one page of rows', async () => {
    await seedTied(7)
    const { total, rows } = await pagedList(db(TABLE), { limit: 3 })
    expect(total).toBe(7)          // the whole result set…
    expect(rows).toHaveLength(3)   // …not just what came back
  })

  it('counts the filtered set, not the table', async () => {
    await seedTied(4, 'keep')
    await seedTied(6, 'drop')
    const { total, rows } = await pagedList(db(TABLE), { q: 'keep', fields: ['name'], limit: 2 })
    expect(total).toBe(4)
    expect(rows.every(r => r.name.startsWith('keep'))).toBe(true)
  })

  it('matches case-insensitively across every searched field', async () => {
    await db(TABLE).insert({ id: randomUUID(), name: 'MiXeDcAsE', created_at: TIED_AT })
    const { total } = await pagedList(db(TABLE), { q: 'mixedcase', fields: ['name'] })
    expect(total).toBe(1)
  })

  // The reason `tiebreak` exists. Sorting on a non-unique column makes the sort
  // a PARTIAL order, and Postgres may break a tie one way for the page-1 query
  // and the other way for page-2 — the same row appears twice while another is
  // skipped, with no error anywhere. Asserting only "no duplicates" does not
  // catch it (at this size Postgres is stable either way, verified by removing
  // the tiebreaker); asserting the EXACT order does, because with every
  // created_at equal the id is the only thing left deciding, and random uuids
  // will not land in id order by accident.
  it('pages a tied sort column in a total order', async () => {
    const ids = await seedTied(9)

    const walked = []
    for (let offset = 0; offset < 9; offset += 3) {
      const { rows } = await pagedList(db(TABLE), { limit: 3, offset })
      walked.push(...rows.map(r => r.id))
    }

    expect(walked).toEqual([...ids].sort().reverse())
    expect(new Set(walked).size).toBe(9)   // therefore nobody twice, nobody missed
  })

  it('follows the sort direction with its tiebreaker', async () => {
    const ids = await seedTied(5)
    const { rows } = await pagedList(db(TABLE), { direction: 'asc' })
    expect(rows.map(r => r.id)).toEqual([...ids].sort())
  })

  it('does not repeat the ORDER BY term when sorting by the unique column itself', async () => {
    const ids = await seedTied(5)
    const { rows } = await pagedList(db(TABLE), { orderBy: 'id', direction: 'asc' })
    expect(rows.map(r => r.id)).toEqual([...ids].sort())
  })

  it('leaves the caller\'s builder usable — it clones rather than consumes', async () => {
    await seedTied(3)
    const q = db(TABLE)
    await pagedList(q, { limit: 1 })
    // If pagedList() had applied limit/offset to `q` itself, this would be 1.
    expect(await q.clone().count('* as c')).toEqual([{ c: '3' }])
  })
})
