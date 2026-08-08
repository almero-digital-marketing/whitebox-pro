import { describe, it, expect, vi } from 'vitest'
import { runQuery } from '../src/composition/routes.js'

// A `stat` asks "how many?" and used to be answered with the whole cohort —
// 153,245 passport ids, 9.4 MB, for a number already in the first field. Enough
// to exceed an MCP client's budget outright.
describe('runQuery: projection defaults by widget kind', () => {
  const deps = () => {
    const resolve = vi.fn(async (_sel, opts) => ({ count: 3, passports: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], _opts: opts }))
    return { deps: { selector: { resolve }, awareness: {} }, resolve }
  }

  it('asks for count on a stat', async () => {
    const { deps: d, resolve } = deps()
    await runQuery(d, { selector: { filter: { fact: { visits_total: { gte: 1 } } } } }, 'stat')
    expect(resolve.mock.calls[0][1].projection).toBe('count')
  })

  it('asks for people on a table — the rows are the point', async () => {
    const { deps: d, resolve } = deps()
    await runQuery(d, { selector: {} }, 'table')
    expect(resolve.mock.calls[0][1].projection).toBe('people')
  })

  it('lets an explicit projection win', async () => {
    const { deps: d, resolve } = deps()
    await runQuery(d, { selector: {}, projection: 'people' }, 'stat')
    expect(resolve.mock.calls[0][1].projection).toBe('people')
  })

  it('leaves the projection unset for a kind that has no default', async () => {
    const { deps: d, resolve } = deps()
    await runQuery(d, { selector: {} }, 'timeseries')
    expect(resolve.mock.calls[0][1].projection).toBeUndefined()
  })
})
