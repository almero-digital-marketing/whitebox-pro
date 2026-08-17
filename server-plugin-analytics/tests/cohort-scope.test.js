import { describe, it, expect, vi, beforeEach } from 'vitest'

// The scope a non-selector widget kind resolves against.
//
// breakdownFact / distribution / scatter / cohort take a scope ARRAY and used to
// build it from `q.scope` alone, so `selector.filter` was discarded in silence.
// On the GPoint board a studio breakdown filtered to `booking = noshow` returned
// the same numbers as `booking = attended` — 283,087 against a base of 284,176 —
// because neither filter was applied and both were the unfiltered base. The
// `selector` path never had the bug, so one query object honoured filters or
// ignored them depending only on which kind you asked for.
const factBreakdown = vi.fn(async () => ({ series: [], total: 0 }))
const factValues = vi.fn(async () => [1, 2, 3])
const factPairs = vi.fn(async () => [])
const cohortRows = vi.fn(async () => [])

vi.mock('../src/composition/store.js', () => ({
  init: () => {}, factBreakdown: (...a) => factBreakdown(...a), factValues: (...a) => factValues(...a),
  factPairs: (...a) => factPairs(...a), cohortRows: (...a) => cohortRows(...a),
  eventCounts: async () => [], factDistinctValues: async () => [], namesByPassports: async () => ({}),
  getWidget: async () => null, updateWidget: async () => ({}),
}))

const { runQuery } = await import('../src/composition/routes.js')

// resolve() answers `people` with whatever cohort the caller's filter names, so a
// test can assert the INTERSECTION rather than just that something was passed.
const cohorts = {
  noshow: ['p1', 'p2'],
  attended: ['p3', 'p4', 'p5'],
  scope: ['p2', 'p3', 'p4'],
}
// Anything unnamed resolves to nobody — which is the case the empty-cohort guard
// exists for, so it has to be reachable rather than throw.
const cohortFor = (sel) => {
  const f = sel?.filter?.fact || {}
  const name = f.booking?.eq ?? f.tag?.eq
  return cohorts[name] || []
}

const deps = { selector: { resolve: vi.fn(async (sel) => ({ passports: cohortFor(sel).map((id) => ({ id })) })) }, awareness: {} }
const SCOPE = { filter: { fact: { tag: { eq: 'scope' } } } }

beforeEach(() => { factBreakdown.mockClear(); factValues.mockClear(); factPairs.mockClear(); cohortRows.mockClear() })

describe('the effective cohort for a non-selector widget kind', () => {
  it('applies selector.filter to a breakdown', async () => {
    await runQuery(deps, { breakdownFact: { key: 'booking_location' }, selector: { filter: { fact: { booking: { eq: 'noshow' } } } } })
    expect(factBreakdown.mock.calls[0][1]).toEqual(['p1', 'p2'])
  })

  it('gives DIFFERENT scopes for different filters — the reported symptom', async () => {
    await runQuery(deps, { breakdownFact: { key: 'booking_location' }, selector: { filter: { fact: { booking: { eq: 'noshow' } } } } })
    const noshow = factBreakdown.mock.calls[0][1]
    factBreakdown.mockClear()
    await runQuery(deps, { breakdownFact: { key: 'booking_location' }, selector: { filter: { fact: { booking: { eq: 'attended' } } } } })
    expect(factBreakdown.mock.calls[0][1]).not.toEqual(noshow)
  })

  it('intersects scope AND selector.filter, rather than letting either win', async () => {
    await runQuery(deps, {
      breakdownFact: { key: 'booking_location' },
      scope: SCOPE,
      selector: { filter: { fact: { booking: { eq: 'attended' } } } },
    })
    // scope p2,p3,p4 ∩ attended p3,p4,p5 = p3,p4
    expect(factBreakdown.mock.calls[0][1]).toEqual(['p3', 'p4'])
  })

  it('stays undefined when neither is given — genuinely unscoped', async () => {
    await runQuery(deps, { breakdownFact: { key: 'booking_location' } })
    expect(factBreakdown.mock.calls[0][1]).toBeUndefined()
  })

  // An empty scope array reads as "unscoped" to every consumer (`if
  // (scope?.length)`), so returning one would widen a filter that matched NOBODY
  // back to the entire base — the worst possible answer, and the same trap that
  // bit the knowledge projection.
  it('a filter matching nobody returns nothing, not the whole base', async () => {
    const r = await runQuery(deps, { breakdownFact: { key: 'booking_location' }, selector: { filter: { fact: { booking: { eq: 'no-such' } } } } })
    expect(factBreakdown).not.toHaveBeenCalled()
    expect(r).toEqual({ series: [], total: 0 })
  })

  it('applies to distribution, scatter and cohort too — the bug was in all four', async () => {
    const f = { selector: { filter: { fact: { booking: { eq: 'noshow' } } } } }
    await runQuery(deps, { distribution: { key: 'ltv_paid' }, ...f })
    expect(factValues.mock.calls[0][1]).toEqual(['p1', 'p2'])

    await runQuery(deps, { scatter: { x: 'ltv_paid', y: 'visits_total' }, ...f })
    expect(factPairs.mock.calls[0][2].scope).toEqual(['p1', 'p2'])

    await runQuery(deps, { cohort: { event: 'booking' }, ...f })
    expect(cohortRows.mock.calls[0][2]).toEqual(['p1', 'p2'])
  })
})
