import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import dayjs from 'dayjs'
import express from 'express'
import { randomUUID } from 'node:crypto'

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { identify, link, identities, findByIdentity, resolve, merge, erase, unlink, search, get, init, register } = await import('../src/passports.js')

// ---------------------------------------------------------------------------
// Lock mock — no Redis needed for passport tests
// ---------------------------------------------------------------------------

const lock = {
  acquire: vi.fn().mockResolvedValue({}),
  release: vi.fn().mockResolvedValue(null),
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 5 },
})

beforeAll(async () => {
  await init({ db, lock, config: {} })
  // A synthetic table with a FK to passports — proves the catalog-driven merge
  // moves arbitrary referencing rows without the merge knowing the table exists.
  await db.schema.dropTableIfExists('wb_merge_test_refs')
  await db.schema.createTable('wb_merge_test_refs', t => {
    t.increments('id')
    t.uuid('passport_id').references('id').inTable('whitebox_passports')
    t.text('note')
  })
  // The real whitebox_audience_signals belongs to the audiences plugin, which
  // core's tests don't load. Recreated here under its real name because
  // merge() special-cases it BY NAME (passport_id sits inside a unique
  // constraint there, so the generic re-point would collide).
  await db.schema.dropTableIfExists('whitebox_audience_signals')
  await db.schema.createTable('whitebox_audience_signals', t => {
    t.increments('id')
    t.uuid('passport_id').notNullable().references('id').inTable('whitebox_passports').onDelete('CASCADE')
    t.string('name', 64).notNullable()
    t.string('value', 512).notNullable()
    t.unique(['passport_id', 'name'])
  })
  // A synthetic table whose UNIQUE spans the passport column — the shape step 3
  // of merge() can't re-point blindly. Core has no table like this and signals
  // above is special-cased by name, so without this the catalog-driven dedupe
  // branch never runs here; the audiences plugin's segment-members table is the
  // real-world instance (and the one that first hit the bug this guards).
  await db.schema.dropTableIfExists('wb_merge_test_members')
  await db.schema.createTable('wb_merge_test_members', t => {
    t.increments('id')
    t.uuid('passport_id').notNullable().references('id').inTable('whitebox_passports').onDelete('CASCADE')
    t.uuid('group_id').notNullable()
    t.unique(['group_id', 'passport_id'])
  })
})

afterAll(async () => {
  await db.schema.dropTableIfExists('wb_merge_test_refs')
  await db.schema.dropTableIfExists('whitebox_audience_signals')
  await db.schema.dropTableIfExists('wb_merge_test_members')
  await db.destroy()
})

