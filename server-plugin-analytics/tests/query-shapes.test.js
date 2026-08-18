import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/composition/store.js', () => ({
  factBreakdown: vi.fn(async () => ({ series: [], total: 0 })),
  factValues: vi.fn(async () => []),
  eventCounts: vi.fn(async () => []),
  factPairs: vi.fn(async () => []),
  cohortRows: vi.fn(async () => []),
  namesByPassports: vi.fn(async () => ({})),
}))

import { runQuery, factKeysOf, anchorKeysOf, factUsesOf } from '../src/composition/routes.js'

// A key being in the allowlist is not the same as it being usable. Unknown keys were
// rejected from the start; a KNOWN key carrying the wrong shape was not, and the
// resolver skips it over a `?.` guard and answers as though it had never been written.
//
//   {"selector":…,"group":{"by":"month"},"splitBy":"attr:location"}
//     → the month series, splitBy silently ignored, no error
//
// Same silent-ignore class as breakdownFact on a deleted key and group.by:"content_url".
const deps = () => ({
  selector: {
    resolve: vi.fn(async (_sel, opts) => (opts?.projection === 'people'
      ? { passports: [{ id: 'a' }] }
      : [{ bucket: 'x', value: 1 }])),
  },
  awareness: {},
  facts: { usedKeys: vi.fn(async () => ['tier', 'ltv']), declaredKeys: vi.fn(() => []) },
})
const base = { selector: { filter: { metric: { count: {}, source: 'video' } } }, group: { by: 'month' } }

