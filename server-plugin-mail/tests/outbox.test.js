import { describe, it, expect, vi } from 'vitest'
import * as outbox from '../src/outbox.js'

function makeDb(rows = {}) {
  const store = { ...rows }
  let nextId = 1

  // Knex chains .returning() synchronously before await, so update/insert must
  // return a plain object with a returning() method, not a Promise.
  const chain = (currentRows, prefiltered) => {
    const baseRows = prefiltered ?? currentRows
    return {
    where: (...args) => {
      // Support both .where({col: val}) and .where('col', op, val) / .where('col', val)
      let filtered
      if (args.length === 1 && typeof args[0] === 'object') {
        const cond = args[0]
        filtered = baseRows.filter(r =>
          Object.entries(cond).every(([k, v]) => r[k] === v)
        )
      } else if (args.length === 2) {
        const [col, val] = args
        filtered = baseRows.filter(r => r[col] === val)
      } else if (args.length === 3) {
        const [col, op, val] = args
        filtered = baseRows.filter(r => {
          if (op === '=') return r[col] === val
          if (op === '<') return r[col] < val
          if (op === '<=') return r[col] <= val
          if (op === '>') return r[col] > val
          if (op === '>=') return r[col] >= val
          return false
        })
      } else {
        filtered = baseRows
      }
      // Allow further chained .where(...) — recurse
      const next = chain(currentRows, filtered)
      return {
        where: next.where,
        whereIn: (col, vals) => {
          const filtered2 = filtered.filter(r => vals.includes(r[col]))
          return {
            update: (data) => {
              filtered2.forEach(r => Object.assign(r, data))
              return { returning: async () => [filtered2[0] || null] }
            },
          }
        },
        first: async () => filtered[0] || null,
        update: (data) => {
          filtered.forEach(r => Object.assign(r, data))
          return { returning: async () => filtered.slice() }
        },
      }
    },
    insert: (data) => {
      const row = { id: nextId++, status: 'queued', ...data }
      currentRows.push(row)
      return { returning: async () => [row] }
    },
  }}

  function db(table) {
    if (!store[table]) store[table] = []
    return chain(store[table])
  }
  db.store = store
  return db
}

// Re-init the outbox singleton with fresh deps per test, return the namespace
// so existing `outbox.track()` / `outbox.create()` call sites are unchanged.
function makeOutbox(initialRows = {}) {
  const db = makeDb(initialRows)
  const queue = { add: vi.fn(), addBulk: vi.fn(), remove: vi.fn(async () => 1) }
  const q = { createQueue: vi.fn(() => queue), createWorker: vi.fn(() => ({ on: vi.fn() })) }
  const notify = vi.fn(async () => {})
  const config = { mail: { outbox: { rate: { max: 10, duration: 60000 } } } }
  const logger = { error: vi.fn(), warn: vi.fn() }
  outbox.init({ db, q, notify, config, logger })
  return { outbox, db, notify, queue }
}

describe('outbox.track status rank', () => {
  it('advances status forward', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'sent' })
    const row = await outbox.track('msg1', 'delivered')
    expect(row?.status).toBe('delivered')
  })

  it('does not go backwards', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'opened' })
    const row = await outbox.track('msg1', 'delivered')
    expect(row).toBeNull()
  })

  it('advances to engaged from opened', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'opened' })
    const row = await outbox.track('msg1', 'engaged')
    expect(row?.status).toBe('engaged')
  })

  it('returns null for unknown provider_message_id', async () => {
    const { outbox } = makeOutbox()
    const row = await outbox.track('unknown', 'delivered')
    expect(row).toBeNull()
  })

  it('returns null for unknown status', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'sent' })
    const row = await outbox.track('msg1', 'bogus')
    expect(row).toBeNull()
  })

  // bounced/complained have no same-named timestamp column in the schema
  // (migration 002 only has `failed_at`) — track() maps both onto it instead
  // of the naive `${status}_at`.
  it('stamps bounced onto failed_at, not a nonexistent bounced_at', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'delivered' })
    const row = await outbox.track('msg1', 'bounced')
    expect(row?.status).toBe('bounced')
    expect(row?.failed_at).toBeTruthy()
    expect(row?.bounced_at).toBeUndefined()
  })

  it('stamps complained onto failed_at, not a nonexistent complained_at', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'delivered' })
    const row = await outbox.track('msg1', 'complained')
    expect(row?.status).toBe('complained')
    expect(row?.failed_at).toBeTruthy()
    expect(row?.complained_at).toBeUndefined()
  })
})

