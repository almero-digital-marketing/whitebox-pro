import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { shortener } from '../src/index.js'

manifestSuite({
  plugin: shortener({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['shortener.claimed'],
  // `awareness.recorded` is core's event; we describe only the rows WE produced
  // (the catalog routes by `data.plugin`). See docs/11-plugin-events.md.
  scopedDetail: ['awareness.recorded'],
})

// live had no branch for us at all, so a claim showed as a bare type name with an
// empty detail column.
describe('shortener event detail', () => {
  const d = shortener({}).detail['shortener.claimed']

  // The destination and our own label beat the code: nobody recognises "aB3x".
  it('names the link by what we called it, or where it goes', () => {
    expect(d({ code: 'aB3x', url: 'https://gpoint.bg/promo', label: 'July promo' })).toBe('July promo')
    expect(d({ code: 'aB3x', url: 'https://gpoint.bg/promo' })).toBe('/promo')
    expect(d({ code: 'aB3x' })).toBe('/aB3x')
  })

  // A merge is the interesting part when it happens: the claim joined an anonymous
  // visitor to a known person.
  it('says so when the claim merged two identities', () => {
    expect(d({ code: 'aB3x', merged: true })).toBe('/aB3x · merged identities')
    expect(d({ merged: true })).toBe('merged identities')
  })

  // WHY they were sent it — the link's own UTMs, carried on the payload.
  it('carries the attribution the link was built with', () => {
    expect(d({ code: 'aB3x', utm_source: 'facebook', utm_campaign: 'july' }))
      .toBe('/aB3x · facebook / july')
  })

  it('says nothing rather than something vague', () => {
    expect(d({})).toBeNull()
  })
})
