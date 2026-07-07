import { describe, it, expect, vi } from 'vitest'
import * as compose from '../src/composition/compose.js'

// A chainable knex-lookalike. Each db(table) call gets its own chain instance,
// so the SAME table queried two different ways in discoverSchema (the grouped
// key-count query vs. the per-key distinct-values query) can resolve differently
// — distinguished by whether .where({key}) was called on that particular chain.
const SAMPLES = { geo_city: ['Sofia', 'Plovdiv'] }

function makeDb() {
  const chainMethods = ['select', 'count', 'groupBy', 'orderBy', 'distinct', 'limit', 'whereNotNull', 'whereRaw']
  function chain(resolveFn) {
    const c = {}
    for (const m of chainMethods) c[m] = vi.fn(() => c)
    c.where = vi.fn((cond) => { c._key = cond?.key; return c })
    c.then = (resolve, reject) => Promise.resolve(resolveFn(c)).then(resolve, reject)
    c.catch = () => c
    return c
  }
  const db = vi.fn((table) => {
    if (table === 'whitebox_facts') {
      return chain((c) => c._key
        ? (SAMPLES[c._key] || []).map((value) => ({ value }))
        : [{ key: 'geo_city', n: 3 }, { key: 'client_status', n: 5 }])
    }
    return chain(() => [])
  })
  db.raw = vi.fn(() => ({ rows: [] }))
  return db
}

describe('discoverSchema — fact labels', () => {
  it('attaches a plugin/config-registered label to each fact key', async () => {
    const facts = { label: vi.fn((key) => ({ geo_city: 'City', client_status: 'Status' }[key] || key)) }
    compose.init({ db: makeDb(), facts, logger: null })
    const schema = await compose.discoverSchema({ refresh: true })
    expect(schema.factKeys).toEqual([
      { key: 'geo_city', label: 'City', sample: ['Sofia', 'Plovdiv'] },
      { key: 'client_status', label: 'Status', sample: [] },
    ])
  })

  it('falls back to the raw key when a key has no registered label', async () => {
    const facts = { label: vi.fn((key) => key) }   // no labels registered anywhere
    compose.init({ db: makeDb(), facts, logger: null })
    const schema = await compose.discoverSchema({ refresh: true })
    expect(schema.factKeys.every((k) => k.label === k.key)).toBe(true)
  })

  it('falls back to the raw key when compose has no facts dependency at all', async () => {
    compose.init({ db: makeDb(), logger: null })   // facts omitted entirely
    const schema = await compose.discoverSchema({ refresh: true })
    expect(schema.factKeys.every((k) => k.label === k.key)).toBe(true)
  })
})