describe('outbox.track recipient backfill (batched rows with no provider id yet)', () => {
  // Bespoke db: the provider_message_id match misses (batched rows have null),
  // the recipient lookup returns a candidate, then the by-id update backfills it.
  function makeBackfillDb(candidate) {
    return () => ({
      where: (cond) => {
        if (cond && 'provider_message_id' in cond) {
          return { whereIn: () => ({ update: () => ({ returning: async () => [] }) }) }
        }
        return { update: (data) => ({ returning: async () => [{ ...candidate, id: cond.id, ...data }] }) }
      },
      whereRaw: () => ({
        whereNull: () => ({ whereNotNull: () => ({ whereIn: () => ({ orderBy: () => ({ first: async () => candidate }) }) }) }),
      }),
    })
  }
  const initOutbox = (db) => outbox.init({
    db,
    q: { createQueue: () => ({}), createWorker: () => ({ on: () => {} }) },
    notify: vi.fn(async () => {}),
    config: { mail: {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })

  it('matches by recipient and backfills the provider_message_id', async () => {
    initOutbox(makeBackfillDb({ id: 7, to: 'a@x.com', status: 'sent', batch_id: 'B', provider_message_id: null }))
    const row = await outbox.track('mg-evt-1', 'opened', { recipient: 'A@X.com' })
    expect(row).toMatchObject({ id: 7, provider_message_id: 'mg-evt-1', status: 'opened' })
  })

  it('returns null when no batched candidate matches the recipient', async () => {
    initOutbox(makeBackfillDb(null))
    const row = await outbox.track('mg-evt-x', 'opened', { recipient: 'nobody@x.com' })
    expect(row).toBeNull()
  })
})

describe('outbox.create idempotency', () => {
  it('returns existing row if idempotency key already exists', async () => {
    const { outbox } = makeOutbox()
    const first = await outbox.create({ to: 'a@b.com', subject: 'Hi', idempotencyKey: 'key1' })
    const second = await outbox.create({ to: 'a@b.com', subject: 'Hi', idempotencyKey: 'key1' })
    expect(first.id).toBe(second.id)
  })

  it('creates a new row without idempotency key', async () => {
    const { outbox } = makeOutbox()
    const first = await outbox.create({ to: 'a@b.com', subject: 'Hi' })
    const second = await outbox.create({ to: 'a@b.com', subject: 'Hi' })
    expect(first.id).not.toBe(second.id)
  })
})

describe('outbox.queueSend', () => {
  it('creates a row, enqueues a send job, and notifies mail.queued', async () => {
    const { outbox, queue, notify } = makeOutbox()
    const row = await outbox.queueSend({ to: 'a@b.com', subject: 'Hi', text: 'hello' })
    expect(row.status).toBe('queued')
    expect(queue.add).toHaveBeenCalledWith('send', { id: row.id }, { jobId: undefined })
    expect(notify).toHaveBeenCalledWith('mail.queued', { type: 'mail.queued', data: row })
  })

  it('reuses the existing row on a repeat idempotencyKey and re-enqueues under the SAME jobId', async () => {
    // outbox.js itself doesn't suppress the second enqueue — the actual
    // dedup guarantee is BullMQ's own "same jobId = no-op" behavior on a
    // real Queue. This test only verifies the jobId stays deterministic
    // across repeat calls, which is what that guarantee depends on.
    const { outbox, queue } = makeOutbox()
    const first = await outbox.queueSend({ to: 'a@b.com', subject: 'Hi', text: 'hello', idempotencyKey: 'journey:enr1:step1' })
    const second = await outbox.queueSend({ to: 'a@b.com', subject: 'Hi', text: 'hello', idempotencyKey: 'journey:enr1:step1' })
    expect(second.id).toBe(first.id)
    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add.mock.calls[0][2]).toEqual({ jobId: 'journey:enr1:step1' })
    expect(queue.add.mock.calls[1][2]).toEqual({ jobId: 'journey:enr1:step1' })
  })
})

describe('outbox.failed', () => {
  it('marks row as failed when terminal', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'queued' })
    const rows = db('whitebox_mail_outbox').store?.['whitebox_mail_outbox'] ?? []
    const id = rows[0]?.id ?? 1
    const row = await outbox.failed(id, { reason: 'timeout', attempts: 5, terminal: true })
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toBe('timeout')
  })

  it('does not mark as failed when not terminal', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ provider_message_id: 'msg1', status: 'queued' })
    const rows = db('whitebox_mail_outbox').store?.['whitebox_mail_outbox'] ?? []
    const id = rows[0]?.id ?? 1
    const row = await outbox.failed(id, { reason: 'timeout', attempts: 2, terminal: false })
    expect(row?.status).toBe('queued')
  })
})

