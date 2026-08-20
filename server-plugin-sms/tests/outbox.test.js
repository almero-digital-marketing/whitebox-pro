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
      // Supports .where({col: val}), .where(col, val) and .where(col, op, val),
      // and chains — markStuck does .where('status', …).where('queued_at', '<', …).
      where: (...args) => {
        let filtered
        if (args.length === 1 && typeof args[0] === 'object') {
          const cond = args[0]
          filtered = baseRows.filter(r => Object.entries(cond).every(([k, v]) => r[k] === v))
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
        return {
          where: chain(currentRows, filtered).where,
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

function makeOutbox(jobCounts) {
  const db = makeDb()
  const queue = { add: vi.fn(), remove: vi.fn(async () => 1) }
  // getJobCounts only exists when a test asks for it, so the default fake keeps
  // behaving like a queue whose depth cannot be read.
  if (jobCounts) {
    queue.getJobCounts = typeof jobCounts === 'function' ? vi.fn(jobCounts) : vi.fn(async () => jobCounts)
  }
  const q = { createQueue: vi.fn(() => queue), createWorker: vi.fn(() => ({ on: vi.fn() })) }
  const sessions = { resolve: vi.fn(async () => null) }
  const notify = vi.fn(async () => {})
  const config = { sms: { defaultCountry: 'BG' } }
  const logger = { error: vi.fn(), warn: vi.fn() }
  outbox.init({ db, q, templates: null, passports: null, sessions, awareness: null, notify, config, logger })
  return { outbox, db, queue, sessions, notify, q, logger }
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

  it('warns that a missing delivery receipt is not necessarily a fault', async () => {
    boot()
    const s = await outbox.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'delivered').description).toMatch(/not all networks confirm/i)
  })
})


// Same trap as mail: BullMQ honours defaultJobOptions on a Queue and silently
// ignores it on a Worker, so misplacing it leaves every send on one attempt.
describe('sms outbox queue/worker wiring', () => {
  it('puts defaultJobOptions on the queue, not the worker', async () => {
    const { q } = makeOutbox()

    const queueOpts = q.createQueue.mock.calls[0][1]
    expect(queueOpts.defaultJobOptions).toMatchObject({ removeOnComplete: true })
    expect(queueOpts.defaultJobOptions.attempts).toBeGreaterThan(0)
    expect(queueOpts.defaultJobOptions.backoff).toMatchObject({ type: 'exponential' })

    expect(q.createWorker.mock.calls[0][2]).not.toHaveProperty('defaultJobOptions')
  })
})


// Ported from plugin-mail 0.6.2: sms carried the identical age-only reaper and
// the identical silent drop, and escaped the incident only because its default
// rate window is 1000ms rather than 60000ms.
describe('sms outbox.markStuck is queue-aware', () => {
  it('does not reap while the queue still has waiting jobs', async () => {
    const { outbox, db, notify } = makeOutbox({ waiting: 500, active: 1, delayed: 0, prioritized: 0, paused: 0 })
    await db('whitebox_sms_outbox').insert({ status: 'queued', queued_at: new Date(Date.now() - 60 * 60 * 1000) })

    expect(await outbox.markStuck(10 * 60 * 1000)).toBe(0)
    expect(db.store['whitebox_sms_outbox'][0].status).toBe('queued')
    expect(notify).not.toHaveBeenCalled()
  })

  it('counts prioritized jobs, which `waiting` excludes', async () => {
    const { outbox, db } = makeOutbox({ waiting: 0, active: 0, delayed: 0, prioritized: 7, paused: 0 })
    await db('whitebox_sms_outbox').insert({ status: 'queued', queued_at: new Date(Date.now() - 60 * 60 * 1000) })
    expect(await outbox.markStuck(10 * 60 * 1000)).toBe(0)
    expect(db.store['whitebox_sms_outbox'][0].status).toBe('queued')
  })

  it('reaps genuinely orphaned rows once the queue has drained', async () => {
    const { outbox, db } = makeOutbox({ waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0 })
    await db('whitebox_sms_outbox').insert({ status: 'queued', queued_at: new Date(Date.now() - 60 * 60 * 1000) })
    expect(await outbox.markStuck(10 * 60 * 1000)).toBe(1)
    expect(db.store['whitebox_sms_outbox'][0].failure_reason).toBe('stuck')
  })

  it('skips the sweep rather than reaping blind when the depth cannot be read', async () => {
    const { outbox, db, logger } = makeOutbox(async () => { throw new Error('redis down') })
    await db('whitebox_sms_outbox').insert({ status: 'queued', queued_at: new Date(Date.now() - 60 * 60 * 1000) })
    expect(await outbox.markStuck(10 * 60 * 1000)).toBe(0)
    expect(db.store['whitebox_sms_outbox'][0].status).toBe('queued')
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('sms outbox.reclaimIfReaped', () => {
  it('returns a row the reaper failed as stuck back to queued', async () => {
    const { outbox, db } = makeOutbox()
    await db('whitebox_sms_outbox').insert({ status: 'failed', failure_reason: 'stuck', failed_at: new Date() })
    const stored = db.store['whitebox_sms_outbox'][0]

    const row = await outbox.reclaimIfReaped(stored)
    expect(row.status).toBe('queued')
    expect(row.failure_reason).toBeNull()
    expect(stored.status).toBe('queued')
  })

  it('leaves rows failed for any other reason, and sent/cancelled rows, alone', async () => {
    const { outbox } = makeOutbox()
    expect((await outbox.reclaimIfReaped({ id: 1, status: 'failed', failure_reason: 'suppressed' })).status).toBe('failed')
    expect((await outbox.reclaimIfReaped({ id: 2, status: 'sent' })).status).toBe('sent')
    expect((await outbox.reclaimIfReaped({ id: 3, status: 'cancelled', failure_reason: 'cancelled' })).status).toBe('cancelled')
  })
})

describe('sms outbox worker concurrency', () => {
  it('gives the worker a concurrency above 1', async () => {
    const { q } = makeOutbox()
    expect(q.createWorker.mock.calls[0][2].concurrency).toBeGreaterThan(1)
  })

  it('honours a configured concurrency', async () => {
    const db = makeDb()
    const q = { createQueue: vi.fn(() => ({ add: vi.fn() })), createWorker: vi.fn(() => ({ on: vi.fn() })) }
    outbox.init({
      db, q, templates: null, passports: null, sessions: { resolve: vi.fn(async () => null) },
      awareness: null, notify: vi.fn(async () => {}),
      config: { sms: { outbox: { concurrency: 4 } } },
      logger: { error: vi.fn(), warn: vi.fn() },
    })
    expect(q.createWorker.mock.calls[0][2].concurrency).toBe(4)
  })
})
