import { describe, it, expect } from 'vitest'
import knexFactory from 'knex'
import * as store from '../src/store.js'

// A real knex query-builder (client: 'pg', no actual connection) so we can
// inspect the COMPILED SQL via .toString() without needing a live database —
// genuine verification of the JSONB containment query, not a hand-rolled fake.
const knex = knexFactory({ client: 'pg' })

describe('activeEventJourneys() — JSONB containment, not equality', () => {
  it('matches journeys whose event array CONTAINS the given name', () => {
    store.init({ db: knex })
    const sql = store.activeEventJourneys('mail.sent').toString()
    expect(sql).toContain(`trigger->>'kind' = 'event'`)
    expect(sql).toContain(`trigger->'event' @>`)
    expect(sql).toContain(`'["mail.sent"]'`)
    expect(sql).not.toContain(`trigger->>'event' =`)   // the old equality form must be gone
  })
})

describe('distinctActiveEventNames() — flatten + dedupe across journeys\' event arrays', () => {
  function makeFakeDb(rows) {
    const db = table => ({
      where: () => ({
        whereRaw: () => ({
          select: () => ({ then: resolve => resolve(rows) }),
        }),
      }),
    })
    db.raw = sql => ({ __raw: sql })
    return db
  }

  it('flattens and dedupes event names across multiple journeys', async () => {
    store.init({ db: makeFakeDb([
      { event: ['mail.sent', 'sms.sent'] },
      { event: ['sms.sent', 'cart.abandoned'] },
    ]) })
    const names = await store.distinctActiveEventNames()
    expect(new Set(names)).toEqual(new Set(['mail.sent', 'sms.sent', 'cart.abandoned']))
  })

  it('tolerates a JSON-string-encoded event array (defensive, matches triggers.js\'s own parsing)', async () => {
    store.init({ db: makeFakeDb([{ event: JSON.stringify(['mail.sent']) }]) })
    const names = await store.distinctActiveEventNames()
    expect(names).toEqual(['mail.sent'])
  })

  it('returns an empty list when no active event journeys exist', async () => {
    store.init({ db: makeFakeDb([]) })
    const names = await store.distinctActiveEventNames()
    expect(names).toEqual([])
  })
})

// The health reads are pure SQL, so what needs verifying is the SQL — that it
// filters on the columns migration 001 actually created, and that each windowed
// count is windowed on its OWN timestamp. Real knex.raw() compiles the
// expressions (bindings included); a fake db stands in for the connection.
describe('health counts — the SQL, against the real schema', () => {
  function makeCountDb(rowsByTable = {}) {
    const captured = []
    const db = table => ({
      select: async (...raws) => {
        captured.push({ table, sql: raws.map(r => r.toString()).join(' | ') })
        return [rowsByTable[table] ?? {}]
      },
    })
    db.raw = (sql, bindings) => knex.raw(sql, bindings)
    return { db, captured }
  }

  const sqlFor = (captured, table) => captured.find(c => c.table === table).sql

  it('liveCounts() counts switched-on journeys and in-flight enrollments', async () => {
    const { db, captured } = makeCountDb()
    store.init({ db })
    await store.liveCounts(new Date('2026-07-30T12:00:00.000Z'))

    expect(sqlFor(captured, 'whitebox_journeys')).toContain(`status = 'active'`)
    const enr = sqlFor(captured, 'whitebox_journey_enrollments')
    expect(enr).toContain(`status IN ('active', 'waiting')`)
  })

  // A wait is a delayed job plus next_action_at; a 'waiting' row past that
  // deadline means the job never fired. Compared against the caller's grace
  // cutoff, NOT now(), so ordinary queue lag isn't reported as a fault.
  it('liveCounts() finds stuck waits by comparing next_action_at to the supplied cutoff', async () => {
    const { db, captured } = makeCountDb()
    store.init({ db })
    await store.liveCounts(new Date('2026-07-30T12:00:00.000Z'))

    const enr = sqlFor(captured, 'whitebox_journey_enrollments')
    expect(enr).toContain(`status = 'waiting' AND next_action_at <`)
    expect(enr).toContain('2026-07-30')
    expect(enr).not.toContain('now()')
  })

  it('liveCounts() merges the journey and enrollment rows into one answer', async () => {
    const { db } = makeCountDb({
      whitebox_journeys: { active_journeys: 3 },
      whitebox_journey_enrollments: { enrolled: 12, stuck: 1 },
    })
    store.init({ db })
    expect(await store.liveCounts(new Date())).toEqual({ active_journeys: 3, enrolled: 12, stuck: 1 })
  })

  // Not one shared WHERE: an enrollment that started before the window and
  // completed inside it belongs to `completed` and not to `started`.
  it('activityCounts() windows each count on its own timestamp column', async () => {
    const { db, captured } = makeCountDb()
    store.init({ db })
    await store.activityCounts(new Date('2026-07-30T00:00:00.000Z'))

    const sql = sqlFor(captured, 'whitebox_journey_enrollments')
    expect(sql).toContain('enrolled_at >=')
    expect(sql).toContain('completed_at >=')
    // executor.fail() stamps exited_at, so that's when the failure happened
    expect(sql).toContain(`status = 'failed' AND exited_at >=`)
  })
})

describe('stepCounts() — grouping/transform behavior', () => {
  function makeFakeDb(rows) {
    const log = []
    const db = table => {
      const q = {}
      for (const m of ['where', 'whereIn', 'joinRaw', 'groupBy', 'select']) q[m] = (...args) => { log.push([m, args]); return q }
      q.count = (...args) => { log.push(['count', args]); return { then: resolve => resolve(rows) } }
      return q
    }
    db.raw = sql => ({ __raw: sql })
    return { db, log }
  }

  it('groups counts into a { step_id: count } map, coercing the string count to a number', async () => {
    const { db } = makeFakeDb([{ step_id: 'a1', count: '3' }, { step_id: 'b2', count: '1' }])
    store.init({ db })
    const counts = await store.stepCounts('journey-1')
    expect(counts).toEqual({ a1: 3, b2: 1 })
  })

  it('filters to this journey and to active/waiting enrollments only', async () => {
    const { db, log } = makeFakeDb([])
    store.init({ db })
    await store.stepCounts('journey-1')
    expect(log.find(([m]) => m === 'where')[1]).toEqual([{ 'e.journey_id': 'journey-1' }])
    expect(log.find(([m]) => m === 'whereIn')[1]).toEqual(['e.status', ['active', 'waiting']])
  })

  it('returns an empty map when nothing is currently enrolled', async () => {
    const { db } = makeFakeDb([])
    store.init({ db })
    expect(await store.stepCounts('journey-1')).toEqual({})
  })
})
