import { describe, it, expect } from 'vitest'
import { matchValue, matchTemporal, isTemporal } from '../../src/facts/operators.js'

// Fixed "now" so the date-relative ops are deterministic.
const NOW = new Date('2026-06-20T00:00:00Z')
const mv = (value, predicate) => matchValue(value, predicate, NOW)
const mt = (history, predicate) => matchTemporal(history, predicate, NOW)
const row = (value, observed_at) => ({ value, observed_at })

describe('matchValue — value operators', () => {
  it('eq / ne / in', () => {
    expect(mv('pro', { eq: 'pro' })).toBe(true)
    expect(mv('pro', { eq: 'free' })).toBe(false)
    expect(mv('pro', { ne: 'free' })).toBe(true)
    expect(mv('pro', { in: ['pro', 'enterprise'] })).toBe(true)
    expect(mv('free', { in: ['pro', 'enterprise'] })).toBe(false)
  })

  it('eq / ne / in coerce numeric facts stored as strings', () => {
    expect(mv('active', { eq: 'active' })).toBe(true)     // string equality intact
    expect(mv('123', { eq: 123 })).toBe(true)             // cross-type numeric match
    expect(mv(123, { eq: '123' })).toBe(true)             // …both directions
    expect(mv('08', { eq: 8 })).toBe(true)                // leading zeros
    expect(mv('123', { ne: 123 })).toBe(false)            // ne is the exact negation
    expect(mv('123', { in: [123, 456] })).toBe(true)      // in matches either type
    expect(mv('789', { in: [123, 456] })).toBe(false)
    expect(mv('08-A', { eq: 8 })).toBe(false)             // non-numeric string NOT coerced
    expect(mv('active', { eq: 0 })).toBe(false)           // label vs number stays distinct
  })

  it('numeric gt / gte / lt / lte and ranges', () => {
    expect(mv(240, { gte: 200 })).toBe(true)
    expect(mv(240, { gt: 240 })).toBe(false)
    expect(mv(240, { lt: 300 })).toBe(true)
    expect(mv(240, { gte: 200, lte: 300 })).toBe(true)   // AND-ed range
    expect(mv(500, { gte: 200, lte: 300 })).toBe(false)
  })

  it('numeric STRING values order numerically, not as dates', () => {
    // Regression: cmp → toTime → Date.parse read "1820" as the YEAR 1820 (a large
    // negative epoch), so a stringified lifetime_value silently inverted gte/lt.
    expect(mv('1820', { gte: 500 })).toBe(true)
    expect(mv('1820', { lt: 500 })).toBe(false)
    expect(mv('450', { gte: 0, lt: 500 })).toBe(true)
    expect(mv('500', { gte: 500 })).toBe(true)             // boundary
    expect(mv('99', { gt: '100' })).toBe(false)            // both stringified numbers
  })

  it('non-numeric strings still order by date then lexically', () => {
    expect(mv('2024-06-01', { gte: '2024-01-01' })).toBe(true)   // ISO date ordering intact
    expect(mv('2024-01-01', { gt: '2024-06-01' })).toBe(false)
    expect(mv('gold', { gt: 'bronze' })).toBe(true)              // lexical intact
    expect(mv('bronze', { gt: 'gold' })).toBe(false)
  })

  it('directional date ops still parse numeric-ish strings via toTime (not cmp)', () => {
    // `last`/`next`/`before` use toTime, not cmp — a bare number stays "unparseable
    // as a window-relative date" and simply doesn't match, unchanged by this fix.
    expect(mv('5', { last: '30d' })).toBe(false)
  })

  it('present / absent', () => {
    expect(mv('x', { present: true })).toBe(true)
    expect(mv(undefined, { present: false })).toBe(true)
    expect(mv(undefined, { present: true })).toBe(false)
    expect(mv(undefined, { eq: 'x' })).toBe(false)       // any op on an absent key fails
  })

  // A null value is the dangerous one: it is a real row, so it survives every
  // "does this key exist" check, and it used to reach the LEXICAL branch of cmp()
  // where 'null' > '1' — so every numeric lower bound matched it.
  it('a NULL value matches no operator — it is absence, not a comparable value', () => {
    for (const p of [{ gte: 1 }, { gt: 0 }, { gte: 300 }, { lte: 10 }, { lt: 5 }]) {
      expect(mv(null, p)).toBe(false)
    }
    expect(mv(null, { eq: 'x' })).toBe(false)
    expect(mv(null, { in: ['a', 'b'] })).toBe(false)
    // `ne` too: a key with no row has never matched `{ ne: … }`, and null follows
    // it rather than being a second, looser kind of absent.
    expect(mv(null, { ne: 'x' })).toBe(false)
    expect(mv(null, { next: '30d' })).toBe(false)
    expect(mv(null, { last: '30d' })).toBe(false)
  })

  it('null answers `present` the same way every other operator does', () => {
    expect(mv(null, { present: true })).toBe(false)
    expect(mv(null, { present: false })).toBe(true)
    // The contradiction this removes: a value that is "present" but fails every
    // comparison, so it inflates a cohort count that no breakdown can account for.
    expect(mv(null, { present: true, gte: 1 })).toBe(false)
  })

  it('a null BOUND is incomparable too, whichever way the value sorts', () => {
    // The mirror case, and the reason the guard lives in cmp() rather than only at
    // the top of matchValue. Lexically 'zebra' > 'null' and 'active' < 'null', so a
    // null bound matched a seemingly arbitrary half of the base — the kind of
    // result that looks like a real segment.
    expect(mv('zebra', { gte: null })).toBe(false)
    expect(mv('active', { gte: null })).toBe(false)
    expect(mv(5, { gte: null })).toBe(false)
    expect(mv(5, { lte: null })).toBe(false)     // `null <= 0` is true in JS — the trap
    expect(mv(5, { gt: null })).toBe(false)
    expect(mv(5, { lt: null })).toBe(false)
  })

  it('0 and the empty string are VALUES, and still compare', () => {
    // The fix must key on null/undefined, not falsiness: a spend of 0 is a fact.
    expect(mv(0, { lte: 10 })).toBe(true)
    expect(mv(0, { gte: 0 })).toBe(true)
    expect(mv(0, { present: true })).toBe(true)
    expect(mv('', { present: true })).toBe(true)
    expect(mv(false, { present: true })).toBe(true)
    expect(mv(false, { eq: false })).toBe(true)
  })

  it('string operators, case-insensitively', () => {
    // Their absence forced a 44-value `in` clause to say "location starts with
    // София", and that clause is what produced a wrong count. One operator removes
    // the whole class of workaround.
    expect(mv('София - Лозенец', { startsWith: 'софия' })).toBe(true)
    expect(mv('Пловдив', { startsWith: 'софия' })).toBe(false)
    expect(mv('София - Лозенец', { contains: 'лозенец' })).toBe(true)
    expect(mv('a@b.bg', { endsWith: '.bg' })).toBe(true)
    expect(mv(359881234567, { startsWith: '359' })).toBe(true)   // a number is text here
    expect(mv(undefined, { startsWith: 'x' })).toBe(false)       // absent matches nothing
    expect(mv('София', { present: true, startsWith: 'соф' })).toBe(true)   // AND-ed
  })

  it('names the operator you probably meant', () => {
    // `exists` returning "unknown value operator" read as "there is no existence
    // test", and sent a caller off to build one from a sentinel date.
    const msg = (p) => { try { mv('x', p) } catch (e) { return e.message } }
    expect(msg({ exists: true })).toMatch(/spelled `present`/)
    expect(msg({ isNull: true })).toMatch(/spelled `present: false`/)
    expect(msg({ like: 'x' })).toMatch(/spelled `contains`/)
    // and every operator is named, so a wrong guess never needs a second query
    expect(msg({ nope: 1 })).toMatch(/present.*eq\/ne\/in.*gte.*contains\/startsWith\/endsWith/)
  })

  it('date ops: next (upcoming) / last (recent) / before (older)', () => {
    expect(mv('2026-07-01', { next: '30d' })).toBe(true)    // 11 days ahead
    expect(mv('2026-07-01', { next: '7d' })).toBe(false)
    expect(mv('2026-06-10', { last: '30d' })).toBe(true)     // 10 days ago
    expect(mv('2026-06-10', { last: '5d' })).toBe(false)
    expect(mv('2026-03-01', { before: '60d' })).toBe(true)    // ~110 days ago
    expect(mv('2026-03-01', { before: '200d' })).toBe(false)
  })
})

