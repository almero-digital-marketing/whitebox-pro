import { describe, it, expect } from 'vitest'
import { CANONICAL_EVENTS, CONVERSION_EVENTS, validateEvent, validateCustom, composeManifest } from '../src/index.js'

describe('kernel — schemas', () => {
  it('exposes the canonical event vocabulary', () => {
    expect(CONVERSION_EVENTS).toEqual(CANONICAL_EVENTS)
    expect(CANONICAL_EVENTS).toContain('purchase')
    expect(CANONICAL_EVENTS).toContain('find_location')
  })

  it('validates a find_location event (no mandatory fields — the base schema)', () => {
    expect(validateEvent('find_location', { content_id: 'sofia-center', content_name: 'Sofia Center' }))
      .toEqual({ content_name: 'Sofia Center' })   // content_id isn't in the base shape — stripped like any other unknown key
    expect(validateEvent('find_location', {})).toEqual({})
  })

  it('validates a purchase (value+currency required) and strips unknown keys', () => {
    expect(validateEvent('purchase', { value: 9.99, currency: 'usd', typo: 1 })).toEqual({ value: 9.99, currency: 'usd' })
    expect(() => validateEvent('purchase', { value: 9.99 })).toThrow(/currency/)
    expect(() => validateEvent('frobnicate', {})).toThrow(/unknown standard event/)
  })

  it('validates a custom event payload', () => {
    expect(validateCustom({ value: 1, meta: { tier: 'gold' } })).toEqual({ value: 1, meta: { tier: 'gold' } })
  })
})

describe('kernel — composeManifest', () => {
  it('unions eligible networks\' signal specs (deduped by key)', () => {
    const nets = [
      { eligible: true, signals: [{ key: 'fbp' }, { key: 'fbc' }] },
      { eligible: true, signals: [{ key: 'fbp' }, { key: 'ttp' }] },
      { eligible: false, signals: [{ key: 'never' }] },
    ]
    expect(composeManifest(nets).collect.map(s => s.key)).toEqual(['fbp', 'fbc', 'ttp'])
  })
})