describe('outbox.markStuck', () => {
  it('marks queued rows older than threshold as failed/stuck', async () => {
    const { outbox, db, notify } = makeOutbox()
    const old = new Date(Date.now() - 60 * 60 * 1000) // 1h ago
    const recent = new Date()
    await db('whitebox_mail_outbox').insert({ status: 'queued', queued_at: old })
    await db('whitebox_mail_outbox').insert({ status: 'queued', queued_at: old })
    await db('whitebox_mail_outbox').insert({ status: 'queued', queued_at: recent })
    await db('whitebox_mail_outbox').insert({ status: 'sent', queued_at: old })

    const count = await outbox.markStuck(10 * 60 * 1000) // 10 min threshold
    expect(count).toBe(2)

    const all = db.store['whitebox_mail_outbox']
    expect(all.filter(r => r.failure_reason === 'stuck')).toHaveLength(2)
    expect(all.filter(r => r.failure_reason === 'stuck').every(r => r.status === 'failed')).toBe(true)
    // Recent queued row untouched
    expect(all.find(r => r.queued_at === recent)?.status).toBe('queued')
    // Already-sent row untouched
    expect(all.find(r => r.status === 'sent')).toBeDefined()
    // Notify fired once per stuck row
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith('mail.failed', expect.objectContaining({ type: 'mail.failed' }))
  })

  it('returns 0 when nothing to reap', async () => {
    const { outbox } = makeOutbox()
    const count = await outbox.markStuck(10 * 60 * 1000)
    expect(count).toBe(0)
  })
})

describe('outbox.cancelBatch', () => {
  it('cancels only queued rows in the batch', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ batch_id: 'B', status: 'queued' })
    await db('whitebox_mail_outbox').insert({ batch_id: 'B', status: 'queued' })
    await db('whitebox_mail_outbox').insert({ batch_id: 'B', status: 'sent' })
    await db('whitebox_mail_outbox').insert({ batch_id: 'A', status: 'queued' })

    const result = await outbox.cancelBatch('B')
    expect(result.cancelled).toBe(2)

    const all = db.store['whitebox_mail_outbox']
    const cancelled = all.filter(r => r.status === 'cancelled')
    expect(cancelled).toHaveLength(2)
    expect(cancelled.every(r => r.batch_id === 'B')).toBe(true)
    // Other batch untouched
    expect(all.find(r => r.batch_id === 'A')?.status).toBe('queued')
    // Already-sent untouched
    expect(all.find(r => r.batch_id === 'B' && r.status === 'sent')).toBeDefined()
  })

  it('removes pending BullMQ jobs by row id', async () => {
    const { outbox, db, queue } = makeOutbox()
    await db('whitebox_mail_outbox').insert({ batch_id: 'B', status: 'queued' })
    await db('whitebox_mail_outbox').insert({ batch_id: 'B', status: 'queued' })

    await outbox.cancelBatch('B')
    expect(queue.remove).toHaveBeenCalledTimes(2)
    // jobId is the row id as a string
    expect(queue.remove.mock.calls[0][0]).toMatch(/^\d+$/)
  })

  it('returns cancelled: 0 when no queued rows exist for the batch', async () => {
    const { outbox } = makeOutbox()
    const result = await outbox.cancelBatch('missing')
    expect(result.cancelled).toBe(0)
  })
})

