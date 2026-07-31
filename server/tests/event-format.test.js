// The display helpers a `detail` declaration shares.
//
// These live in core precisely so there is one copy: `pathOf` encodes two bug
// fixes (percent-decoding for display, and surviving a malformed escape) and a
// second copy in some plugin would inevitably have only one of them.
import { describe, it, expect } from 'vitest'
import { trim, body, money, collapse, decodePath, pathOf, letters, MAX } from '../src/event-format.js'

describe('trim()', () => {
  // The cap is a SAFETY bound, not a layout decision: clipping to a display width
  // here ellipsised text while half the feed row was still empty, since only the
  // browser knows the column's real width. CSS `text-overflow` cuts it at the true
  // edge; this only stops a pathological payload filling every row.
  it('bounds a pathological value without pretending to know the column width', () => {
    const out = trim('x'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(MAX)
    expect(out.endsWith('…')).toBe(true)
    // still generous enough that a real sentence is never the server's problem
    expect(out.length).toBeGreaterThan(150)
  })

  it('collapses nothing-ish values to null so callers need no guard', () => {
    for (const v of [null, undefined, '', '   ']) expect(trim(v)).toBeNull()
  })

  it('leaves a normal string alone apart from surrounding space', () => {
    expect(trim('  hello  ')).toBe('hello')
  })
})

describe('body()', () => {
  // Payloads are nested one level: notify(type, { type, data }).
  it('unwraps data, tolerating a bare payload or nothing at all', () => {
    expect(body({ type: 't', data: { a: 1 } })).toEqual({ a: 1 })
    expect(body({ a: 1 })).toEqual({ a: 1 })
    expect(body(null)).toEqual({})
  })
})

describe('money()', () => {
  it('formats a value with its currency, and nothing without a value', () => {
    expect(money(120, 'BGN')).toBe('120 BGN')
    expect(money(120, null)).toBe('120')
    // 0 is a real amount and must not be swallowed by a falsy check
    expect(money(0, 'EUR')).toBe('0 EUR')
    for (const v of [null, undefined, '']) expect(money(v, 'EUR')).toBeNull()
  })
})

describe('collapse()', () => {
  // Real page text arrives with newlines and whitespace runs from the DOM; a feed
  // row is one line.
  it('flattens newlines and whitespace runs out of real page text', () => {
    expect(collapse('one\n\n  two\t\tthree  ')).toBe('one two three')
  })
})

describe('pathOf() / decodePath()', () => {
  // gpoint.bg's routes are Bulgarian, so the browser sends them percent-encoded.
  // Undecoded they're unreadable AND long enough to crowd the rest of the row out.
  it('percent-decodes a non-ASCII path for display', () => {
    expect(pathOf('https://gpoint.bg/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81'))
      .toBe('/запазване-час')
    expect(decodePath('%D0%BA%D0%BB%D1%83%D0%B1')).toBe('клуб')
  })

  it('keeps the raw string when a sequence is malformed, rather than losing the row', () => {
    // decodeURIComponent throws on these; a feed row must never be what breaks
    for (const bad of ['https://gpoint.bg/100%', 'https://gpoint.bg/%E0%A4%A']) {
      expect(() => pathOf(bad)).not.toThrow()
      expect(pathOf(bad)).toBeTruthy()
    }
  })

  it('drops the query, and names the host when the path is just /', () => {
    expect(pathOf('https://a.bg/studios/sofia?utm_source=x')).toBe('/studios/sofia')
    expect(pathOf('https://a.bg/')).toBe('a.bg')
  })

  it('passes a non-url through rather than returning nothing', () => {
    expect(pathOf('not a url')).toBe('not a url')
    expect(pathOf(null)).toBeNull()
  })
})

describe('letters()', () => {
  // Used to compare a label against an event name; punctuation, case and word
  // separators must not hide a match, in Latin or Cyrillic.
  it('reduces to letters and digits across both alphabets', () => {
    expect(letters('Conversion: view_content')).toBe('conversionviewcontent')
    expect(letters('Запазване — час!')).toBe('запазванечас')
  })
})