beforeEach(async () => {
  // TRUNCATE … CASCADE clears passports + everything that references them
  // (identities, merges, and any sessions/exposures inherited from the parent
  // Neon branch), so the per-test slate is clean regardless of FK direction.
  await db.raw('TRUNCATE TABLE whitebox_passports CASCADE')
  lock.acquire.mockClear()
  lock.release.mockClear()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  return dayjs().subtract(n, 'day').toDate()
}

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------

describe('identify', () => {
  it('creates a new passport when no id is given', async () => {
    const id = await identify(null)
    expect(id).toBeTruthy()
    const row = await db('whitebox_passports').where({ id }).first()
    expect(row).toBeTruthy()
  })

  it('returns the same passport when a valid id is given', async () => {
    const first = await identify(null)
    const second = await identify(first)
    expect(second).toBe(first)
    const count = await db('whitebox_passports').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('creates a new passport when the id is not found in the database', async () => {
    const id = await identify('00000000-0000-0000-0000-000000000000')
    const count = await db('whitebox_passports').count('id as n').first()
    expect(Number(count.n)).toBe(1)
    expect(id).not.toBe('00000000-0000-0000-0000-000000000000')
  })

  it('updates last_seen_at on each call', async () => {
    const id = await identify(null)
    const { last_seen_at: before } = await db('whitebox_passports').where({ id }).first()
    await new Promise(r => setTimeout(r, 50))
    await identify(id)
    const { last_seen_at: after } = await db('whitebox_passports').where({ id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('follows the merge chain and returns the survivor', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    const resolved = await identify(a)
    expect(resolved).toBe(b)
  })

  it('follows a multi-hop merge chain', async () => {
    const a = await identify(null)
    const b = await identify(null)
    const c = await identify(null)
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    await db('whitebox_passports_merges').insert({ absorbed_id: b, survivor_id: c })
    const resolved = await identify(a)
    expect(resolved).toBe(c)
  })
})

// ---------------------------------------------------------------------------
// link — strong identities
// ---------------------------------------------------------------------------

describe('link — strong identities', () => {
  it('inserts a new strong identity', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const row = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(row).toBeTruthy()
    expect(row.value).toBe('+35988000000')
  })

  it('updates last_seen_at when the same strong identity is linked again', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const { last_seen_at: before } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    await new Promise(r => setTimeout(r, 50))
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const { last_seen_at: after } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('merges passports when a strong identity within lifespan is found on a different passport', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_identities').insert({
      passport_id: a, type: 'phone', name: 'e164', value: '+35988000000',
      last_seen_at: daysAgo(1),
    })
    await link(b, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const mergeRow = await db('whitebox_passports_merges').first()
    expect(mergeRow).toBeTruthy()
    // the triggering identity is MOVED onto the survivor (b), not lost
    const moved = await db('whitebox_passports_identities').where({ value: '+35988000000' }).first()
    expect(moved.passport_id).toBe(b)
    // the absorbed passport survives as a tombstone (not deleted)
    expect(await db('whitebox_passports').where({ id: a }).first()).toBeTruthy()
    expect(lock.acquire).toHaveBeenCalled()
    expect(lock.release).toHaveBeenCalled()
  })

  it('does not merge when the strong identity is outside its lifespan', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_identities').insert({
      passport_id: a, type: 'phone', name: 'e164', value: '+35988000000',
      last_seen_at: daysAgo(31),
    })
    await link(b, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const count = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(count.n)).toBe(0)
    expect(lock.acquire).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// link — weak identities
// ---------------------------------------------------------------------------

describe('link — weak identities', () => {
  it('inserts a new weak identity for the passport', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const row = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(row).toBeTruthy()
    expect(row.value).toBe('male')
  })

  it('updates last_seen_at for an existing weak identity on the same passport', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const { last_seen_at: before } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    await new Promise(r => setTimeout(r, 50))
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const { last_seen_at: after } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('allows the same weak identity value on different passports without merging', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await link(a, [{ type: 'gender', name: 'gender', value: 'male' }])
    await link(b, [{ type: 'gender', name: 'gender', value: 'male' }])
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(2)
    const mergeCount = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(mergeCount.n)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// findByIdentity
// ---------------------------------------------------------------------------

describe('findByIdentity', () => {
  it('returns the passport when identity is found', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'email', name: 'email', value: 'test@example.com' }])
    const passport = await findByIdentity('email', 'test@example.com')
    expect(passport).toBeTruthy()
    expect(passport.id).toBe(id)
  })

  it('returns null when identity is not found', async () => {
    const passport = await findByIdentity('email', 'unknown@example.com')
    expect(passport).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

describe('identities', () => {
  it('returns all identities for the passport', async () => {
    const id = await identify(null)
    await link(id, [
      { type: 'phone', name: 'e164', value: '+35988000000' },
      { type: 'gender', name: 'gender', value: 'male' },
    ])
    const result = await identities(id)
    expect(result).toHaveLength(2)
  })

  it('resolves through the merge chain before returning identities', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await link(b, [{ type: 'gender', name: 'gender', value: 'male' }])
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    const result = await identities(a)
    expect(result).toHaveLength(1)
    expect(result[0].passport_id).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// merge — non-destructive, catalog-driven
// ---------------------------------------------------------------------------

describe('merge', () => {
  it('dedupes row-wise in a discovered table whose UNIQUE includes the passport column', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    const shared = randomUUID()
    const onlyTheirs = randomUUID()
    await db('wb_merge_test_members').insert([
      { passport_id: survivor, group_id: shared },
      { passport_id: absorbed, group_id: shared },       // a blind UPDATE would collide here
      { passport_id: absorbed, group_id: onlyTheirs },
    ])

    await merge(survivor, absorbed)

    const rows = await db('wb_merge_test_members').orderBy('group_id')
    expect(rows).toHaveLength(2)                          // the duplicate dropped, not moved
    expect(rows.every(r => r.passport_id === survivor)).toBe(true)
    expect(rows.map(r => r.group_id).sort()).toEqual([shared, onlyTheirs].sort())
  })

  it('moves identities + all FK references to the survivor and keeps the absorbed as a tombstone', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await link(absorbed, [
      { type: 'email', name: 'email', value: 'x@y.com' },   // strong
      { type: 'gender', name: 'gender', value: 'male' },     // weak
    ])
    await db('wb_merge_test_refs').insert([{ passport_id: absorbed, note: 'a' }, { passport_id: absorbed, note: 'b' }])

    const result = await merge(survivor, absorbed)
    expect(result).toBe(survivor)

    // identities moved off the absorbed onto the survivor
    const ids = await db('whitebox_passports_identities').where({ passport_id: survivor })
    expect(ids.map(i => i.value).sort()).toEqual(['male', 'x@y.com'])
    expect(await db('whitebox_passports_identities').where({ passport_id: absorbed }).first()).toBeUndefined()

    // arbitrary FK rows moved — discovered from the catalog, not hardcoded
    const refs = await db('wb_merge_test_refs').where({ passport_id: survivor })
    expect(refs).toHaveLength(2)
    expect(await db('wb_merge_test_refs').where({ passport_id: absorbed }).first()).toBeUndefined()

    // absorbed passport is NOT deleted; resolve() forwards it to the survivor
    expect(await db('whitebox_passports').where({ id: absorbed }).first()).toBeTruthy()
    expect(await resolve(absorbed)).toBe(survivor)
  })

  it('dedupes a weak identity already present on the survivor', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await link(survivor, [{ type: 'gender', name: 'gender', value: 'male' }])
    await link(absorbed, [{ type: 'gender', name: 'gender', value: 'male' }])
    await merge(survivor, absorbed)
    const genders = await db('whitebox_passports_identities').where({ type: 'gender', value: 'male' })
    expect(genders).toHaveLength(1)
    expect(genders[0].passport_id).toBe(survivor)
  })

  it('is a no-op when survivor === absorbed', async () => {
    const p = await identify(null)
    expect(await merge(p, p)).toBe(p)
    const { n } = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(n)).toBe(0)
  })

  // Regression: whitebox_audience_signals has unique(passport_id, name), so the
  // generic "blind re-point every FK row" step violates it when both people
  // carry the same signal. That threw before merge() learned to dedupe it.
  it('merges ad signals row-by-row instead of colliding on unique(passport_id, name)', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await db('whitebox_audience_signals').insert([
      { passport_id: survivor, name: 'gclid', value: 'survivor-gclid' },
      { passport_id: absorbed, name: 'gclid', value: 'absorbed-gclid' },   // collides
      { passport_id: absorbed, name: 'fbp', value: 'absorbed-fbp' },       // survivor lacks it
    ])

    await expect(merge(survivor, absorbed)).resolves.toBe(survivor)

    const rows = await db('whitebox_audience_signals').where({ passport_id: survivor }).orderBy('name')
    expect(rows.map(r => [r.name, r.value])).toEqual([
      ['fbp', 'absorbed-fbp'],          // moved across
      ['gclid', 'survivor-gclid'],      // survivor's own value wins
    ])
    expect(await db('whitebox_audience_signals').where({ passport_id: absorbed }).first()).toBeUndefined()
  })

  it('compacts the merge chain (re-points an existing survivor_id)', async () => {
    const a = await identify(null)
    const b = await identify(null)
    const c = await identify(null)
    await merge(b, a)   // a → b
    await merge(c, b)   // b → c  (should also re-point a → c)
    expect(await resolve(a)).toBe(c)
  })
})

// ---------------------------------------------------------------------------
// erase — the right-to-be-forgotten counterpart to merge
// ---------------------------------------------------------------------------

describe('erase', () => {
  it('deletes the passport and every referencing row, returning per-table counts', async () => {
    const p = await identify(null)
    await link(p, [{ type: 'email', name: 'email', value: 'gone@y.com' }])
    await db('wb_merge_test_refs').insert([{ passport_id: p, note: 'a' }, { passport_id: p, note: 'b' }])
    await db('whitebox_audience_signals').insert({ passport_id: p, name: 'gclid', value: 'g' })

    const res = await erase(p)

    expect(res.id).toBe(p)
    expect(res.removed).toMatchObject({
      whitebox_passports_identities: 1,
      wb_merge_test_refs: 2,
      whitebox_audience_signals: 1,
      whitebox_passports: 1,
    })
    expect(await db('whitebox_passports').where({ id: p }).first()).toBeUndefined()
    expect(await db('wb_merge_test_refs').where({ passport_id: p }).first()).toBeUndefined()
    expect(await db('whitebox_audience_signals').where({ passport_id: p }).first()).toBeUndefined()
  })

  // Unlike merge, erase leaves NOTHING behind — a tombstone that resolved to a
  // deleted id would be a dangling pointer, and one pointing AT the deleted id
  // would resolve an older passport into a void.
  it('clears merge aliases in both directions', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await merge(b, a)                       // a → b
    expect(await resolve(a)).toBe(b)

    await erase(b)
    expect(await db('whitebox_passports_merges').where({ absorbed_id: a }).first()).toBeUndefined()
    expect(await db('whitebox_passports_merges').where({ survivor_id: b }).first()).toBeUndefined()
  })

  // A merged person holds several passport ids. Leaving the absorbed rows
  // behind would strand unresolvable identifiers belonging to someone who
  // asked to be forgotten — found by watching the People count drift up by one
  // after an erase.
  it('deletes the absorbed passports too, not just the survivor', async () => {
    const survivor = await identify(null)
    const absorbedA = await identify(null)
    const absorbedB = await identify(null)
    await merge(survivor, absorbedA)
    await merge(survivor, absorbedB)

    const res = await erase(survivor)
    expect(res.removed.whitebox_passports).toBe(3)
    for (const id of [survivor, absorbedA, absorbedB]) {
      expect(await db('whitebox_passports').where({ id }).first()).toBeUndefined()
    }
  })

  it('follows the merge chain — erasing an absorbed id erases the survivor', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await merge(survivor, absorbed)
    const res = await erase(absorbed)
    expect(res.id).toBe(survivor)
    expect(await db('whitebox_passports').where({ id: survivor }).first()).toBeUndefined()
  })

  it('returns null for an unknown passport', async () => {
    expect(await erase('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------

describe('unlink', () => {
  it('removes one identity and leaves the rest', async () => {
    const p = await identify(null)
    await link(p, [
      { type: 'email', name: 'email', value: 'keep@y.com' },
      { type: 'phone', name: 'phone', value: '+15550000000' },
    ])
    const drop = (await identities(p)).find(i => i.type === 'phone')
    expect(await unlink(p, drop.id)).toBe(1)
    expect((await identities(p)).map(i => i.type)).toEqual(['email'])
  })

  // scoped to the passport — an identity id alone must not let a caller delete
  // a row belonging to someone else
  it('refuses to remove an identity belonging to a different person', async () => {
    const mine = await identify(null)
    const theirs = await identify(null)
    await link(theirs, [{ type: 'email', name: 'email', value: 'notmine@y.com' }])
    const other = (await identities(theirs))[0]
    expect(await unlink(mine, other.id)).toBe(0)
    expect(await identities(theirs)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// search / get — what the People browser reads
// ---------------------------------------------------------------------------

describe('search', () => {
  it('matches an identity value', async () => {
    const p = await identify(null)
    await link(p, [{ type: 'email', name: 'email', value: 'findme@y.com' }])
    const res = await search({ q: 'findme' })
    expect(res.total).toBe(1)
    expect(res.people[0].id).toBe(p)
    expect(res.people[0].identities).toHaveLength(1)
  })

  // Key-agnostic on purpose: fact keys are arbitrary per deployment, so search
  // never names one.
  it('matches an arbitrary fact value without naming its key', async () => {
    const p = await identify(null)
    await db('whitebox_facts').insert({
      passport_id: p, key: 'whatever_this_deployment_calls_it',
      value: JSON.stringify('needle'), type: 'string', source: 'test', observed_at: new Date(),
    })
    const res = await search({ q: 'needle' })
    expect(res.people.map(x => x.id)).toContain(p)
  })

  it('excludes anonymous passports by default and includes them on request', async () => {
    const known = await identify(null)
    await link(known, [{ type: 'email', name: 'email', value: 'known@y.com' }])
    await identify(null)   // anonymous — no identity, no facts

    expect((await search({})).total).toBe(1)
    expect((await search({ includeAnonymous: true })).total).toBe(2)
  })

  it('never returns a merged-away passport', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await link(absorbed, [{ type: 'email', name: 'email', value: 'moved@y.com' }])
    await merge(survivor, absorbed)

    const res = await search({ q: 'moved@y.com' })
    expect(res.people.map(p => p.id)).toEqual([survivor])
    expect(res.people.map(p => p.id)).not.toContain(absorbed)
  })

  it('finds a person by a whole passport id', async () => {
    const p = await identify(null)
    await link(p, [{ type: 'email', name: 'email', value: 'byid@y.com' }])
    expect((await search({ q: p })).people[0].id).toBe(p)
  })

  // The rail labels an anonymous person by the first 8 chars of their id, so
  // that string has to be paste-able back into the box.
  it('finds a person by the short id prefix the UI displays', async () => {
    const p = await identify(null)
    const res = await search({ q: p.slice(0, 8), includeAnonymous: true })
    expect(res.people.map(x => x.id)).toContain(p)
  })

  // Paging is sorted by last_seen_at, which is NOT unique — a bulk import or a
  // campaign send stamps a whole batch with one instant, and the anonymous tail
  // shares NULL. Without a unique tiebreaker the sort is only a PARTIAL order,
  // and Postgres is free to break a tie differently for the page-1 query than
  // for the page-2 query: one person shows up twice, another never appears.
  //
  // Asserting "no duplicates, nothing missing" is NOT enough to catch this —
  // verified by removing the tiebreaker, and at nine rows Postgres returns a
  // stable order anyway, so that test passes either way. What discriminates is
  // asserting the EXACT order: with every timestamp equal, the id tiebreaker is
  // the only thing deciding, so the result must be strictly id-descending.
  // Ids are random uuids, so unsorted heap order will not accidentally match.
  it('pages a tied sort column in a total order', async () => {
    const ids = []
    for (let i = 0; i < 9; i++) {
      const p = await identify(null)
      await link(p, [{ type: 'email', name: 'email', value: `tie-${i}@y.com` }])
      ids.push(p)
    }
    // every row tied on the sort column — the worst case, not a rare one
    await db('whitebox_passports').whereIn('id', ids)
      .update({ last_seen_at: new Date('2026-01-01T00:00:00Z') })

    const walked = []
    for (let offset = 0; offset < 9; offset += 3) {
      const { people } = await search({ q: 'tie-', limit: 3, offset })
      walked.push(...people.map(p => p.id))
    }

    // Postgres orders uuid by byte value, which for canonical lowercase text
    // is the same as a plain string sort.
    expect(walked).toEqual([...ids].sort().reverse())
    expect(new Set(walked).size).toBe(9)   // and therefore nobody twice, nobody missed
  })
})

// `fields` narrows where the term is looked for. The three sources overlap in
// real data — a phone number is also a plausible fact value — so the point is
// being able to say which one you meant.
describe('search fields', () => {
  const twoWays = async () => {
    const byIdentity = await identify(null)
    await link(byIdentity, [{ type: 'email', name: 'email', value: 'overlap@y.com' }])
    const byFact = await identify(null)
    await db('whitebox_facts').insert({
      passport_id: byFact, key: 'anything', value: JSON.stringify('overlap@y.com'),
      type: 'string', source: 'test', observed_at: new Date(),
    })
    return { byIdentity, byFact }
  }

  it('searches all three sources when fields is omitted', async () => {
    const { byIdentity, byFact } = await twoWays()
    const ids = (await search({ q: 'overlap@y.com' })).people.map(p => p.id)
    expect(ids).toEqual(expect.arrayContaining([byIdentity, byFact]))
  })

  it('restricts to identities', async () => {
    const { byIdentity, byFact } = await twoWays()
    const ids = (await search({ q: 'overlap@y.com', fields: ['identities'] })).people.map(p => p.id)
    expect(ids).toContain(byIdentity)
    expect(ids).not.toContain(byFact)
  })

  it('restricts to facts', async () => {
    const { byIdentity, byFact } = await twoWays()
    const ids = (await search({ q: 'overlap@y.com', fields: ['facts'] })).people.map(p => p.id)
    expect(ids).toContain(byFact)
    expect(ids).not.toContain(byIdentity)
  })

  it('accepts a comma-separated string, since it arrives from a query string', async () => {
    const { byIdentity, byFact } = await twoWays()
    const ids = (await search({ q: 'overlap@y.com', fields: 'identities,facts' })).people.map(p => p.id)
    expect(ids).toEqual(expect.arrayContaining([byIdentity, byFact]))
  })

  // An id-only search for something that can't be an id must return nobody —
  // NOT fall through to an unfiltered list, which is the tempting bug.
  it('returns nothing for an id-scoped search of a non-id term', async () => {
    const p = await identify(null)
    await link(p, [{ type: 'email', name: 'email', value: 'scoped@y.com' }])
    expect((await search({ q: 'scoped', fields: ['id'] })).total).toBe(0)
    expect((await search({ q: p.slice(0, 8), fields: ['id'], includeAnonymous: true })).people.map(x => x.id))
      .toContain(p)
  })

  // A typo'd or empty scope widens back to everything. Matching nothing because
  // a filter name was misspelled is the worse failure of the two.
  it('falls back to all sources for an empty or unrecognised scope', async () => {
    const { byIdentity, byFact } = await twoWays()
    for (const fields of [[], ['nonsense'], '']) {
      const ids = (await search({ q: 'overlap@y.com', fields })).people.map(p => p.id)
      expect(ids).toEqual(expect.arrayContaining([byIdentity, byFact]))
    }
  })
})

describe('get', () => {
  it('returns the passport with all of its identities and no display-name concept', async () => {
    const p = await identify(null)
    await link(p, [
      { type: 'email', name: 'email', value: 'a@y.com' },
      { type: 'phone', name: 'phone', value: '+15551234567' },
    ])
    const person = await get(p)
    expect(person.id).toBe(p)
    expect(person.identities).toHaveLength(2)
    expect(person.facts).toEqual({})          // no facts dep passed → empty, not a crash
    expect(person).not.toHaveProperty('name')
    expect(person).not.toHaveProperty('display_name')
  })

  it('resolves a merged-away id to the survivor', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await merge(survivor, absorbed)
    expect((await get(absorbed)).id).toBe(survivor)
  })

  it('returns null for an unknown id', async () => {
    expect(await get('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// POST /passports/link
// ---------------------------------------------------------------------------

describe('POST /passports/link', () => {
  let app, server, base

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    register(app)
    await new Promise(r => { server = app.listen(0, r) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    await new Promise(r => server.close(r))
  })

  const post = (body = {}) =>
    fetch(base + '/passports/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: await r.json() }))

  it('links a generic claim onto the given passport_id — route has no opinion on claim shape', async () => {
    const id = await identify(null)
    const res = await post({ passport_id: id, claims: [{ type: 'email', name: 'email', value: 'a@x.com' }] })
    expect(res.status).toBe(200)
    expect(res.body.passportId).toBe(id)
    const [row] = await identities(id)
    expect(row).toMatchObject({ type: 'email', value: 'a@x.com' })
  })

  it('the passport_id passed in always wins — an existing owner of the claim gets absorbed into it', async () => {
    const previouslyKnown = await identify(null)
    await link(previouslyKnown, [{ type: 'email', name: 'email', value: 'shared@x.com' }])
    const currentBrowser = await identify(null)

    const res = await post({ passport_id: currentBrowser, claims: [{ type: 'email', name: 'email', value: 'shared@x.com' }] })
    expect(res.status).toBe(200)
    expect(res.body.passportId).toBe(currentBrowser)
    expect(await resolve(previouslyKnown)).toBe(currentBrowser)
  })

  it('400s when passport_id is missing', async () => {
    const res = await post({ claims: [{ type: 'email', name: 'email', value: 'a@x.com' }] })
    expect(res.status).toBe(400)
  })

  it('400s when claims is missing or empty', async () => {
    const id = await identify(null)
    expect((await post({ passport_id: id })).status).toBe(400)
    expect((await post({ passport_id: id, claims: [] })).status).toBe(400)
  })
})