describe('matchTemporal — change / transition operators', () => {
  const status = [row('active', '2026-04-10'), row('cancelled', '2026-06-15')]
  const mrr = [row(0, '2026-03-01'), row(240, '2026-04-10'), row(560, '2026-05-20')]

  it('transition into a state, windowed', () => {
    expect(mt(status, { transition: { to: 'cancelled', last: '90d' } })).toBe(true)
    expect(mt(status, { transition: { to: 'cancelled', last: '3d' } })).toBe(false)   // change was Jun 15
    expect(mt(status, { transition: { from: 'active', to: 'cancelled', last: '90d' } })).toBe(true)
    expect(mt(status, { transition: { to: 'active', last: '90d' } })).toBe(false)      // only the initial set
  })

  it('changed', () => {
    expect(mt(status, { changed: { last: '30d' } })).toBe(true)
    expect(mt(status, { changed: { last: '3d' } })).toBe(false)
  })

  it('a value going NULL is not a decrease, and coming back is not an increase', () => {
    // increased/decreased compare consecutive history rows through the same cmp,
    // so before the guard '100' < 'null' made losing a value look like a drop —
    // a "spend decreased" cohort built mostly from records that stopped syncing.
    const lost = [row('100', '2026-06-01'), row(null, '2026-06-10')]
    expect(mt(lost, { decreased: { last: '30d' } })).toBe(false)
    const regained = [row(null, '2026-06-01'), row('100', '2026-06-10')]
    expect(mt(regained, { increased: { last: '30d' } })).toBe(false)
    // and a real move is still detected either side of the gap
    expect(mt([row('100', '2026-06-01'), row('50', '2026-06-10')], { decreased: { last: '30d' } })).toBe(true)
  })

  it('increased / decreased', () => {
    expect(mt(mrr, { increased: { last: '60d' } })).toBe(true)       // 240 → 560 on May 20
    expect(mt(mrr, { decreased: { last: '60d' } })).toBe(false)
    const drop = [row(560, '2026-05-20'), row(300, '2026-06-18')]
    expect(mt(drop, { decreased: { last: '30d' } })).toBe(true)
  })
})

describe('isTemporal', () => {
  it('flags temporal predicates', () => {
    expect(isTemporal({ eq: 'pro' })).toBe(false)
    expect(isTemporal({ transition: { to: 'x', last: '30d' } })).toBe(true)
    expect(isTemporal({ changed: { last: '7d' } })).toBe(true)
  })
})
