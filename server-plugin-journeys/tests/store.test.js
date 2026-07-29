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
