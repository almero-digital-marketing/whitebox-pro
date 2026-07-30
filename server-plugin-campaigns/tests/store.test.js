import { describe, it, expect } from 'vitest'
import knexFactory from 'knex'
import * as store from '../src/store.js'

// Real knex.raw() compiles the expressions (bindings included) so the SQL can be
// inspected without a live database — genuine verification that the health read
// filters on the columns migration 001 actually created, not a hand-rolled fake.
// Same approach as the journeys plugin's store tests.
const knex = knexFactory({ client: 'pg' })

function makeCountDb(row = {}) {
  const captured = []
  const db = table => ({
    select: async (...raws) => {
      captured.push({ table, sql: raws.map(r => r.toString()).join(' | ') })
      return [row]
    },
  })
  db.raw = (sql, bindings) => knex.raw(sql, bindings)
  return { db, captured }
}

describe('healthCounts() — the SQL, against the real schema', () => {
  const sqlOf = async (since = new Date('2026-07-30T00:00:00.000Z')) => {
    const { db, captured } = makeCountDb()
    store.init({ db })
    await store.healthCounts(since)
    expect(captured[0].table).toBe('whitebox_campaigns')
    return captured[0].sql
  }

  // A delivery happened at a time, so it belongs to a window.
  it('windows the send counts on sent_at', async () => {
    const sql = await sqlOf()
    expect(sql).toContain('sent_at >=')
    expect(sql).toContain('2026-07-30')
  })

  // runDelivery() stamps dry_run into the stats jsonb on every send.
  it('reads the dry-run flag out of the stats jsonb, inside the same window', async () => {
    expect(await sqlOf()).toContain(`stats->>'dry_run' = 'true'`)
  })

  // `status` holds only where a campaign is NOW, never when it got there — so
  // these counts have no `since` to be windowed by.
  it('counts draft and scheduled as unwindowed current state', async () => {
    const sql = await sqlOf()
    expect(sql).toContain(`status = 'draft'`)
    expect(sql).toContain(`status = 'scheduled'`)
  })

  // schedule() only delivers a campaign already past its send time; one
  // committed for a future time waits for a send worker this plugin doesn't
  // ship. Compared in SQL against now() because "overdue" means overdue at read
  // time, not relative to the caller's window.
  it('finds overdue schedules by comparing scheduled_at to now()', async () => {
    expect(await sqlOf()).toContain(`status = 'scheduled' AND scheduled_at <= now()`)
  })

  it('returns the single grouped row, not an array', async () => {
    const { db } = makeCountDb({ sent: 1, dry_run: 1, scheduled: 0, draft: 3, overdue: 0 })
    store.init({ db })
    expect(await store.healthCounts(new Date(0))).toEqual({ sent: 1, dry_run: 1, scheduled: 0, draft: 3, overdue: 0 })
  })
})
