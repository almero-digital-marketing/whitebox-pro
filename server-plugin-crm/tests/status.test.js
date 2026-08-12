import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import * as state from '../src/state.js'
import * as ingest from '../src/ingest.js'
import { crm } from '../src/index.js'

// No DB — CRM owns no table, so status() reads the two CORE tables it writes
// through (whitebox_facts, whitebox_awareness_exposures). The fake builder answers
// per table and records how each query was built, so a test can assert the window
// column and the scoping without a server to run the SQL.
function makeDb({
  facts = { records: 0, facts: 0 },
  notes = { notes: 0, observations: 0 },
  fails = () => false,
} = {}) {
  const seen = []

  function db(table) {
    const q = { table, wheres: [], notNull: [] }
    const chain = {
      where(...args) { q.wheres.push(args); return chain },
      whereNotNull(col) { q.notNull.push(col); return chain },
      select(...args) { q.selected = args; return chain },
      // Knex builders are thenables; awaiting one runs it.
      then(resolve, reject) {
        seen.push(q)
        return (async () => {
          if (fails(q)) throw new Error('relation does not exist')
          return [table === 'whitebox_facts' ? facts : notes]
        })().then(resolve, reject)
      },
    }
    return chain
  }

  db.raw = sql => ({ sql })
  db.seen = seen
  return db
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function setup(opts) {
  const db = makeDb(opts)
  state.init({ facts: { record: vi.fn(), current: vi.fn() }, logger, notify: vi.fn(), db })
  ingest.init({ passports: {}, awareness: { record: vi.fn() }, logger, db })
  return db
}

beforeEach(() => vi.clearAllMocks())

describe('crm state.stats (records → core facts)', () => {
  it('counts externally-identified fact rows, windowed on recorded_at', async () => {
    const since = new Date('2026-07-01T00:00:00Z')
    const db = setup({ facts: { records: 4, facts: 11 } })

    expect(await state.stats({ since })).toEqual({ records: 4, facts: 11 })

    const q = db.seen[0]
    expect(q.table).toBe('whitebox_facts')
    // `external_id` is what marks a row as this adapter's — core facts has no `plugin`
    // column, so there is nothing else to scope by.
    expect(q.notNull).toEqual(['external_id'])
    // recorded_at (when we learned it), NOT observed_at — a backdated import is
    // recent ingest with old event times.
    expect(q.wheres).toEqual([['recorded_at', '>=', since]])
  })

  it('accepts a since string as well as a Date, and omits the window when unset', async () => {
    const db = setup()
    await state.stats({ since: '2026-07-01T00:00:00Z' })
    expect(db.seen[0].wheres[0][2]).toEqual(new Date('2026-07-01T00:00:00Z'))
    await state.stats({})
    expect(db.seen[1].wheres).toEqual([])
  })
})

describe('crm ingest.noteStats (notes → awareness)', () => {
  it('scopes to the plugin-stamped rows and windows on created_at', async () => {
    const since = new Date('2026-07-01T00:00:00Z')
    const db = setup({ notes: { notes: 6, observations: 2 } })

    expect(await ingest.noteStats({ since })).toEqual({ notes: 6, observations: 2 })

    const q = db.seen[0]
    expect(q.table).toBe('whitebox_awareness_exposures')
    // Exact attribution: the plugin loader stamps `plugin` on every awareness row.
    expect(q.wheres).toEqual([[{ plugin: 'crm' }], ['created_at', '>=', since]])
    // Client observations are split out via meta->>'client', not via `source`
    // (which the caller supplies on that path).
    expect(q.selected.map(r => r.sql).join(' ')).toMatch(/meta->>'client'/)
  })
})

// Shape assertions here stay EXACT — they assert the absence of `severity` as much
// as its presence, which toMatchObject would stop checking. So the prose is dropped,
// not the strictness; that every metric HAS prose is its own test below.
const shape = (m) => { const { description, ...rest } = m || {}; return rest }

describe('crm ingest.status', () => {
  it('reports both pipelines and names the drop it cannot see', async () => {
    setup({ facts: { records: 4, facts: 11 }, notes: { notes: 6, observations: 2 } })

    const s = await ingest.status({ since: new Date('2026-07-01T00:00:00Z') })

    expect(s.label).toBe('crm')
    expect(s.metrics.map(shape)).toEqual([
      { key: 'records', value: 4 },
      { key: 'state facts', value: 11 },
      { key: 'notes', value: 6 },
      { key: 'observations', value: 2 },
    ])
    // Nothing CRM can count is a failure, so nothing is marked bad — and the one
    // real failure (a payload dropped for no identity) has no counter behind it,
    // so the note says so rather than a zero implying "nothing was dropped".
    expect(s.metrics.some(m => m.severity)).toBe(false)
    expect(s.note).toBe('payloads dropped for no identity (202 no_identity) are counted nowhere — only the log has them')
  })

  it('degrades to partial data when one side fails, and says which', async () => {
    setup({ notes: { notes: 6, observations: 0 }, fails: q => q.table === 'whitebox_facts' })

    const s = await ingest.status({})

    expect(s.metrics.find(m => m.key === 'records').value).toBe(0)
    expect(s.metrics.find(m => m.key === 'notes').value).toBe(6)   // the half that worked
    expect(s.note).toMatch(/^record counts unavailable — the numbers above are incomplete; /)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('never throws — with no db at all it still returns a renderable answer', async () => {
    // A plugin that throws is reported as failing rather than as zeros by the
    // board, but a partial answer is better than either.
    state.init({ facts: {}, logger, notify: vi.fn() })
    ingest.init({ passports: {}, awareness: {}, logger })

    const s = await ingest.status({ since: new Date() })

    expect(s.metrics.map(m => m.value)).toEqual([0, 0, 0, 0])
    expect(s.note).toMatch(/record counts and note counts unavailable/)
  })
})

describe('crm register — service.status', () => {
  it('exposes status() on the service so monitoring surfaces discover it', async () => {
    const ctx = {
      db: makeDb({ facts: { records: 1, facts: 1 } }),
      passports: { findByIdentity: vi.fn() },
      facts: { record: vi.fn(), current: vi.fn(async () => ({})) },
      awareness: { record: vi.fn() },
      logger,
    }

    const api = await crm({ auth: { secret: 's' } }).register(express(), ctx)

    expect(typeof api.service.status).toBe('function')
    expect(api).toHaveProperty('state')     // pre-existing surface is untouched
    expect(api).toHaveProperty('ingest')
    const s = await api.service.status({ since: new Date() })
    expect(s.label).toBe('crm')
    expect(s.metrics.find(m => m.key === 'records').value).toBe(1)
  })
})

describe('descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    setup()
    const s = await ingest.status({ since: new Date('2026-07-01T00:00:00Z') })
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
})
