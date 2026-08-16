import { describe, it, expect } from 'vitest'
import { compactForExplain } from '../src/composition/routes.js'

// What the explain prompt is HANDED, which is the only thing it may state. The
// prompt asks for "the step with the biggest leak and how many people fell out
// there", so that figure has to be in here — a language model asked to subtract
// six-digit numbers will eventually get one wrong, and it did: 115,491 visited
// and 6,318 booked came back as "108,173 visitors did not book", 1,000 short of
// 109,173, in confident prose beside the chart that disproved it.
describe('compactForExplain', () => {
  const funnel = { report: [{ name: 'visited', count: 115491 }, { name: 'booked', count: 6318 }] }

  it('gives a funnel its drop computed, not left to the model', () => {
    const out = compactForExplain('funnel', funnel)
    expect(out.drops).toEqual([{ from: 'visited', to: 'booked', lost: 109173, pct: 95 }])
  })

  it('keeps the funnel steps too — it is drawn as the surviving cohorts', () => {
    const out = compactForExplain('funnel', funnel)
    expect(out.steps).toEqual([['visited', 115491], ['booked', 6318]])
  })

  it('a dropoff stays loss-only — it is ABOUT the loss', () => {
    const out = compactForExplain('dropoff', funnel)
    expect(out.drops).toEqual([{ from: 'visited', to: 'booked', lost: 109173, pct: 95 }])
    expect(out.steps).toBeUndefined()
  })

  it('computes each drop across a multi-step funnel', () => {
    const out = compactForExplain('funnel', {
      report: [{ name: 'a', count: 1000 }, { name: 'b', count: 400 }, { name: 'c', count: 300 }],
    })
    expect(out.drops).toEqual([
      { from: 'a', to: 'b', lost: 600, pct: 60 },
      { from: 'b', to: 'c', lost: 100, pct: 25 },
    ])
  })

  it('never reports a negative loss, and never divides by zero', () => {
    // A step that GROWS (or an empty entry) is not a leak. Both shapes reach here
    // from real data — an un-windowed step can re-admit, and a funnel over an
    // empty cohort starts at 0.
    expect(compactForExplain('funnel', { report: [{ name: 'a', count: 10 }, { name: 'b', count: 25 }] }).drops)
      .toEqual([{ from: 'a', to: 'b', lost: 0, pct: 0 }])
    expect(compactForExplain('funnel', { report: [{ name: 'a', count: 0 }, { name: 'b', count: 0 }] }).drops)
      .toEqual([{ from: 'a', to: 'b', lost: 0, pct: 0 }])
  })
})
