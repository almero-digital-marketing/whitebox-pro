import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/composition/store.js', () => ({
  factBreakdown: vi.fn(async () => ({ series: [], total: 0 })),
  factValues: vi.fn(async () => []),
  eventCounts: vi.fn(async () => []),
  factPairs: vi.fn(async () => []),
  cohortRows: vi.fn(async () => []),
  namesByPassports: vi.fn(async () => ({})),
  getWidget: vi.fn(async () => null),
  getReport: vi.fn(async () => null),
}))

import { registerMcp } from '../src/composition/mcp.js'
import { runQuery } from '../src/composition/routes.js'

// An UNREADABLE query must not be answered.
//
// One surplus closing brace was accepted, the filter discarded, and the response was the
// whole base — 301,787 people — for a query whose real answer was 17. Twice, identically,
// so it read as a real number.
//
// The mechanism is the same in both places it happened: a JSON string that fails to parse
// was substituted with something harmless-looking. At the MCP boundary it was returned
// unchanged (then `q.selector` is undefined), and in runQuery it became `{}`. An undefined
// or empty filter is EVERYONE, so "cannot read this" degenerated into "no filter at all".
//
// Same family as the silent-empty group.by and the unknown breakdownFact key: an invalid
// request answered with a plausible number, which is worse than an error because nothing
// downstream can tell.
const MALFORMED = '{"selector":{"filter":{"all":[{"metric":{"count":{"gte":1},"session":' +
  '{"utm_source":"adwords"},"since":"2026-08-01","until":"2026-08-15"}}},{"metric":' +
  '{"count":{"gte":1},"attrs":{"event":"booking"},"since":"2026-08-01","until":"2026-08-15"}}]}}}'
const BALANCED = MALFORMED.replace('"until":"2026-08-15"}}},{"metric"', '"until":"2026-08-15"}},{"metric"')

function harness() {
  const tools = new Map()
  const resolve = vi.fn(async () => ({ count: 301787 }))
  registerMcp({ mcp: { tool: (d) => tools.set(d.name, d) } }, {
    selector: { resolve }, awareness: {}, passports: {}, logger: console,
  })
  return { tools, resolve }
}
const call = (tools, args) => tools.get('analytics_resolve').handler({ kind: 'stat', ...args })

describe('a query that cannot be parsed is refused, not answered', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses the reported string, and does not reach the engine at all', async () => {
    const { tools, resolve } = harness()
    await expect(call(tools, { query: MALFORMED })).rejects.toThrow(/not valid JSON/)
    // The important half: no answer was computed, so no number could be reported.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('gives it a 400 and says where the JSON broke', async () => {
    const { tools } = harness()
    const err = await call(tools, { query: MALFORMED }).catch(e => e)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/position \d+/)
    expect(err.message).toMatch(/<<HERE>>/)          // the offending point, in context
    expect(err.message).toMatch(/whole population/)  // why it refused rather than guessed
  })

  it('accepts the SAME query with balanced braces', async () => {
    const { tools, resolve } = harness()
    await expect(call(tools, { query: BALANCED })).resolves.toBeDefined()
    expect(resolve).toHaveBeenCalledTimes(1)
    // …and it carries the filter, which is what the malformed version lost.
    expect(resolve.mock.calls[0][0].filter.all).toHaveLength(2)
  })

  it('leaves a legitimately non-JSON string alone at the boundary', async () => {
    // `scope` may be a passport id. It is not JSON-shaped, so it must pass through
    // untouched rather than be refused by a check aimed at broken objects.
    const { tools, resolve } = harness()
    await call(tools, { query: { selector: { filter: {} } }, scope: 'a-passport-id' })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('refuses an unparseable STORED query too, rather than defaulting to {}', async () => {
    // The runQuery branch: a widget persisted with broken JSON showed a total instead of
    // an error, on every view.
    const deps = { selector: { resolve: vi.fn() }, awareness: {}, facts: {} }
    await expect(runQuery(deps, MALFORMED, 'stat')).rejects.toThrow(/not valid JSON/)
    await expect(runQuery(deps, MALFORMED, 'stat')).rejects.toMatchObject({ status: 400 })
    expect(deps.selector.resolve).not.toHaveBeenCalled()
  })

  it('refuses an empty or wrongly-typed query rather than treating it as everyone', async () => {
    const deps = { selector: { resolve: vi.fn() }, awareness: {}, facts: {} }
    await expect(runQuery(deps, '   ', 'stat')).rejects.toThrow(/query is empty/)
    await expect(runQuery(deps, '[1,2]', 'stat')).rejects.toThrow(/must be an object — got an array/)
    expect(deps.selector.resolve).not.toHaveBeenCalled()
  })

  it('an EXPLICITLY empty query is still everyone — that is a real request', async () => {
    // The distinction being drawn: `{}` written on purpose asks for the whole base and
    // gets it. Only an unreadable one is refused.
    const { tools, resolve } = harness()
    await call(tools, { query: {} })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
