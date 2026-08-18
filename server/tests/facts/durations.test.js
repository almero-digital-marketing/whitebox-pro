import { describe, it, expect } from 'vitest'
import { shift, matchValue, matchTemporal } from '../../src/facts/operators.js'

// Durations, and the two things about them that were wrong.
//
// 1. The grammar was milliseconds-only (h/d/w), so `6M` was rejected everywhere. That
//    made "revenue per studio for the last 6 months" look inexpressible — the money is
//    an event attr, so it has to be summed over events, and the only key that bounds
//    events in time refused the only unit anybody writes a half-year in.
// 2. A temporal operator's window was read as `spec.last` at the CALL SITE, so writing
//    the operator without one reported `bad window "undefined"` — the format of a value
//    for a key it never named. It took eight attempts to guess `{ last: '7d' }`.
const at = (s) => new Date(s)

describe('facts: duration grammar', () => {
  it('treats h/d/w as fixed spans', () => {
    const now = at('2026-08-18T12:00:00Z')
    expect(shift(now, '24h').toISOString()).toBe('2026-08-17T12:00:00.000Z')
    expect(shift(now, '7d').toISOString()).toBe('2026-08-11T12:00:00.000Z')
    expect(shift(now, '2w').toISOString()).toBe('2026-08-04T12:00:00.000Z')
  })

  it('treats M/y as CALENDAR spans, not 30-day approximations', () => {
    // 182.6 days would land on 18 February. "Six months ago" is 18 February only by
    // coincidence here; the point is that the month arithmetic is calendar-based, so
    // a report labelled "6 months" covers what every other tool calls six months.
    const now = at('2026-08-18T12:00:00Z')
    expect(shift(now, '6M').toISOString().slice(0, 10)).toBe('2026-02-18')
    expect(shift(now, '1y').toISOString().slice(0, 10)).toBe('2025-08-18')
    expect(shift(now, '18M').toISOString().slice(0, 10)).toBe('2025-02-18')
  })

  it('CLAMPS a short month instead of overflowing into the next one', () => {
    // JS setMonth turns 31 Feb into 3 March, which would silently widen the window by
    // three days. Postgres interval arithmetic clamps, and these two have to agree.
    expect(shift(at('2026-08-31T12:00:00Z'), '6M').toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(shift(at('2026-03-31T12:00:00Z'), '1M').toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(shift(at('2025-02-28T12:00:00Z'), '1y').toISOString().slice(0, 10)).toBe('2024-02-28')
  })

  it('goes forward when asked — `next` is the same grammar', () => {
    const now = at('2026-08-18T12:00:00Z')
    expect(shift(now, '3M', +1).toISOString().slice(0, 10)).toBe('2026-11-18')
  })

  it('names `m` rather than rejecting it generically', () => {
    // The obvious thing to type for months, and minutes in every other grammar.
    expect(() => shift(new Date(), '6m')).toThrow(/`m` is ambiguous; use M for months/)
    expect(() => shift(new Date(), 'lastyear')).toThrow(/bad duration "lastyear"/)
    expect(() => shift(new Date(), undefined)).toThrow(/bad duration/)
  })

  it('reaches the date value operators', () => {
    const now = at('2026-08-18T12:00:00Z')
    expect(matchValue('2026-05-01', { last: '6M' }, now)).toBe(true)
    expect(matchValue('2025-12-01', { last: '6M' }, now)).toBe(false)   // older than 6 months
    expect(matchValue('2026-11-01', { next: '6M' }, now)).toBe(true)
    expect(matchValue('2025-12-01', { before: '6M' }, now)).toBe(true)
  })
})

describe('facts: a temporal operator with no window', () => {
  const history = [
    { value: 1, observed_at: at('2026-08-01') },
    { value: 5, observed_at: at('2026-08-15') },
  ]
  const now = at('2026-08-18T12:00:00Z')

  it('names the OPERATOR and the shape, not the value "undefined"', () => {
    for (const op of ['changed', 'increased', 'decreased', 'transition']) {
      expect(() => matchTemporal(history, { [op]: {} }, now))
        .toThrow(new RegExp(op + '. needs a lookback window[\\s\\S]*last: "7d"'))
    }
  })

  it('says so for a bare duration too, which is the natural mistake', () => {
    expect(() => matchTemporal(history, { increased: '7d' }, now))
      .toThrow(/`increased` needs a lookback window.*Got "7d"/s)
  })

  it('works with the window it asks for', () => {
    expect(matchTemporal(history, { increased: { last: '30d' } }, now)).toBe(true)
    expect(matchTemporal(history, { increased: { last: '6M' } }, now)).toBe(true)
    expect(matchTemporal(history, { decreased: { last: '30d' } }, now)).toBe(false)
  })

  // held/distinct were listed in TEMPORAL_OPS and implemented in temporalMatchedAt,
  // but matchTemporal threw "unknown temporal operator" for them — so the same
  // predicate selected a population fine and blew up when tested against ONE
  // passport, which is the path journeys and person-insight take.
  it('evaluates held and distinct instead of calling them unknown', () => {
    expect(matchTemporal(history, { held: 1 }, now)).toBe(true)
    expect(matchTemporal(history, { held: 99 }, now)).toBe(false)
    expect(matchTemporal(history, { held: { gte: 4 } }, now)).toBe(true)
    expect(matchTemporal(history, { distinct: { gte: 2 } }, now)).toBe(true)
    expect(matchTemporal(history, { distinct: { gte: 3 } }, now)).toBe(false)
  })

  it('still rejects an operator that does not exist, and lists the real ones', () => {
    expect(() => matchTemporal(history, { changed: { last: '7d' }, grew: { last: '7d' } }, now))
      .toThrow(/unknown temporal operator "grew".*changed\/transition/s)
  })
})