describe('runQuery: a known key with the wrong shape', () => {
  it('rejects splitBy as a string, and says where a second dimension belongs', async () => {
    const p = runQuery(deps(), { ...base, splitBy: 'attr:location' }, 'breakdown')
    await expect(p).rejects.toThrow(/splitBy must be an object \{ key: "<factKey>", values: \[\.\.\.\] \}/)
    await expect(runQuery(deps(), { ...base, splitBy: 'attr:location' }, 'breakdown'))
      .rejects.toThrow(/use `group\.by`/)
    await expect(runQuery(deps(), { ...base, splitBy: 'attr:location' }, 'breakdown'))
      .rejects.toMatchObject({ status: 400 })
  })

  it('names the FACT/dimension confusion specifically', async () => {
    // `attr:` in a well-formed splitBy is still wrong: splitBy compares values of one
    // fact, it does not take an event dimension.
    await expect(runQuery(deps(), { ...base, splitBy: { key: 'attr:location', values: ['a'] } }, 'breakdown'))
      .rejects.toThrow(/splits by a FACT's values, and "attr:location" is an event dimension/)
  })

  it('rejects splitBy with no values, which resolves to nothing', async () => {
    await expect(runQuery(deps(), { ...base, splitBy: { key: 'tier' } }, 'breakdown'))
      .rejects.toThrow(/needs a non-empty `values` array/)
    await expect(runQuery(deps(), { ...base, splitBy: { key: 'tier', values: [] } }, 'breakdown'))
      .rejects.toThrow(/needs a non-empty `values` array/)
  })

  it('accepts a well-formed splitBy', async () => {
    const d = deps()
    await expect(runQuery(d, { ...base, splitBy: { key: 'tier', values: ['gold', 'silver'] } }, 'breakdown'))
      .resolves.toBeDefined()
  })

  it('checks the other shapes that hide behind a `?.` guard', async () => {
    await expect(runQuery(deps(), { ...base, series: [] }, 'breakdown'))
      .rejects.toThrow(/series must be a non-empty array/)
    await expect(runQuery(deps(), { ...base, series: ['nope'] }, 'breakdown'))
      .rejects.toThrow(/series\[0\] must be \{ name, query \}/)
    await expect(runQuery(deps(), { ...base, series: [{ name: 'a' }] }, 'breakdown'))
      .rejects.toThrow(/series\[0\] needs a `query`/)
    await expect(runQuery(deps(), { ...base, breakdownFact: 'tier' }, 'breakdown'))
      .rejects.toThrow(/breakdownFact must be \{ key/)
    await expect(runQuery(deps(), { ...base, distribution: 'ltv' }, 'breakdown'))
      .rejects.toThrow(/distribution must be \{ source, key \}/)
  })
})

// A warning about "the fact this answer depends on" has to know which facts those are,
// and they hide in eight places. Missing one means a silent-default goes unwarned.
describe('factKeysOf', () => {
  const keys = (q) => [...factKeysOf(q)].sort()

  it('finds them in a filter tree, through all/any/not', () => {
    expect(keys({ selector: { filter: { all: [
      { fact: { tier: { eq: 'gold' } } },
      { any: [{ fact: { city: { eq: 'Sofia' } } }, { not: { fact: { churned: { present: true } } } }] },
    ] } } })).toEqual(['churned', 'city', 'tier'])
  })

  it('finds a window ANCHOR — the shape most likely to rest on an ambiguous key', () => {
    expect(keys({ selector: { filter: { metric: {
      count: {}, window: { after: { fact: 'first_booked_at' } } } } } })).toEqual(['first_booked_at'])
    expect(keys({ selector: { filter: { metric: {
      count: {}, window: { between: [{ fact: 'a' }, { fact: 'b' }] } } } } })).toEqual(['a', 'b'])
  })

  it('finds an aggregate reading a fact, and a fact bucket', () => {
    expect(keys({ selector: { filter: { metric: { avg: { fact: 'ltv_paid' } } } } })).toEqual(['ltv_paid'])
    expect(keys({ group: { by: 'fact:tier' } })).toEqual(['tier'])
    expect(keys({ group: { by: ['month', 'fact:tier'] } })).toEqual(['tier'])
  })

  it('finds the composition-layer shapes', () => {
    expect(keys({ breakdownFact: { key: 'tier' } })).toEqual(['tier'])
    expect(keys({ distribution: { source: 'fact', key: 'ltv' } })).toEqual(['ltv'])
    expect(keys({ distribution: { source: 'event', key: 'booking' } })).toEqual([])   // not a fact
    expect(keys({ scatter: { x: 'ltv', y: 'visits', colorBy: 'tier' } })).toEqual(['ltv', 'tier', 'visits'])
    expect(keys({ splitBy: { key: 'tier', values: ['a'] } })).toEqual(['tier'])
  })

  it('recurses into series, and reads `scope` as well as `selector`', () => {
    expect(keys({
      scope: { filter: { fact: { churned: { present: false } } } },
      series: [{ name: 'A', query: { selector: { filter: { fact: { tier: { eq: 'gold' } } } } } }],
    })).toEqual(['churned', 'tier'])
  })

  it('finds nothing in a query that rests on no facts', () => {
    expect(keys({ selector: { filter: { metric: { count: {}, source: 'video' } } }, group: { by: 'month' } })).toEqual([])
    expect(keys({})).toEqual([])
    expect(keys(undefined)).toEqual([])
  })
})

// Anchors are extracted separately from every other fact a query touches, because they
// are warned about even when declared — a declaration says which value a key means, not
// where each person's window boundary lands.
describe('anchorKeysOf', () => {
  // A Map now, key → the anchor's own `use` (null when it named none): the rule has to
  // travel with the key, or `applied`/`used` report the declaration for a query that
  // overrode it — which is what they did.
  const keys = (q) => [...anchorKeysOf(q).keys()].sort()
  const uses = (q) => Object.fromEntries(anchorKeysOf(q))

  it('finds only the window anchors, not other fact references', () => {
    expect(keys({ selector: { filter: { all: [
      { fact: { tier: { eq: 'gold' } } },
      { metric: { count: {}, window: { after: { fact: 'first_booked_at' } } } },
    ] } } })).toEqual(['first_booked_at'])
  })

  it('finds both sides of a between', () => {
    expect(keys({ selector: { filter: { metric: {
      count: {}, window: { between: [{ fact: 'signed_up_at' }, { fact: 'first_booked_at' }] } } } } }))
      .toEqual(['first_booked_at', 'signed_up_at'])
  })

  it('reaches through combinators, scope and series', () => {
    expect(keys({
      scope: { filter: { metric: { count: {}, window: { before: { fact: 'churned_at' } } } } },
      series: [{ name: 'A', query: { selector: { filter: { not: {
        metric: { count: {}, window: { after: { fact: 'first_visit_at' } } } } } } } }],
    })).toEqual(['churned_at', 'first_visit_at'])
  })


  it('carries the anchor\'s own `use` alongside the key', () => {
    expect(uses({ selector: { filter: { metric: {
      count: {}, window: { before: { fact: 'first_booked_at', use: 'max' } } } } } }))
      .toEqual({ first_booked_at: 'max' })
    // No `use` written → null, meaning "the declaration decides", not "last".
    expect(uses({ selector: { filter: { metric: {
      count: {}, window: { before: { fact: 'first_booked_at' } } } } } }))
      .toEqual({ first_booked_at: null })
  })

  it('prefers the occurrence that NAMED a rule when a key is anchored twice', () => {
    // One query, two anchors on the same key, only one of them explicit. Reporting the
    // silent one would lose the override.
    expect(uses({ selector: { filter: { any: [
      { metric: { count: {}, window: { before: { fact: 'k' } } } },
      { metric: { count: {}, window: { after: { fact: 'k', use: 'first' } } } },
    ] } } })).toEqual({ k: 'first' })
  })

  it('finds nothing when the query anchors on nothing', () => {
    expect(keys({ selector: { filter: { fact: { tier: { eq: 'gold' } } } }, group: { by: 'fact:tier' } })).toEqual([])
    expect(keys({})).toEqual([])
  })
})

// Every place a query can override which value a fact key means. The engine's precedence
// is query `use` > declaration > `last`, and `applied`/`used` have to follow it — they
// read the declaration instead, so a call asking for `max` was told `min` on the
// response's own authority.
describe('factUsesOf', () => {
  const uses = (q) => Object.fromEntries(factUsesOf(q))

  it('reads a fact predicate', () => {
    expect(uses({ selector: { filter: { fact: { first_booked_at: { gte: 'x', use: 'min' } } } } }))
      .toEqual({ first_booked_at: 'min' })
  })

  it('reads an aggregate over a fact', () => {
    expect(uses({ selector: { filter: { metric: { avg: { fact: 'ltv_paid', use: 'max' } } } } }))
      .toEqual({ ltv_paid: 'max' })
  })

  it('reads a window anchor', () => {
    expect(uses({ selector: { filter: { metric: {
      count: {}, window: { between: [{ fact: 'a', use: 'first' }, { fact: 'b' }] } } } } }))
      .toEqual({ a: 'first' })     // b named none, so nothing to report for it
  })

  it('reads group.use, but only for the fact: dimensions', () => {
    expect(uses({ group: { by: ['month', 'fact:tier'], use: 'max' } })).toEqual({ tier: 'max' })
    expect(uses({ group: { by: 'attr:location', use: 'max' } })).toEqual({})
  })

  it('recurses through combinators, scope and series', () => {
    expect(uses({
      scope: { filter: { not: { fact: { churned: { present: true, use: 'last' } } } } },
      series: [{ name: 'A', query: { selector: { filter: { fact: { tier: { eq: 'g', use: 'first' } } } } } }],
    })).toEqual({ churned: 'last', tier: 'first' })
  })

  it('reports nothing when the query overrides nothing', () => {
    expect(uses({ selector: { filter: { fact: { tier: { eq: 'gold' } } } } })).toEqual({})
    expect(uses({})).toEqual({})
  })
})