// ── recipient → passport resolution (the dedup fix) ──────────────────────────
function makeResolve({ existing = null } = {}) {
  const db = makeDb({ whitebox_mail_outbox: [] })
  const passports = {
    findByIdentity: vi.fn(async (type, value) => (existing && type === 'email' && value === existing.value) ? { id: existing.id } : null),
    identify: vi.fn(async () => 'minted-new'),
    link: vi.fn(async () => {}),
  }
  const q = { createQueue: vi.fn(() => ({ add: vi.fn() })), createWorker: vi.fn(() => ({ on: vi.fn() })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  outbox.init({ db, q, passports, notify: vi.fn(), config: { mail: {} }, logger })
  return { outbox, db, passports }
}

describe('outbox.resolveRecipient', () => {
  it('reuses the existing passport that already owns the email (no duplicate)', async () => {
    const { outbox, db, passports } = makeResolve({ existing: { id: 'p-jane', value: 'jane@x.com' } })
    const row = { id: 1, to: 'jane@x.com', passport_id: null }
    db.store.whitebox_mail_outbox.push(row)

    const id = await outbox.resolveRecipient(row)

    expect(id).toBe('p-jane')
    expect(passports.findByIdentity).toHaveBeenCalledWith('email', 'jane@x.com')
    expect(passports.identify).not.toHaveBeenCalled()          // did NOT mint a new one
    expect(passports.link).toHaveBeenCalledWith('p-jane', [{ type: 'email', name: 'address', value: 'jane@x.com' }])
    expect(row.passport_id).toBe('p-jane')                     // persisted on the row
    expect(db.store.whitebox_mail_outbox[0].passport_id).toBe('p-jane')
  })

  it('mints a new passport only when the email is unknown', async () => {
    const { outbox, passports } = makeResolve({ existing: null })
    const row = { id: 2, to: 'new@x.com', passport_id: null }

    const id = await outbox.resolveRecipient(row)

    expect(passports.findByIdentity).toHaveBeenCalledWith('email', 'new@x.com')
    expect(passports.identify).toHaveBeenCalledWith(null)
    expect(id).toBe('minted-new')
    expect(passports.link).toHaveBeenCalledWith('minted-new', [{ type: 'email', name: 'address', value: 'new@x.com' }])
  })

  it('uses an explicit passport_id and skips the lookup', async () => {
    const { outbox, passports } = makeResolve({ existing: { id: 'p-other', value: 'k@x.com' } })
    const row = { id: 3, to: 'k@x.com', passport_id: 'explicit' }

    const id = await outbox.resolveRecipient(row)

    expect(id).toBe('explicit')
    expect(passports.findByIdentity).not.toHaveBeenCalled()
    expect(passports.identify).not.toHaveBeenCalled()
    expect(passports.link).toHaveBeenCalledWith('explicit', [{ type: 'email', name: 'address', value: 'k@x.com' }])
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md) — the guard that
// stops the next metric shipping as a bare key. `sent` vs `delivered` vs `bounced`
// is exactly the distinction nobody can infer from the keys.
describe('status() descriptions', () => {
  // Its own db: status() is the only query in this module that uses db.raw(), and
  // the stubs above don't provide it. The numbers are irrelevant here — what's
  // under test is that every metric arrives with prose attached.
  const statsDb = () => {
    const db = () => ({
      where: () => db(),
      select: async () => [{ total: 1, queued: 1, sent: 1, delivered: 1, failed: 1, bounced: 1 }],
    })
    db.raw = (sql) => sql
    return db
  }

  it('gives every metric a description that says more than the key', async () => {
    outbox.init({ db: statsDb(), q: { createQueue: () => ({}), createWorker: () => ({ on: () => {} }) },
      notify: vi.fn(), config: { mail: {} }, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } })
    const s = await outbox.status({ since: new Date(Date.now() - 3600_000) })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) {
      // Rendered inline in a 340px pane, so length is still the constraint — but
      // written for the person USING the system, not for whoever built it, which
      // needs a few more words than a terse engineering label.
      expect(m.description.length).toBeLessThanOrEqual(72)
      // ...and it must still say more than the key already does.
      expect(m.description.toLowerCase()).not.toBe(m.key.toLowerCase())
      expect(m.description.length).toBeGreaterThan(12)
    }
  })

  // The distinction that motivated the whole field: two adjacent keys that mean
  // materially different things, which no surface could infer.
  it('distinguishes sent from delivered in words', async () => {
    outbox.init({ db: statsDb(), q: { createQueue: () => ({}), createWorker: () => ({ on: () => {} }) },
      notify: vi.fn(), config: { mail: {} }, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } })
    const s = await outbox.status({ since: new Date() })
    const at = k => s.metrics.find(m => m.key === k).description
    expect(at('sent')).toMatch(/on their way|not confirmed/i)
    expect(at('delivered')).toMatch(/inbox/i)
    expect(at('sent')).not.toBe(at('delivered'))
  })
})
