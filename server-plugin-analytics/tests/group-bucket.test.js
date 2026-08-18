import { describe, it, expect, vi, beforeEach } from 'vitest'

// The fact path reads the store module directly, so the store is stubbed rather
// than injected — these tests are about WHICH path a bucket takes, not about SQL.
vi.mock('../src/composition/store.js', () => ({
  factBreakdown: vi.fn(async () => ({ series: [], total: 0 })),
  factValues: vi.fn(async () => []),
  eventCounts: vi.fn(async () => []),
  factPairs: vi.fn(async () => []),
  cohortRows: vi.fn(async () => []),
  namesByPassports: vi.fn(async () => ({})),
}))

import { runQuery } from '../src/composition/routes.js'
import * as store from '../src/composition/store.js'

// `group.by` is dispatched here before it reaches the engine, and an unrecognised
// token was read as a FACT KEY. So `by: 'content_url'` — a bucket the engine has
// supported all along — ran a breakdown of a fact nobody has ever recorded and
// returned `{ series: [], total: 0 }`: an empty chart, no error, nothing to
// distinguish "unsupported" from "no data".
describe('runQuery: which group buckets reach the engine', () => {
  const deps = ({ factKeys = ['first_booked_at', 'visits_total'], declared = [] } = {}) => {
    // Projection-aware: cohortScope() asks for `people` and reads `.passports`,
    // while the grouped call returns a series.
    const resolve = vi.fn(async (_sel, opts) => (opts?.projection === 'people'
      ? { passports: [{ id: 'a' }, { id: 'b' }] }
      : [{ bucket: 'x', value: 1 }]))
    return {
      deps: {
        selector: { resolve },
        awareness: {},
        facts: {
          usedKeys: vi.fn(async () => factKeys),
          declaredKeys: vi.fn(() => declared.map(key => ({ key }))),
        },
      },
      resolve,
    }
  }
  beforeEach(() => vi.clearAllMocks())
  const q = (by) => ({ selector: { filter: { metric: { count: {}, source: 'video' } } }, group: { by } })

  for (const by of ['content_url', 'content_hash', 'content', 'source', 'channel', 'direction', 'day', 'month']) {
    it(`sends "${by}" to the engine`, async () => {
      const { deps: d, resolve } = deps()
      const out = await runQuery(d, q(by), 'breakdown')
      expect(resolve).toHaveBeenCalled()
      expect(resolve.mock.calls[0][1].group).toEqual({ by })
      expect(out).toEqual([{ bucket: 'x', value: 1 }])
    })
  }

  for (const by of ['session:utm_campaign', 'attr:event']) {
    it(`sends "${by}" to the engine`, async () => {
      const { deps: d, resolve } = deps()
      await runQuery(d, q(by), 'breakdown')
      expect(resolve.mock.calls[0][1].group).toEqual({ by })
    })
  }

  it('names an unknown bucket instead of answering with an empty chart', async () => {
    const { deps: d } = deps()
    await expect(runQuery(d, q('content_ur1'), 'breakdown')).rejects.toThrow(/unknown group bucket "content_ur1"/)
    await expect(runQuery(d, q('content_ur1'), 'breakdown')).rejects.toThrow(/content_url/)   // lists what IS accepted
  })

  it('gives that error a 400, not a 500 — it is the caller’s typo', async () => {
    const { deps: d } = deps()
    await expect(runQuery(d, q('nope'), 'breakdown')).rejects.toMatchObject({ status: 400 })
  })


  // Explicit spellings were EXEMPT from the vocabulary check, on the reasoning that a
  // caller naming a fact meant it. Meaning it is not the same as being right: when the
  // six booking_* keys were deleted on 2026-08-18, every dashboard widget breaking down
  // by booking_location kept rendering {series:[],total:0} — a real answer, to a key
  // that no longer exists.
  it('names an unknown key given as breakdownFact, instead of an empty series', async () => {
    const { deps: d } = deps()
    const query = {
      selector: { filter: { metric: { count: {}, source: 'video' } } },
      breakdownFact: { key: 'booking_location' },
    }
    await expect(runQuery(d, query, 'breakdown')).rejects.toThrow(/unknown fact key "booking_location"/)
  })

  it('names an unknown key given as fact:<key> too', async () => {
    const { deps: d } = deps()
    await expect(runQuery(d, q('fact:booking_cost'), 'breakdown'))
      .rejects.toThrow(/unknown fact key "booking_cost"/)
    await expect(runQuery(d, q('fact:booking_cost'), 'breakdown'))
      .rejects.toMatchObject({ status: 400 })
  })

  it('lists the keys that DO exist, so the fix is in the message', async () => {
    const { deps: d } = deps({ factKeys: ['ltv_paid', 'visits_total'] })
    await expect(runQuery(d, q('fact:booking_cost'), 'breakdown'))
      .rejects.toThrow(/Known facts: ltv_paid, visits_total/)
  })

  it('still accepts an explicit key that EXISTS', async () => {
    const { deps: d } = deps()
    const query = {
      selector: { filter: { metric: { count: {}, source: 'video' } } },
      breakdownFact: { key: 'visits_total' },
    }
    await expect(runQuery(d, query, 'breakdown')).resolves.toBeDefined()
  })

  it('leaves an existing key with no matching rows as a legitimate empty series', async () => {
    // usedKeys() is the keys present in the LOG, so a real key that matches nobody in
    // this cohort is a true zero and must not become an error.
    const { deps: d } = deps()
    store.factBreakdown.mockResolvedValueOnce({ series: [], total: 0 })
    const query = {
      selector: { filter: { metric: { count: {}, source: 'video' } } },
      breakdownFact: { key: 'first_booked_at' },
    }
    await expect(runQuery(d, query, 'breakdown')).resolves.toBeDefined()
  })

  it('still treats a bare token that IS a fact key as a fact breakdown', async () => {
    // The fallback exists to rescue the compose model, which emits a fact key as
    // the bucket in several shapes. That has to keep working.
    const { deps: d } = deps()
    await runQuery(d, q('visits_total'), 'breakdown')
    expect(store.factBreakdown).toHaveBeenCalledWith('visits_total', expect.anything(), expect.anything())
  })

  it('lets a DECLARED key with no rows yet be a legitimate empty result', async () => {
    // This used to skip the vocabulary check for `fact:` entirely, reasoning that the
    // prefix is unambiguous so an unrecorded key must be a real zero. The reasoning
    // holds for a key the deployment has DECLARED and nobody has written yet — and it
    // also let through every typo and every key that had been deleted. Declarations
    // separate the two, so both cases can be right.
    const { deps: d } = deps({ factKeys: [], declared: ['brand_new_key'] })
    const out = await runQuery(d, q('fact:brand_new_key'), 'breakdown')
    expect(out).toEqual({ series: [], total: 0 })
  })

  it('errors on a fact: key that is neither written nor declared', async () => {
    const { deps: d } = deps({ factKeys: [] })
    await expect(runQuery(d, q('fact:brand_new_key'), 'breakdown'))
      .rejects.toThrow(/unknown fact key "brand_new_key"/)
  })

  it('does not fail the query when the fact vocabulary is unavailable', async () => {
    // No `facts` wired (older callers) must not turn every bare token into an error.
    const resolve = vi.fn(async (_sel, opts) => (opts?.projection === 'people'
      ? { passports: [{ id: 'a' }] }
      : [{ bucket: 'x', value: 1 }]))
    const d = { selector: { resolve }, awareness: {} }
    await expect(runQuery(d, q('something'), 'breakdown')).resolves.toBeDefined()
  })
})
