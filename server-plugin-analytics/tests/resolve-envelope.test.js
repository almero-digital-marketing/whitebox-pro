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
import { CONTRACT } from 'whitebox-pro-server/selector-contract'

// The resolve tools ALWAYS return { data, applied, warnings }.
//
// They used to wrap only when a warning existed, which read as the conservative choice
// and was the wrong one: whether a query warns depends on the DATA, not the request, so a
// client could not tell from its own query which shape it would get. Roughly half of
// queries came back each way, and code reading `data.count` broke on the other half.
// One shape always is worth the one-time break.
function harness({ warnings = [], applied = {}, factNotes } = {}) {
  const tools = new Map()
  const mcp = { tool: (def) => tools.set(def.name, def) }
  const notes = factNotes ?? vi.fn(async () => ({ applied, warnings }))
  registerMcp({ mcp }, {
    selector: { resolve: vi.fn(async (_s, opts) => (opts?.projection === 'people'
      ? { passports: [{ id: 'a' }] }
      : { count: 87845 })) },
    awareness: {},
    passports: {},
    facts: { factNotes: notes, usedKeys: async () => ['ltv_paid'], declaredKeys: () => [] },
    logger: console,
  })
  return { tools, notes }
}
// The MCP `read` helper serialises the handler's return into a text content block, so
// the envelope has to be read back out of it — same as the rest of this suite does.
const run = async (tools, query, kind = 'stat') => {
  const res = await tools.get('analytics_resolve').handler({ query, kind })
  return JSON.parse(res.content[0].text)
}

const NO_FACTS = { selector: { filter: { metric: { count: {}, source: 'video' } } } }
const WITH_FACT = { selector: { filter: { fact: { ltv_paid: { gte: 1 } } } } }

describe('analytics_resolve: one response shape, always', () => {
  beforeEach(() => vi.clearAllMocks())

  it('wraps a query that rests on NO facts', async () => {
    const { tools } = harness()
    const r = await run(tools, NO_FACTS)
    expect(r).toMatchObject({ data: { count: 87845 }, applied: {}, warnings: [] })
    expect(r.version.contract).toBe(CONTRACT)
  })

  it('wraps a query with facts and nothing to report', async () => {
    const { tools } = harness({ applied: { ltv_paid: 'last' } })
    const r = await run(tools, WITH_FACT)
    expect(r.data).toEqual({ count: 87845 })
    expect(r.applied).toEqual({ ltv_paid: 'last' })
    expect(r.warnings).toEqual([])
  })

  it('wraps a query WITH a warning the same way', async () => {
    const w = { code: 'ambiguous_anchor_fact', fact: 'ltv_paid', used: 'last' }
    const { tools } = harness({ applied: { ltv_paid: 'last' }, warnings: [w] })
    const r = await run(tools, WITH_FACT)
    expect(r.data).toEqual({ count: 87845 })
    expect(r.warnings).toEqual([w])
  })

  it('wraps when the facts module is not wired at all', async () => {
    const tools = new Map()
    registerMcp({ mcp: { tool: (d) => tools.set(d.name, d) } }, {
      selector: { resolve: async () => ({ count: 1 }) },
      awareness: {}, passports: {}, logger: console,      // no `facts`
    })
    expect(await run(tools, WITH_FACT)).toMatchObject({ data: { count: 1 }, applied: {}, warnings: [] })
  })

  it('still answers when the notes themselves fail', async () => {
    // The notes are commentary on a result that is already correct; a failure computing
    // them must not take the answer down.
    const { tools } = harness({ factNotes: vi.fn(async () => { throw new Error('db gone') }) })
    const r = await run(tools, WITH_FACT)
    expect(r).toMatchObject({ data: { count: 87845 }, applied: {}, warnings: [] })
    expect(r.version.contract).toBe(CONTRACT)
  })

  it('never leaves the result at the root', async () => {
    // The specific breakage: code reading `count` (or `series`, or index 0) off the root.
    const { tools } = harness()
    const r = await run(tools, NO_FACTS)
    expect(r.count).toBeUndefined()
    expect(r.series).toBeUndefined()
    expect(Array.isArray(r)).toBe(false)
    // `version` joined them: five breaking changes shipped in a day with nothing in the
    // response saying which state answered.
    expect(Object.keys(r).sort()).toEqual(['applied', 'data', 'version', 'warnings'])
  })

  it('describes the shape and the cross-tab knobs in the tool description', async () => {
    // Discoverability is the actual fix for both reports: seriesLimit existed and was
    // found by nobody, and the envelope was learned by probing.
    const { tools } = harness()
    const desc = tools.get('analytics_resolve').description
    expect(desc).toMatch(/ALWAYS returns \{ data, applied, warnings \}/)
    expect(desc).toMatch(/seriesLimit/)
    expect(desc).toMatch(/default 6, max 200/)
  })
})
