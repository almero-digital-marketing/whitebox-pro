import { describe, it, expect } from 'vitest'
import { canonicalUrl } from '../../src/awareness/pii.js'

// The cases below are the shapes actually found in a live exposures table, in the
// proportions they appeared: 187,034 of 537,576 stored URLs carried a query
// string, ~96% of it marketing attribution and 2,397 rows a Stripe
// `payment_intent_client_secret` — a credential in a table dashboards read.
describe('canonicalUrl', () => {
  const c = (u, keep) => canonicalUrl(u, keep ? { keep } : undefined)

  it('drops the query string', () => {
    expect(c('https://gpoint.bg/checkout?payment_intent_client_secret=pi_3Rx_secret_abc&redirect_status=succeeded'))
      .toBe('https://gpoint.bg/checkout')
    expect(c('https://gpoint.bg/booking?utm_source=google&utm_medium=cpc&gclid=EAIaIQob'))
      .toBe('https://gpoint.bg/booking')
  })

  it('drops the fragment, and the query behind it', () => {
    expect(c('https://gpoint.bg/faq#pricing')).toBe('https://gpoint.bg/faq')
    expect(c('https://gpoint.bg/faq#/tab?token=abc')).toBe('https://gpoint.bg/faq')
  })

  it('leaves a URL with nothing to strip exactly as it is', () => {
    // Identity matters: this value is grouped and counted, so a canonicaliser
    // that reformatted clean URLs would split every total that mentions one.
    for (const u of ['https://gpoint.bg/booking', 'https://gpoint.bg/', '/checkout', 'gpoint.bg/x']) {
      expect(c(u)).toBe(u)
    }
  })

  it('handles a relative path, which `new URL` cannot parse', () => {
    expect(c('/checkout?token=abc')).toBe('/checkout')
    expect(c('/checkout?gclid=X', ['gclid'])).toBe('/checkout?gclid=X')
  })

  it('passes null / undefined / empty through untouched', () => {
    expect(c(null)).toBe(null)
    expect(c(undefined)).toBe(undefined)
    expect(c('')).toBe('')
  })

  it('keeps ONLY the named parameters, dropping everything beside them', () => {
    // The point of the keep-list: gclid is the only record of which ad click led
    // to a visit and lives nowhere else, while the secret next to it must go.
    expect(c('https://gpoint.bg/checkout?payment_intent_client_secret=pi_secret&gclid=EAIaIQob&utm_source=google', ['gclid']))
      .toBe('https://gpoint.bg/checkout?gclid=EAIaIQob')
  })

  it('emits kept parameters in the ORDER GIVEN, not the order received', () => {
    // Two arrival orders of the same visit must canonicalise identically, or one
    // page becomes two rows in every breakdown.
    const keep = ['gclid', 'fbclid']
    expect(c('https://x.bg/p?fbclid=B&gclid=A', keep)).toBe('https://x.bg/p?gclid=A&fbclid=B')
    expect(c('https://x.bg/p?gclid=A&fbclid=B', keep)).toBe('https://x.bg/p?gclid=A&fbclid=B')
  })

  it('matches parameter names case-insensitively but preserves the value', () => {
    expect(c('https://x.bg/p?GCLID=AbC', ['gclid'])).toBe('https://x.bg/p?GCLID=AbC')
  })

  it('drops the `?` entirely when nothing survives the keep-list', () => {
    // A trailing '?' would be a second spelling of the same page.
    expect(c('https://x.bg/p?utm_source=google', ['gclid'])).toBe('https://x.bg/p')
    expect(c('https://x.bg/p?', ['gclid'])).toBe('https://x.bg/p')
  })

  it('keeps a valueless flag, and ignores a repeat of an already-kept name', () => {
    expect(c('https://x.bg/p?debug&gclid=A', ['debug'])).toBe('https://x.bg/p?debug')
    expect(c('https://x.bg/p?gclid=first&gclid=second', ['gclid'])).toBe('https://x.bg/p?gclid=first')
  })

  it('does not mistake a substring for a parameter name', () => {
    // `keep: ['id']` must not retain `payment_intent_client_secret` or `gad_campaignid`.
    expect(c('https://x.bg/p?payment_intent=pi_1&gad_campaignid=99&id=7', ['id']))
      .toBe('https://x.bg/p?id=7')
  })
})
