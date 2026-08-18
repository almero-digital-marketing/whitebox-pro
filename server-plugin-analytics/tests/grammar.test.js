import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/composition/store.js', () => ({
  factBreakdown: vi.fn(async () => ({ series: [], total: 0 })),
  factValues: vi.fn(async () => []), eventCounts: vi.fn(async () => []),
  factPairs: vi.fn(async () => []), cohortRows: vi.fn(async () => []),
  namesByPassports: vi.fn(async () => ({})), getWidget: vi.fn(async () => null),
  getReport: vi.fn(async () => null),
}))

import { registerMcp } from '../src/composition/mcp.js'
import { grammar } from 'whitebox-pro-server/selector-dsl'
// Reached by relative path on purpose: the package `exports` map does not publish
// ./src/*, and this suite already requires the sibling server checkout (its test harness
// lives there). Importing the ENGINE's own lists is the whole point — comparing the
// document against a copy of the lists would test nothing.
import { ATTR_OPS, WINDOW_KEYS, MISSING, MAX_SERIES } from '../../server/src/selector/metric.js'

// The GRAMMAR, as a tool.
//
// analytics_schema returns the VOCABULARY — which fact keys exist, which event actions,
// which channels. Nothing returned the SYNTAX, and describeQuery runs query → prose, so
// the only way to learn what could be written was to write something wrong and read the
// error. Every improvement to those errors made the guessing cheaper without removing it.
//
// Generated from the engine's constants, never restated: a hand-kept copy would be a
// fourth place the grammar lives, after the engine, the validator and the compose prompt —
// and those three have drifted from each other four times this month.
function tools() {
  const map = new Map()
  registerMcp({ mcp: { tool: (d) => map.set(d.name, d) } }, {
    selector: { resolve: async () => ({}) }, awareness: {}, passports: {}, logger: console,
  })
  return map
}
const read = async () => JSON.parse((await tools().get('analytics_grammar').handler({})).content[0].text)

describe('analytics_grammar', () => {
  it('is generated from the engine constants, not a copy of them', async () => {
    // The assertion that matters: if someone adds an operator to the engine and not to a
    // list here, this test fails rather than the document quietly going stale.
    const g = await read()
    expect(g.metric.attrs.operators).toEqual(ATTR_OPS)
    expect(g.metric.window.keys).toEqual(WINDOW_KEYS)
    expect(g.metric.window.missingAnchor).toEqual(MISSING)
    expect(g.group.crossTab.limits.seriesLimit).toContain(String(MAX_SERIES))
  })

  it('covers every part of a query someone has to write', async () => {
    const g = await read()
    expect(Object.keys(g)).toEqual(expect.arrayContaining([
      'filter', 'fact', 'metric', 'group', 'projections', 'composition',
    ]))
    expect(g.fact.operators.temporal).toContain('transition')
    expect(g.fact.operators.text).toContain('contains')
    expect(g.metric.aggregates.gate).toContain('recency_days')
    expect(g.metric.aggregates.grouped).toContain('distinct_passports')
    expect(g.group.buckets.time).toEqual(['hour', 'day', 'week', 'month'])
  })

  it('spells out the words that mean several things', async () => {
    // `last` cost real time to work out from errors, and cannot be renamed without
    // breaking stored widgets — so the overload has to be legible instead.
    const g = await read()
    const wheres = g.sameWordThreeMeanings.last.map(m => m.where)
    expect(wheres).toContain('metric.last')
    expect(wheres).toContain('fact.<key>.last')
    expect(wheres).toContain('use: "last"')
    expect(g.sameWordThreeMeanings.limitVsSeriesLimit).toHaveLength(2)
  })

  it('pairs the common mistakes with what to write instead', async () => {
    const g = await read()
    const wrote = g.mistakes.map(m => m.wrote).join(' | ')
    expect(wrote).toMatch(/window: \{ last/)      // the one that looked like a blocker
    expect(wrote).toMatch(/pick: "min"/)          // the feature that exists under another name
    for (const m of g.mistakes) expect(m.want).toBeTruthy()
  })

  it('states the response shape, which is not guessable from a request', async () => {
    const g = await read()
    expect(g.composition.response.always).toBe(true)
    expect(g.composition.response.shape).toBe('{ data, applied, warnings }')
  })

  it('distinguishes splitBy from a two-dimension group.by', async () => {
    // The reported confusion, in the document rather than only in the error.
    const g = await read()
    expect(g.composition.shapes.splitBy).toMatch(/NOT a second dimension/)
    expect(g.group.crossTab.shape).toContain('by:')
  })

  it('needs no arguments — it is a reference, not a query', async () => {
    expect(Object.keys(tools().get('analytics_grammar').inputSchema)).toEqual([])
  })

  it('is exported from the server so other surfaces can serve it too', () => {
    expect(typeof grammar).toBe('function')
    expect(grammar().fact.use.precedence).toMatch(/query use > deployment declaration > last/)
  })
})
