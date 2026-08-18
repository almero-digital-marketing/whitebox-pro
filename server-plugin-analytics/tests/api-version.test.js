import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/composition/store.js', () => ({
  factBreakdown: vi.fn(async () => ({ series: [], total: 0 })),
  factValues: vi.fn(async () => []), eventCounts: vi.fn(async () => []),
  factPairs: vi.fn(async () => []), cohortRows: vi.fn(async () => []),
  namesByPassports: vi.fn(async () => ({})),
  getWidget: vi.fn(async () => ({ id: 'w1', kind: 'stat', query: { selector: {} } })),
  getReport: vi.fn(async () => null),
}))

import { registerMcp } from '../src/composition/mcp.js'
import { CONTRACT, CONTRACTS, resolveContract } from 'whitebox-pro-server/selector-contract'

// A NUMBER A CALLER CAN PIN.
//
// Five breaking changes shipped in about a day, every one correct: the result moved into
// `data`, bookings moved from facts to event attrs, the window anchor default became `min`,
// JSON parsing became strict, operators were added. Nothing built on the API could pin
// behaviour across any of them, because there was no version in the request, the response
// or the grammar — so a client could not tell which engine state answered it.
//
// The package version is the wrong thing to pin: it moves for an unrelated bug fix. The
// CONTRACT moves only when a working query would answer differently or stop working.
function harness() {
  const tools = new Map()
  registerMcp({ mcp: { tool: (d) => tools.set(d.name, d) }, version: '9.9.9' }, {
    selector: { resolve: async () => ({ count: 42 }) },
    awareness: {}, passports: {}, logger: console,
  })
  return tools
}
const resolve = async (tools, args) => JSON.parse(
  (await tools.get('analytics_resolve').handler({ query: { selector: {} }, kind: 'stat', ...args })).content[0].text)

describe('api version', () => {
  beforeEach(() => vi.clearAllMocks())

  it('echoes which contract answered, unasked', async () => {
    const r = await resolve(harness(), {})
    expect(r.version).toMatchObject({ contract: CONTRACT, current: CONTRACT, server: '9.9.9' })
    expect(r.version.changelog).toMatch(/CHANGELOG/)
  })

  it('serves contract 1 with the result at the ROOT', async () => {
    // The one breaking change worth a compatibility window: it stops a client PARSING a
    // response, rather than merely changing a number.
    const r = await resolve(harness(), { version: 1 })
    expect(r).toEqual({ count: 42 })
    expect(r.data).toBeUndefined()
  })

  it('accepts the version as a string, since a client may send one', async () => {
    expect(await resolve(harness(), { version: '1' })).toEqual({ count: 42 })
    expect((await resolve(harness(), { version: '2' })).version.contract).toBe(2)
  })

  it('marks a pinned older contract as deprecated in the version block', () => {
    // Contract 1 returns no envelope, so this is asserted on the helper it comes from.
    const info = CONTRACTS[1]
    expect(info.status).toBe('supported')
    expect(info.until).toBeTruthy()
  })

  it('REFUSES an unknown version rather than rounding to the nearest', async () => {
    // A client pinning 3 was built against something this deployment does not have.
    // Answering with 2 answers a question it did not ask.
    for (const v of [3, 0, 'next', 2.5]) {
      await expect(resolve(harness(), { version: v })).rejects.toThrow(/unknown api version/)
    }
    await expect(resolve(harness(), { version: 3 })).rejects.toMatchObject({ status: 400 })
  })

  it('names what IS on offer when it refuses', async () => {
    const err = await resolve(harness(), { version: 7 }).catch(e => e)
    expect(err.message).toMatch(/serves 1 and 2/)
    expect(err.message).toMatch(/current: 2/)
    expect(err.message).toMatch(/analytics_grammar/)
  })

  it('pins a persisted widget the same way', async () => {
    const tools = harness()
    const bare = JSON.parse((await tools.get('analytics_widget_resolve').handler({ id: 'w1', version: 1 })).content[0].text)
    expect(bare).toEqual({ count: 42 })
    const wrapped = JSON.parse((await tools.get('analytics_widget_resolve').handler({ id: 'w1' })).content[0].text)
    expect(wrapped.version.contract).toBe(CONTRACT)
  })

  it('is in the grammar, so a cached grammar can be checked against the live one', async () => {
    const g = JSON.parse((await harness().get('analytics_grammar').handler({})).content[0].text)
    expect(g.version.contract).toBe(CONTRACT)
    expect(g.version.supported).toEqual([1, 2])
    // Every supported contract must say what a caller written against it gets.
    for (const n of g.version.supported) expect(g.version.contracts[n].response).toBeTruthy()
    // And contract 2 must list what changed, or the number is unusable for pinning.
    expect(g.version.contracts[2].changes.length).toBeGreaterThan(3)
  })

  it('resolveContract is the one place the rule lives', () => {
    expect(resolveContract(undefined)).toBe(CONTRACT)
    expect(resolveContract(1)).toBe(1)
    expect(() => resolveContract(99)).toThrow(/unknown api version/)
  })
})
