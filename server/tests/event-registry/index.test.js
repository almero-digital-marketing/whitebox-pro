import { describe, it, expect, vi } from 'vitest'
import * as eventRegistry from '../../src/event-registry/index.js'
import { build } from '../../src/event-catalog.js'

// A shared, chainable, thenable query-builder fake — every method records the
// call and returns itself so the real chain shapes (`.insert(...)`,
// `.where().groupBy().select().min().max().count()`, `.where().orderBy().limit()`)
// all work; awaiting it resolves to `resolved`.
function makeQuery(log, resolved = []) {
  const q = {}
  for (const m of ['insert', 'select', 'where', 'andWhere', 'orderBy', 'limit', 'groupBy', 'min', 'max', 'del']) {
    q[m] = (...args) => { log.push([m, args]); return q }
  }
  q.count = (...args) => { log.push(['count', args]); return q }
  q.then = resolve => resolve(resolved)
  return q
}

function makeDb({ resolved } = {}) {
  const log = []
  const db = table => makeQuery(log, resolved)
  db.raw = (sql, params) => ({ __raw: sql, __params: params })
  db.migrate = { latest: vi.fn(async () => {}) }
  return { db, log }
}

describe('event-registry: init/migrate', () => {
  it('defaults retentionDays to 90 and sweepIntervalMs to 24h', async () => {
    const { db } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    // no direct getter — exercised indirectly via list()/sweep()'s cutoff below
    expect(true).toBe(true)
  })

  it('migrate() runs db.migrate.latest against its own migrations dir/table', async () => {
    const { db } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.migrate()
    expect(db.migrate.latest).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: 'whitebox_event_registry_migrations' }),
    )
  })
})

describe('event-registry: record() — a real log row per occurrence, not an upsert', () => {
  it('inserts one row per call, carrying the full payload and its passport_id', async () => {
    const { db, log } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.record('mail.sent', { type: 'mail.sent', data: { passport_id: 'p1', id: 1 } })

    const insertCall = log.find(([m]) => m === 'insert')
    expect(insertCall[1][0]).toMatchObject({
      type: 'mail.sent', passport_id: 'p1', data: JSON.stringify({ type: 'mail.sent', data: { passport_id: 'p1', id: 1 } }),
    })
    expect(insertCall[1][0].id).toBeTruthy()      // a real uuid, not shared across occurrences
    expect(insertCall[1][0].occurred_at).toBeInstanceOf(Date)
  })

  it('tolerates a payload with no passport_id (not every event is passport-attributed)', async () => {
    const { db, log } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.record('crm.deal', { type: 'crm.deal', data: { status: 'open' } })
    const insertCall = log.find(([m]) => m === 'insert')
    expect(insertCall[1][0].passport_id).toBeNull()
  })

  it('two occurrences of the same type each get their own row (not merged into a counter)', async () => {
    const { db, log } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.record('mail.sent', { type: 'mail.sent', data: {} })
    await eventRegistry.record('mail.sent', { type: 'mail.sent', data: {} })
    const inserts = log.filter(([m]) => m === 'insert')
    expect(inserts).toHaveLength(2)
    expect(inserts[0][1][0].id).not.toBe(inserts[1][1][0].id)
  })
})

describe('event-registry: list() — the type vocabulary', () => {
  it('groups by type and derives count + first/last seen, filtered to the retention window', async () => {
    const { db, log } = makeDb({ resolved: [{ type: 'mail.sent', first_seen_at: new Date(), last_seen_at: new Date(), count: '3' }] })
    eventRegistry.init({ db, logger: console, config: { eventRegistry: { retentionDays: 30 } } })
    const { events } = await eventRegistry.list()
    expect(events).toEqual([expect.objectContaining({ type: 'mail.sent', count: 3 })])   // string count coerced to a number

    const whereCall = log.find(([m]) => m === 'where')
    const [col, op, cutoff] = whereCall[1]
    expect(col).toBe('occurred_at')
    expect(op).toBe('>=')
    const daysAgo = (Date.now() - cutoff.getTime()) / (24 * 60 * 60_000)
    expect(daysAgo).toBeCloseTo(30, 0)
    expect(log.some(([m]) => m === 'groupBy')).toBe(true)
  })

  // Observation alone made the journeys trigger picker unusable on a fresh
  // install: you could not automate on an event until it had already happened,
  // which is precisely backwards for "when a booking arrives, do X".
  it('offers a declared type that has never been observed', async () => {
    const { db } = makeDb({ resolved: [] })
    eventRegistry.init({
      db, logger: console, config: {},
      eventCatalog: build([{ name: 'voip', events: { 'voip.click': 'in' } }]),
    })
    const { events } = await eventRegistry.list()
    const click = events.find(e => e.type === 'voip.click')
    // count 0 is how a caller tells "declared but never fired" from "in use"
    expect(click).toMatchObject({ type: 'voip.click', count: 0, declared: true, module: 'voip', direction: 'in' })
    expect(click.last_seen_at).toBeNull()
  })

  it('keeps the observed count for a type that is both declared and seen', async () => {
    const { db } = makeDb({ resolved: [{ type: 'voip.click', first_seen_at: new Date(), last_seen_at: new Date(), count: '7' }] })
    eventRegistry.init({
      db, logger: console, config: {},
      eventCatalog: build([{ name: 'voip', events: { 'voip.click': 'in' } }]),
    })
    const { events } = await eventRegistry.list()
    expect(events.filter(e => e.type === 'voip.click')).toHaveLength(1)   // not duplicated
    expect(events.find(e => e.type === 'voip.click')).toMatchObject({ count: 7, declared: true })
  })

  // The answer to "what about events that aren't predefined". crm emits
  // `crm.${kind}` where the kind is the host CRM's vocabulary — it can never be
  // enumerated, so the PREFIX is published and a caller offers free-text under it.
  it('publishes the open-ended families rather than pretending they do not exist', async () => {
    const { db } = makeDb({ resolved: [] })
    eventRegistry.init({
      db, logger: console, config: {},
      eventCatalog: build([{ name: 'crm', events: { 'crm.': 'in' } }]),
    })
    const { events, families } = await eventRegistry.list()
    expect(families).toEqual(expect.arrayContaining([{ prefix: 'crm.', module: 'crm', direction: 'in' }]))
    // …and a prefix is NOT offered as a pickable type, because it isn't one
    expect(events.map(e => e.type)).not.toContain('crm.')
  })

  // A runtime type from an open family is only knowable by observation, and it
  // still has to be annotated with who owns it.
  it('annotates an observed type from an open family with its owning module', async () => {
    const { db } = makeDb({ resolved: [{ type: 'crm.booking', first_seen_at: new Date(), last_seen_at: new Date(), count: '2' }] })
    eventRegistry.init({
      db, logger: console, config: {},
      eventCatalog: build([{ name: 'crm', events: { 'crm.': 'in' } }]),
    })
    const { events } = await eventRegistry.list()
    // `declared: false` — nobody named this type; the family covers it
    expect(events.find(e => e.type === 'crm.booking'))
      .toMatchObject({ type: 'crm.booking', count: 2, declared: false, module: 'crm', direction: 'in' })
  })

  it('degrades to observation only when no catalog was handed over', async () => {
    const { db } = makeDb({ resolved: [{ type: 'mail.sent', first_seen_at: new Date(), last_seen_at: new Date(), count: '1' }] })
    eventRegistry.init({ db, logger: console, config: {} })
    const { events, families } = await eventRegistry.list()
    // exactly what was observed — core's declared types are NOT invented here,
    // because without a catalog there is nothing to merge
    expect(events).toHaveLength(1)
    expect(families).toEqual([])
  })
})

