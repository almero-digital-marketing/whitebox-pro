import { describe, it, expect, vi } from 'vitest'
import * as compose from '../src/composition/compose.js'

// discoverSchema reads facts through ONE aggregate db.raw() (key + row count +
// distinct count + an 8-value sample + the complete value set for a categorical
// key); everything else still goes through the query builder. So the mock needs
// both: a raw() that answers by which table the SQL names, and a chainable
// knex-lookalike for the rest.
//
// geo_city is the categorical case (few distinct values → a complete `values`
// list); full_name is the high-cardinality case, where Postgres' CASE returns
// NULL so no value list ships at all.
// min_num/max_num are the numeric bounds (null unless the key holds JSON
// numbers); min_text/max_text always exist. node-pg hands ::numeric back as a
// string, which the mock reproduces — that coercion is part of what's tested.
const FACT_ROWS = [
  { key: 'geo_city', rows: 3, people: 3, distinct_values: 2, type: 'string',
    min_num: null, max_num: null, min_text: 'Plovdiv', max_text: 'Sofia',
    sample: ['Sofia', 'Plovdiv'], values: ['Sofia', 'Plovdiv'] },
  { key: 'client_status', rows: 5, people: 5, distinct_values: 0, type: 'string',
    min_num: null, max_num: null, min_text: null, max_text: null, sample: [], values: [] },
  { key: 'full_name', rows: 9, people: 9, distinct_values: 90, type: 'string',
    min_num: null, max_num: null, min_text: 'Ann', max_text: 'Zoe',
    sample: ['Ann', 'Bo'], values: null },
  { key: 'lifetime_value', rows: 28, people: 28, distinct_values: 28, type: 'number',
    min_num: '114', max_num: '2720', min_text: '1023', max_text: '955',
    sample: [114, 223], values: null },
]

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
  const db = vi.fn(() => chain(() => []))
  db.raw = vi.fn((sql) => ({ rows: sql.includes('whitebox_facts') ? FACT_ROWS : [] }))
  return db
}

describe('discoverSchema — fact labels', () => {
  it('attaches a plugin/config-registered label to each fact key', async () => {
    const facts = { label: vi.fn((key) => ({ geo_city: 'City', client_status: 'Status' }[key] || key)) }
    compose.init({ db: makeDb(), facts, logger: null })
    const schema = await compose.discoverSchema({ refresh: true })
    expect(schema.factKeys.map((k) => [k.key, k.label])).toEqual([
      ['geo_city', 'City'], ['client_status', 'Status'], ['full_name', 'full_name'],
      ['lifetime_value', 'lifetime_value'],
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

describe('discoverSchema — fact values', () => {
  // `sample` illustrates (for the AI prompt, truncation fine); `values` is the
  // COMPLETE choice list a picker binds to, and must be empty rather than
  // partial when the key is too high-cardinality to enumerate — a picker
  // showing a truncated list implies those are all the choices there are.
  it('ships the complete value set for a categorical key', async () => {
    compose.init({ db: makeDb(), logger: null })
    const { factKeys } = await compose.discoverSchema({ refresh: true })
    const geo = factKeys.find((k) => k.key === 'geo_city')
    expect(geo.values).toEqual(['Sofia', 'Plovdiv'])
    expect(geo.distinct).toBe(2)
  })

  it('ships no value set for a high-cardinality key, but still a sample', async () => {
    compose.init({ db: makeDb(), logger: null })
    const { factKeys } = await compose.discoverSchema({ refresh: true })
    const name = factKeys.find((k) => k.key === 'full_name')
    expect(name.values).toEqual([])          // null from SQL → [] here
    expect(name.sample).toEqual(['Ann', 'Bo'])
    expect(name.distinct).toBe(90)           // lets a caller say "free text" honestly
  })
})

describe('discoverSchema — fact bounds', () => {
  const bounds = async (key) => {
    compose.init({ db: makeDb(), logger: null })
    const { factKeys } = await compose.discoverSchema({ refresh: true })
    return factKeys.find((k) => k.key === key)
  }

  // The whole point of computing bounds twice: extracted as text a number
  // sorts wrong, so "1023 → 955" is what a text-only implementation reports
  // for this key. The numeric pair has to win, as real numbers.
  it('prefers the numeric bounds over the text ones for a numeric key', async () => {
    const k = await bounds('lifetime_value')
    expect(k).toMatchObject({ type: 'number', min: 114, max: 2720, people: 28 })
    expect(typeof k.min).toBe('number')   // node-pg hands ::numeric back as a string
  })

  it('falls back to the text bounds when the key holds no numbers', async () => {
    expect(await bounds('geo_city')).toMatchObject({ type: 'string', min: 'Plovdiv', max: 'Sofia' })
  })

  it('leaves bounds null when the key has no values at all', async () => {
    expect(await bounds('client_status')).toMatchObject({ min: null, max: null })
  })
})

// `domain` is the one domain-specific input this plugin cannot discover for
// itself. Fact keys, events and attributes all come from the data; what business
// this IS arrived as a string literal inside a prompt, which meant pointing the
// plugin at a different vertical produced valid JSON answering the wrong
// question — a failure no schema check catches.
describe('the domain reaches the model, and defaults to something neutral', () => {
  const capture = () => {
    const seen = []
    const ai = { prompt: async (sys) => { seen.push(sys); return '[]' } }
    return { ai, seen }
  }

  it('names the business when told', async () => {
    const { ai, seen } = capture()
    compose.init({ ai, domain: 'dental practice' })
    await compose.explainWidget({ title: 't', kind: 'stat', data: {} })
    expect(seen[0]).toContain('a dental practice customer database')
    expect(seen[0]).toContain('the dental practice owner')
    expect(seen[0]).not.toMatch(/beauty|clinic/i)
  })

  it('says nothing specific when not told', async () => {
    // Vague beats confidently foreign: a deployment that configures nothing gets
    // a model with no invented assumptions about its customers.
    const { ai, seen } = capture()
    compose.init({ ai })
    await compose.explainWidget({ title: 't', kind: 'stat', data: {} })
    expect(seen[0]).toContain('a customer database')
    expect(seen[0]).toContain('the owner')
    expect(seen[0]).not.toMatch(/beauty|clinic|dental/i)
  })

  it('reaches the person-profile prompt too', async () => {
    const { ai, seen } = capture()
    compose.init({ ai, domain: 'gym' })
    await compose.explainPerson({ who: 'x' })
    expect(seen[0]).toContain('a gym customer database')
  })

  it('blank or whitespace falls back rather than emitting a hole', async () => {
    for (const d of ['', '   ', null]) {
      const { ai, seen } = capture()
      compose.init({ ai, domain: d })
      await compose.explainWidget({ title: 't', kind: 'stat', data: {} })
      expect(seen[0], JSON.stringify(d)).toContain('a customer database')
      expect(seen[0], JSON.stringify(d)).not.toMatch(/a\s{2,}customer|for a  /)
    }
  })
})
