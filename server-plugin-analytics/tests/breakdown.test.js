// breakdownFact resolution. Two paths, deliberately different:
//
//   discovered buckets → ONE aggregation (store.factBreakdown)
//   explicit values    → one people-resolve per value
//
// The split matters. A GROUP BY cannot emit a row for a value absent from the
// data, so a caller naming values it expects to see — "how many on each plan
// tier", including the tier nobody is on — needs the zero, and only the
// per-value resolve produces it. A caller that named nothing wants the biggest
// buckets, which only the aggregation can rank.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/composition/store.js', async (importOriginal) => ({
  ...(await importOriginal()),
  factBreakdown: vi.fn(),
  factDistinctValues: vi.fn(),
}))

import * as store from '../src/composition/store.js'
import { runQuery } from '../src/composition/routes.js'

function makeSelector() {
  return { resolve: vi.fn(async () => ({ count: 7, passports: [] })) }
}

beforeEach(() => vi.clearAllMocks())

describe('breakdownFact — discovered buckets', () => {
  it('runs ONE aggregation instead of a resolve per value', async () => {
    store.factBreakdown.mockResolvedValue({
      series: [{ bucket: 'Мишници', value: 34229 }, { bucket: 'Пълен интим', value: 38706 }],
      total: 56,
    })
    const selector = makeSelector()

    const out = await runQuery({ selector }, { breakdownFact: { key: 'service' } })

    expect(store.factBreakdown).toHaveBeenCalledTimes(1)
    expect(store.factBreakdown).toHaveBeenCalledWith('service', undefined, { grain: undefined })
    // the loop this replaced called resolve once per bucket
    expect(selector.resolve).not.toHaveBeenCalled()
    expect(out.series).toHaveLength(2)
  })

  // grain/limit used to be dropped on the way in: `group: { by: "fact:k", grain:
  // "day", limit: 400 }` reached factBreakdown as (key, scope) and came back as
  // twelve raw-timestamp buckets ranked by value.
  it('forwards grain and limit from the group spelling', async () => {
    store.factBreakdown.mockResolvedValue({ series: [], total: 0 })

    await runQuery({ selector: makeSelector() }, { group: { by: 'fact:first_booked_at', grain: 'day', limit: 400 } })

    expect(store.factBreakdown).toHaveBeenCalledWith('first_booked_at', undefined, { grain: 'day', limit: 400 })
  })

  it('forwards grain and limit from the breakdownFact spelling', async () => {
    store.factBreakdown.mockResolvedValue({ series: [], total: 0 })

    await runQuery({ selector: makeSelector() }, { breakdownFact: { key: 'first_booked_at', grain: 'week', limit: 60 } })

    expect(store.factBreakdown).toHaveBeenCalledWith('first_booked_at', undefined, { grain: 'week', limit: 60 })
  })

  it('passes the store result through, including the declared aggregate', async () => {
    store.factBreakdown.mockResolvedValue({
      series: [{ bucket: '2026-08-13', value: 83 }], total: 1703, aggregate: 'distinct_passports', grain: 'day',
    })

    const out = await runQuery({ selector: makeSelector() }, { group: { by: 'fact:first_booked_at', grain: 'day' } })

    // `value` is PEOPLE, not events — the caller must be able to tell which.
    expect(out.aggregate).toBe('distinct_passports')
    expect(out.grain).toBe('day')
    expect(out.series[0]).toEqual({ bucket: '2026-08-13', value: 83 })
  })

  it('rejects group.key, pointing at the spelling that works', async () => {
    await expect(runQuery({ selector: makeSelector() }, { group: { by: 'day', key: 'first_booked_at' } }))
      .rejects.toThrow(/unknown key "key".*fact:<key>/s)
  })

  it('rejects an unknown top-level query key', async () => {
    await expect(runQuery({ selector: makeSelector() }, { selector: {}, since: '2026-08-07' }))
      .rejects.toThrow(/unknown key "since"/)
  })

  it('reports the true bucket count so a truncated chart can say so', async () => {
    store.factBreakdown.mockResolvedValue({
      series: [{ bucket: 'a', value: 1 }],
      total: 56,
    })

    const out = await runQuery({ selector: makeSelector() }, { breakdownFact: { key: 'service' } })

    // 56 services, 1 shown — without this a chart reads as "these are all of them",
    // which is how twelve of gpoint's services came to look like the whole list.
    expect(out.total).toBe(56)
    expect(out.series.length).toBeLessThan(out.total)
  })

  it('does not fall back to the unordered value discovery', async () => {
    store.factBreakdown.mockResolvedValue({ series: [], total: 0 })

    await runQuery({ selector: makeSelector() }, { breakdownFact: { key: 'service' } })

    // factDistinctValues has no ORDER BY — it returns an arbitrary 12
    expect(store.factDistinctValues).not.toHaveBeenCalled()
  })
})

describe('breakdownFact — explicit values', () => {
  it('resolves each named value so absent ones still report zero', async () => {
    const selector = makeSelector()
    selector.resolve
      .mockResolvedValueOnce({ count: 12 })
      .mockResolvedValueOnce({ count: 0 })

    const out = await runQuery(
      { selector },
      { breakdownFact: { key: 'plan_tier', values: ['pro', 'enterprise'] } },
    )

    expect(store.factBreakdown).not.toHaveBeenCalled()
    expect(selector.resolve).toHaveBeenCalledTimes(2)
    expect(out.series).toEqual([
      { bucket: 'pro', value: 12 },
      { bucket: 'enterprise', value: 0 },
    ])
  })

  it('asks for the count projection, not the passport ids', async () => {
    const selector = makeSelector()

    await runQuery({ selector }, { breakdownFact: { key: 'plan_tier', values: ['pro'] } })

    // a bucket needs one number; `people` would ship every passport id in it
    expect(selector.resolve).toHaveBeenCalledWith(
      { filter: { fact: { plan_tier: { eq: 'pro' } } } },
      expect.objectContaining({ projection: 'count' }),
    )
  })
})