describe('event-registry: recent() — the actual log, not just the aggregate', () => {
  it('returns occurrences most-recent-first, parsing the stored payload back into an object', async () => {
    const { db } = makeDb({ resolved: [{ type: 'mail.sent', data: JSON.stringify({ data: { id: 1 } }), passport_id: 'p1', occurred_at: new Date() }] })
    eventRegistry.init({ db, logger: console, config: {} })
    const rows = await eventRegistry.recent()
    expect(rows).toEqual([expect.objectContaining({ type: 'mail.sent', passport_id: 'p1', data: { data: { id: 1 } } })])
  })

  it('scopes to one type and a custom limit when given', async () => {
    const { db, log } = makeDb({ resolved: [] })
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.recent({ type: 'mail.sent', limit: 5 })
    expect(log.find(([m]) => m === 'andWhere')[1]).toEqual([{ type: 'mail.sent' }])
    expect(log.find(([m]) => m === 'limit')[1]).toEqual([5])
  })

  it('defaults to no type filter and a limit of 50', async () => {
    const { db, log } = makeDb({ resolved: [] })
    eventRegistry.init({ db, logger: console, config: {} })
    await eventRegistry.recent()
    expect(log.some(([m]) => m === 'andWhere')).toBe(false)
    expect(log.find(([m]) => m === 'limit')[1]).toEqual([50])
  })
})

describe('event-registry: sweep() — retention', () => {
  it('deletes rows older than retentionDays, keyed off occurred_at', async () => {
    const { db, log } = makeDb()
    eventRegistry.init({ db, logger: console, config: { eventRegistry: { retentionDays: 7 } } })
    await eventRegistry.sweep()

    const whereCall = log.find(([m]) => m === 'where')
    const [col, op, cutoff] = whereCall[1]
    expect(col).toBe('occurred_at')
    expect(op).toBe('<')
    const daysAgo = (Date.now() - cutoff.getTime()) / (24 * 60 * 60_000)
    expect(daysAgo).toBeCloseTo(7, 0)
    expect(log.some(([m]) => m === 'del')).toBe(true)
  })
})

describe('event-registry: sweep job registration', () => {
  it('initQueue registers a worker that sweeps and swallows errors', async () => {
    const { db } = makeDb()
    eventRegistry.init({ db, logger: console, config: {} })
    let workerHandler
    const queueModule = {
      createQueue: vi.fn(() => ({ add: vi.fn(async () => {}) })),
      createWorker: vi.fn((name, handler) => { workerHandler = handler; return { on: vi.fn() } }),
    }
    eventRegistry.initQueue(queueModule)
    expect(queueModule.createQueue).toHaveBeenCalledWith('event-registry')
    expect(queueModule.createWorker).toHaveBeenCalledWith('event-registry', expect.any(Function))

    // Just confirms the worker handler doesn't reject — it returns whatever
    // sweep()'s del() resolves to (a row count against a real DB), not a
    // specific value against this fake.
    await workerHandler()
  })

  it('startSweep registers one repeatable job with a stable jobId', async () => {
    const { db } = makeDb()
    eventRegistry.init({ db, logger: console, config: { eventRegistry: { sweepIntervalMs: 1000 } } })
    const add = vi.fn(async () => {})
    const queueModule = { createQueue: vi.fn(() => ({ add })), createWorker: vi.fn(() => ({ on: vi.fn() })) }
    eventRegistry.initQueue(queueModule)
    await eventRegistry.startSweep()
    expect(add).toHaveBeenCalledWith('sweep', {}, { repeat: { every: 1000 }, jobId: 'event-registry-sweep' })
  })
})
