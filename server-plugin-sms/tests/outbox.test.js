import { describe, it, expect, vi } from 'vitest'
import * as outbox from '../src/outbox.js'

// Same knex-chain mock shape as server-plugin-mail/tests/outbox.test.js —
// .returning() must resolve synchronously off a plain object, not a Promise.
function makeDb(rows = {}) {
  const store = { ...rows }
  let nextId = 1

  const chain = (currentRows, prefiltered) => {
    const baseRows = prefiltered ?? currentRows
    return {
      where: (...args) => {
        let filtered
        if (args.length === 1 && typeof args[0] === 'object') {
          const cond = args[0]
          filtered = baseRows.filter(r => Object.entries(cond).every(([k, v]) => r[k] === v))
        } else {
          filtered = baseRows
        }
        return {
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
    }
  }

  function db(table) {
    if (!store[table]) store[table] = []
    return chain(store[table])
  }
  db.store = store
  return db
}

function makeOutbox() {
  const db = makeDb()
  const queue = { add: vi.fn(), remove: vi.fn(async () => 1) }
  const q = { createQueue: vi.fn(() => queue), createWorker: vi.fn(() => ({ on: vi.fn() })) }
  const sessions = { resolve: vi.fn(async () => null) }
  const notify = vi.fn(async () => {})
  const config = { sms: { defaultCountry: 'BG' } }
  const logger = { error: vi.fn(), warn: vi.fn() }
  outbox.init({ db, q, templates: null, passports: null, sessions, awareness: null, notify, config, logger })
  return { outbox, db, queue, sessions, notify }
}

describe('outbox.queueSend', () => {
  it('normalizes the recipient, creates a row, enqueues a send job, and notifies sms.queued', async () => {
    const { outbox, queue, notify } = makeOutbox()
    const row = await outbox.queueSend({ to: '+359888123456', body: 'hello' })
    expect(row.to).toBe('+359888123456')
    expect(row.status).toBe('queued')
    expect(queue.add).toHaveBeenCalledWith('send', { id: row.id }, { jobId: undefined })
    expect(notify).toHaveBeenCalledWith('sms.queued', { type: 'sms.queued', data: row })
  })

  it('throws a 400 on an unusable phone number, before ever touching the db', async () => {
    const { outbox, db } = makeOutbox()
    await expect(outbox.queueSend({ to: 'not-a-phone', body: 'hi' })).rejects.toMatchObject({ status: 400 })
    expect(db.store['whitebox_sms_outbox'] ?? []).toHaveLength(0)
  })

  it('resolves an existing session for the passport and stamps session_id onto the row', async () => {
    const { outbox, sessions } = makeOutbox()
    sessions.resolve.mockResolvedValueOnce({ id: 'sess-1', passport_id: 'p-1' })
    const row = await outbox.queueSend({ to: '+359888123456', body: 'hi', passportId: 'p-1' })
    expect(row.session_id).toBe('sess-1')
    expect(sessions.resolve).toHaveBeenCalledWith('p-1')
  })

  it('reuses the existing row on a repeat idempotencyKey and re-enqueues under the SAME jobId', async () => {
    // Same nuance as mail's outbox.queueSend test: the dedup guarantee is
    // BullMQ's own same-jobId no-op on a real Queue, not app-level suppression.
    const { outbox, queue } = makeOutbox()
    const first = await outbox.queueSend({ to: '+359888123456', body: 'hi', idempotencyKey: 'journey:enr1:step1' })
    const second = await outbox.queueSend({ to: '+359888123456', body: 'hi', idempotencyKey: 'journey:enr1:step1' })
    expect(second.id).toBe(first.id)
    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add.mock.calls[0][2]).toEqual({ jobId: 'journey:enr1:step1' })
    expect(queue.add.mock.calls[1][2]).toEqual({ jobId: 'journey:enr1:step1' })
  })
})

// docs/10-plugin-status.md. Previously untested here: `sent` vs `delivered` vs
// `bounced` is exactly the distinction nobody can infer from three one-word keys,
// and on SMS `delivered` has a trap of its own — plenty of carriers never return a
// receipt, so it can trail `sent` forever with nothing wrong.
describe('outbox.status — self-describing health', () => {
  const statsDb = () => {
    const db = () => ({
      where: () => db(),
      select: async () => [{ total: 6, queued: 1, sent: 5, delivered: 3, failed: 1, bounced: 2 }],
    })
    db.raw = (sql) => sql
    return db
  }
  const boot = () => outbox.init({
    db: statsDb(),
    q: { createQueue: () => ({}), createWorker: () => ({ on: () => {} }) },
    templates: {}, passports: {}, sessions: {}, awareness: { record: vi.fn() },
    notify: vi.fn(), config: { sms: {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })

  it('names its own numbers and marks only the failures bad', async () => {
    boot()
    const s = await outbox.status({ since: new Date(Date.now() - 3600_000) })
    expect(s.label).toBe('sms')
    expect(s.metrics.map(m => m.key)).toEqual(['queued', 'sent', 'delivered', 'failed', 'bounced'])
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['failed', 'bounced'])
  })

  it('gives every metric a description that says more than the key', async () => {
    boot()
    const s = await outbox.status({ since: new Date() })
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) expect(m.description.length).toBeGreaterThan(m.key.length + 20)
  })

  it('warns that a missing delivery receipt is not necessarily a fault', async () => {
    boot()
    const s = await outbox.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'delivered').description).toMatch(/never send one|without anything being wrong/i)
  })
})
