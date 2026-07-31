import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { conversions } from '../src/index.js'

// Both our type families are built with template literals — `conversion.${name}`
// and `adnetwork.${status}` — so the scan finds the NAMESPACES rather than exact
// types, and the check is that a prefix covers each.
//
// The plural bug lived here: live declared 'conversions.' while we emit
// `conversion.` singular, so every conversion classified as `unknown` and nobody
// noticed, because a prefix that matches nothing looks exactly like one that works.
manifestSuite({
  plugin: conversions({}),
  srcDir: new URL('../src', import.meta.url),
  // `conversion.${name}` is genuinely open — the name is the host's — so that one
  // is declared as a prefix. `adnetwork.${status}` is not: reporter.js only
  // notifies for adapters it actually called, so res.status is one of these three.
  //
  // `adnetwork.skipped` is deliberately absent. An ineligible network `continue`s
  // BEFORE the notify, so no such event has ever existed — it's a counter in our
  // status(), not an event. live's map declared it anyway.
  dynamicTypes: ['adnetwork.accepted', 'adnetwork.rejected', 'adnetwork.error'],
})

describe('conversions event detail', () => {
  const conversion = conversions({}).detail['conversion.']
  const adnetwork = conversions({}).detail['adnetwork.']

  it('leads with what the conversion was worth', () => {
    expect(conversion({ value: 120, currency: 'BGN' })).toBe('120 BGN')
    expect(conversion({ value: 120 })).toBe('120')
    // 0 is a real value — a free trial signup is not "no conversion"
    expect(conversion({ value: 0, currency: 'BGN' })).toBe('0 BGN')
  })

  it('falls back to where it happened when no money is attached', () => {
    expect(conversion({ url: 'https://gpoint.bg/studios/sofia?utm_source=x' })).toBe('/studios/sofia')
    expect(conversion({ kind: 'lead' })).toBe('lead')
    expect(conversion({})).toBeNull()
  })

  // gpoint.bg's routes are Bulgarian, so the browser sends them percent-encoded;
  // undecoded they're unreadable and long enough to crowd out the row.
  it('percent-decodes a non-ASCII path for display', () => {
    expect(conversion({ url: 'https://gpoint.bg/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81' }))
      .toBe('/запазване-час')
  })

  // The failure reason is the entire point of the event when there is one: the
  // conversion already counted as a success, so it cannot express this.
  it('names the network and event, and the rejection reason when there is one', () => {
    expect(adnetwork({ network: 'meta', event: 'Purchase' })).toBe('meta · Purchase')
    expect(adnetwork({ network: 'tiktok', event: 'AddToCart', error: 'invalid pixel' }))
      .toBe('tiktok · AddToCart — invalid pixel')
    expect(adnetwork({})).toBeNull()
  })
})
