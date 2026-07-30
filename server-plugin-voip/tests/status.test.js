// docs/10-plugin-status.md — the plugin describes its own health and the board
// holds no voip knowledge.
//
// voip's status() was previously untested. It is the plugin that motivated `of` and
// `live` on a metric, because the number pool is a read of THIS PROCESS's assignment
// map: it has no history to window, does not survive a restart, and does not extend
// to a second instance. The call counts beside it are an ordinary SQL aggregate.
import { describe, it, expect, vi } from 'vitest'
import * as calls from '../src/calls.js'

// Minimal knex stand-in for the one query stats() runs: select('status') +
// count('* as n') + groupBy('status'), optionally windowed on started_at. Counts
// come back as STRINGS, the way node-pg returns aggregates, so a missing Number()
// would surface here rather than as "0" on the real board.
function makeDb(rows = []) {
  return () => {
    const preds = []
    const q = {
      select: () => q,
      count: () => q,
      groupBy: () => q,
      where: (col, op, val) => { preds.push(r => op === '>=' ? r[col] >= val : r[col] === op); return q },
      then(resolve, reject) {
        try {
          const matched = rows.filter(r => preds.every(f => f(r)))
          const by = new Map()
          for (const r of matched) by.set(r.status, (by.get(r.status) || 0) + 1)
          resolve([...by].map(([status, n]) => ({ status, n: String(n) })))
        } catch (err) { reject(err) }
      },
    }
    return q
  }
}

const HOUR = 60 * 60 * 1000
const since = new Date(Date.now() - HOUR)
const recent = new Date(Date.now() - 60_000)

const someCalls = [
  { status: 'ringing', started_at: recent },
  { status: 'active', started_at: recent },
  { status: 'ended', started_at: recent },
  { status: 'ended', started_at: recent },
  { status: 'missed', started_at: recent },
]

// What pool.stats() returns — see src/pool.js. In-memory, hence no db.
const pool = (over = {}) => () => ({
  visitors: 1,
  tags: [{ tag: 'web', total: 8, available: 5, assigned: 3, waiting: 0, exhausted: false }],
  total: 8, assigned: 3, waiting: 0,
  ...over,
})

const at = (s, key) => s.metrics.find(m => m.key === key)

describe('calls.status', () => {
  it('reports the windowed call counts and marks only `missed` bad', async () => {
    calls.init({ db: makeDb(someCalls) })
    const s = await calls.status({ since, pool: pool() })
    expect(s.label).toBe('voip')
    expect(at(s, 'ringing').value).toBe(1)
    expect(at(s, 'active').value).toBe(1)
    expect(at(s, 'ended').value).toBe(2)
    expect(at(s, 'missed').value).toBe(1)
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['missed'])
  })

  // The pool is a different KIND of number from the four above it, and the flags are
  // how the board is told: `of` because "3 of 8 held" is the claim and either number
  // alone says nothing, `live` because there is no history of it to window.
  it('reports the pool as a ratio, flagged as current state', async () => {
    calls.init({ db: makeDb(someCalls) })
    const s = await calls.status({ since, pool: pool() })
    expect(at(s, 'web')).toMatchObject({ key: 'web', value: 3, of: 8, live: true })
    // and the call counts are NOT live — they are windowed on started_at
    expect(at(s, 'missed').live).toBeUndefined()
  })

  it('marks an exhausted pool bad, on the plugin\'s own judgement rather than used === total', async () => {
    calls.init({ db: makeDb([]) })
    const s = await calls.status({
      since,
      pool: pool({ tags: [{ tag: 'web', total: 8, available: 0, assigned: 8, waiting: 2, exhausted: true }], waiting: 2 }),
    })
    expect(at(s, 'web')).toMatchObject({ value: 8, of: 8, severity: 'bad' })
    expect(s.note).toMatch(/2 visitors waiting for a number/)
  })

  // A full pool with nobody waiting is not a fault: every number being in use is
  // what a working pool looks like at peak.
  it('does not flag a full pool when nobody is waiting on it', async () => {
    calls.init({ db: makeDb([]) })
    const s = await calls.status({
      since,
      pool: pool({ tags: [{ tag: 'web', total: 8, available: 0, assigned: 8, waiting: 0, exhausted: false }] }),
    })
    expect(at(s, 'web').severity).toBeUndefined()
    expect(s.note).toBeNull()
  })

  it('reports the calls alone when no pool is wired', async () => {
    calls.init({ db: makeDb(someCalls) })
    const s = await calls.status({ since })
    expect(s.metrics.map(m => m.key)).toEqual(['ringing', 'active', 'ended', 'missed'])
    expect(s.note).toBeNull()
  })

  it('windows the call counts, leaving older calls out', async () => {
    calls.init({ db: makeDb([...someCalls, { status: 'missed', started_at: new Date(Date.now() - 40 * 24 * HOUR) }]) })
    expect(at(await calls.status({ since, pool: pool() }), 'missed').value).toBe(1)
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md) — the guard that
// stops the next metric shipping as a bare key.
describe('calls.status descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    calls.init({ db: makeDb(someCalls) })
    const s = await calls.status({ since, pool: pool() })
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

  // The pool rows are generated per tag, so their prose must be generated too — a
  // shared constant would name the wrong tag and the wrong ceiling.
  it('names the tag and its ceiling in the generated pool prose', async () => {
    calls.init({ db: makeDb([]) })
    const s = await calls.status({
      since,
      pool: pool({ tags: [
        { tag: 'web', total: 8, available: 5, assigned: 3, waiting: 0, exhausted: false },
        { tag: 'sales', total: 2, available: 2, assigned: 0, waiting: 0, exhausted: false },
      ] }),
    })
    expect(at(s, 'web').description).toContain('web')
    expect(at(s, 'web').description).toContain('8')
    expect(at(s, 'sales').description).toContain('sales')
    expect(at(s, 'web').description).not.toBe(at(s, 'sales').description)
  })

  // The pool's surprising properties — not windowed, dies on a restart, per-instance
  // — do NOT fit in a one-line inline description, and forcing them in would break
  // the constraint every other counter is held to. They live in the source comment
  // and in docs/10-plugin-status.md; what the prose has to carry is the RATIO, since
  // "3" without "of 8" is the thing an operator would misread.
  it('carries the ratio, which is the part the number alone cannot say', async () => {
    calls.init({ db: makeDb([]) })
    const s = await calls.status({ since, pool: pool() })
    const d = at(s, 'web').description
    expect(d).toMatch(/in use/i)
    expect(d).toMatch(/of 8/)
    expect(d.length).toBeLessThanOrEqual(72)
  })
})
