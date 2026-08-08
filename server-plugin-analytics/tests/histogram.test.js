import { describe, it, expect } from 'vitest'
import { buildHistogram } from '../src/composition/histogram.js'

const bucketsOf = (r) => Object.fromEntries(r.series.map(b => [b.bucket, b.value]))

describe('histogram: skewed data', () => {
  // The case that prompted this: avg_days_between_visits ran 1 → 1338 because
  // four customers out of 9,626 had year-long gaps. Linear bins over the full
  // range put 96.6% of everyone in the first bucket — accurate, and useless.
  const skewed = [...Array(9000)].map((_, i) => 1 + (i % 90)).concat([250, 420, 905, 1338])

  it('clamps the axis to p99 instead of letting a long tail crush it', () => {
    const { series } = buildHistogram(skewed, { maxBins: 10 })
    const main = series.filter(b => b.hi !== null)
    // no single bucket holds nearly everything any more
    const biggest = Math.max(...main.map(b => b.value))
    expect(biggest / skewed.length).toBeLessThan(0.3)
    expect(main.length).toBeGreaterThan(5)
  })

  it('puts the tail in a labelled open bucket rather than dropping it', () => {
    const { series } = buildHistogram(skewed, { maxBins: 10 })
    const overflow = series.at(-1)
    expect(overflow.bucket).toMatch(/\+$/)
    expect(overflow.hi).toBeNull()          // open-ended: a selection becomes { gte: lo }
    // every value is still counted somewhere
    expect(series.reduce((n, b) => n + b.value, 0)).toBe(skewed.length)
  })

  // Self-limiting: on data that really is spread out, p99 ≈ max and nothing
  // should be clamped or overflowed.
  it('leaves evenly-spread data alone', () => {
    const even = [...Array(1000)].map((_, i) => i)
    const { series } = buildHistogram(even, { maxBins: 10 })
    expect(series.every(b => b.hi !== null)).toBe(true)   // no overflow bucket
    expect(series.reduce((n, b) => n + b.value, 0)).toBe(even.length)
  })
})

describe('histogram: explicit bins', () => {
  // Explicit bins used to DROP anything past the last edge. A cadence chart
  // binned to 365 days silently discarded the customers with longer gaps, and
  // nothing on the chart said a number was missing.
  it('overflows past the last explicit edge instead of discarding', () => {
    const { series } = buildHistogram([1, 5, 100, 400, 900], { bins: [0, 10, 50, 365] })
    expect(bucketsOf({ series })['365+']).toBe(2)
    expect(series.reduce((n, b) => n + b.value, 0)).toBe(5)
  })

  it('underflows below the first explicit edge', () => {
    const { series } = buildHistogram([-5, 1, 5], { bins: [0, 10] })
    expect(series[0].bucket).toBe('<0')
    expect(series[0].lo).toBeNull()
    expect(series.reduce((n, b) => n + b.value, 0)).toBe(3)
  })

  it('adds no open bucket when everything is inside the edges', () => {
    const { series } = buildHistogram([1, 5, 9], { bins: [0, 10] })
    expect(series).toHaveLength(1)
    expect(series[0].value).toBe(3)
  })
})
