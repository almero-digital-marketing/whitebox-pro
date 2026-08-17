import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'

// whitebox_facts_current — the current row per (passport_id, key), maintained by
// triggers on the log rather than by application code.
//
// The point of the triggers is that no writer can bypass them, so these tests write
// through every route a row can actually take: record(), recordBatch(), a back-dated
// record(), a merge that re-points passport_id, an erase that deletes rows, and raw
// SQL that never went through this module at all. After each, the projection must
// still agree with the log — which verifyCurrent() checks by comparing the winning
// ROW id, not merely the value.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
let mergeMap = {}
const passports = { resolve: async id => mergeMap[id] ?? id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  mergeMap = {}
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_facts_current, whitebox_passports CASCADE')
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
const projection = (passport_id) =>
  db('whitebox_facts_current').where({ passport_id }).orderBy('key').select('key', 'value', 'observed_at', 'fact_id')
const consistent = async () => expect(await facts.verifyCurrent()).toEqual([])

describe('facts_current: maintained by the database', () => {
  it('follows a plain record()', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'free', source: 't' })
    await facts.record({ passport_id: p, key: 'tier', value: 'pro', source: 't' })
    const rows = await projection(p)
    expect(rows).toHaveLength(1)                    // one row per (passport, key), not per write
    expect(rows[0].value).toBe('pro')
    await consistent()
  })

  it('follows a BATCH, which is one statement writing many rows', async () => {
    // The triggers are statement-level with transition tables precisely so this is
    // one upsert rather than N.
    const a = await newPassport(), b = await newPassport()
    await facts.recordBatch([
      { passport_id: a, key: 'tier', value: 'free', source: 't' },
      { passport_id: a, key: 'tier', value: 'pro', source: 't' },
      { passport_id: b, key: 'tier', value: 'trial', source: 't' },
      { passport_id: b, key: 'city', value: 'Sofia', source: 't' },
    ])
    expect((await projection(a)).map(r => r.value)).toEqual(['pro'])
    expect((await projection(b)).map(r => r.value)).toEqual(['Sofia', 'trial'])
    await consistent()
  })

  it('does NOT let a back-dated write overwrite the current value', async () => {
    // record() accepts a past observed_at, and a CRM backfill routinely does. The
    // upsert only replaces when the incoming row is genuinely newer.
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'spend', value: 100, source: 't', observed_at: d('2026-05-10') })
    await facts.record({ passport_id: p, key: 'spend', value: 50, source: 't', observed_at: d('2026-03-01') })
    expect((await projection(p))[0].value).toBe(100)
    await consistent()
  })

  it('breaks a same-instant tie the same way the reads do — last written wins', async () => {
    const p = await newPassport()
    const T = d('2026-05-10T12:00:00Z')
    await facts.record({ passport_id: p, key: 'tier', value: 'first', source: 't', observed_at: T })
    await facts.record({ passport_id: p, key: 'tier', value: 'second', source: 't', observed_at: T })
    expect((await projection(p))[0].value).toBe('second')
    expect((await facts.current(p)).tier).toBe('second')     // and agrees with the log read
    await consistent()
  })

  it('survives a MERGE re-pointing rows between passports', async () => {
    // merge() UPDATEs passport_id in bulk. That empties one pair and changes another,
    // so the trigger recomputes both sides from the log rather than patching.
    const survivor = await newPassport(), absorbed = await newPassport()
    await facts.record({ passport_id: absorbed, key: 'tier', value: 'from-absorbed', source: 't', observed_at: d('2026-05-01') })
    await facts.record({ passport_id: absorbed, key: 'city', value: 'Varna', source: 't' })
    await facts.record({ passport_id: survivor, key: 'tier', value: 'from-survivor', source: 't', observed_at: d('2026-05-02') })

    await db('whitebox_facts').where({ passport_id: absorbed }).update({ passport_id: survivor })
    mergeMap[absorbed] = survivor

    const rows = await projection(survivor)
    expect(rows.map(r => [r.key, r.value])).toEqual([['city', 'Varna'], ['tier', 'from-survivor']])
    expect(await projection(absorbed)).toEqual([])            // the emptied side is gone
    await consistent()
  })

  it('survives a DELETE, falling back to whatever remains', async () => {
    // erase() deletes fact rows for GDPR. Deleting the CURRENT row must promote the
    // previous one, not leave a stale winner or an orphan.
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'old', source: 't', observed_at: d('2026-05-01') })
    await facts.record({ passport_id: p, key: 'tier', value: 'new', source: 't', observed_at: d('2026-05-02') })
    const winner = (await projection(p))[0].fact_id

    await db('whitebox_facts').where({ id: winner }).del()
    expect((await projection(p))[0].value).toBe('old')        // promoted
    await consistent()

    await db('whitebox_facts').where({ passport_id: p, key: 'tier' }).del()
    expect(await projection(p)).toEqual([])                  // nothing left, no orphan
    await consistent()
  })

  it('cannot be bypassed by raw SQL that never went through this module', async () => {
    // The reason it is a trigger and not application code. A migration or a psql
    // session at 2am maintains it without knowing it exists.
    const p = await newPassport()
    await db.raw(
      `insert into whitebox_facts (passport_id, key, value, type, source, observed_at)
       values (?, 'tier', ?::jsonb, 'string', 'manual', now())`, [p, JSON.stringify('hand-written')])
    expect((await projection(p))[0].value).toBe('hand-written')
    await consistent()
  })

  it('rolls back with the transaction that wrote it', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'committed', source: 't' })
    await expect(db.transaction(async trx => {
      await trx('whitebox_facts').insert({
        passport_id: p, key: 'tier', value: JSON.stringify('rolled-back'),
        type: 'string', source: 't', observed_at: new Date(),
      })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect((await projection(p))[0].value).toBe('committed')
    await consistent()
  })

  it('verifyCurrent REPORTS drift rather than hiding it, and rebuild repairs it', async () => {
    // The projection is only trustworthy if a check exists that can fail. Drift is
    // forced here by disabling the triggers — the one way to desynchronise it.
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'real', source: 't' })
    await db.raw('ALTER TABLE whitebox_facts DISABLE TRIGGER USER')
    await facts.record({ passport_id: p, key: 'tier', value: 'newer-but-unseen', source: 't' })
    await db.raw('ALTER TABLE whitebox_facts ENABLE TRIGGER USER')

    const drift = await facts.verifyCurrent()
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ key: 'tier', problem: 'wrong row' })

    await facts.rebuildCurrent()
    await consistent()
    expect((await projection(p))[0].value).toBe('newer-but-unseen')
  })

  it('reports a row missing from the projection, distinctly from a wrong one', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'tier', value: 'x', source: 't' })
    await db('whitebox_facts_current').where({ passport_id: p }).del()
    const drift = await facts.verifyCurrent()
    expect(drift).toHaveLength(1)
    expect(drift[0].problem).toBe('missing from projection')
    await facts.rebuildCurrent()
    await consistent()
  })
})
