import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { shortener } from '../src/index.js'

manifestSuite({
  plugin: shortener({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['shortener.claimed'],
})

// live had no branch for us at all, so a claim showed as a bare type name with an
// empty detail column.
describe('shortener event detail', () => {
  const d = shortener({}).detail['shortener.claimed']

  it('names the link that was followed', () => {
    expect(d({ code: 'aB3x', merged: false })).toBe('/aB3x')
  })

  // A merge is the interesting part when it happens: the claim joined an anonymous
  // visitor to a known person.
  it('says so when the claim merged two identities', () => {
    expect(d({ code: 'aB3x', merged: true })).toBe('/aB3x — merged identities')
    expect(d({ merged: true })).toBe('merged identities')
  })

  it('says nothing rather than something vague', () => {
    expect(d({})).toBeNull()
  })
})
