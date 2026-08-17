import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stickyParam, clickIdClaims } from '../src/browser.js'

// A click id is in the URL on the landing page and nowhere afterwards, so the
// behaviour under test is what happens on the NEXT page view — which is when
// conversions actually occur.
function browser(search = '') {
  const store = new Map()
  vi.stubGlobal('window', {
    location: { search },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
  })
  return store
}

const net = (signals) => ({ name: 'n', signals })

describe('stickyParam', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('reads the URL and remembers it', () => {
    const store = browser('?gclid=abc123')
    expect(stickyParam('gclid')).toBe('abc123')
    expect(store.size).toBe(1)
  })

  it('still returns the id once the URL no longer has it', () => {
    const store = browser('?gclid=abc123')
    stickyParam('gclid')                       // landing page
    const kept = [...store.entries()]
    browser('')                                // a later page view, same visit
    for (const [k, v] of kept) window.localStorage.setItem(k, v)
    expect(stickyParam('gclid')).toBe('abc123')
  })

  it('a FRESH click wins over the remembered one', () => {
    // Otherwise a second campaign's conversion is credited to the first campaign.
    const store = browser('?gclid=first')
    stickyParam('gclid')
    const kept = [...store.entries()]
    browser('?gclid=second')
    for (const [k, v] of kept) window.localStorage.setItem(k, v)
    expect(stickyParam('gclid')).toBe('second')
  })

  it('forgets an id past its ttl', () => {
    const store = browser('?gclid=abc')
    stickyParam('gclid', { ttlDays: 90 })
    const kept = [...store.entries()]
    browser('')
    for (const [k, v] of kept) window.localStorage.setItem(k, v)
    // Google will not accept an offline conversion for a click this old, so
    // keeping the value would only mean holding an identifier for nothing.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 91 * 864e5)
    expect(stickyParam('gclid')).toBe(null)
    vi.restoreAllMocks()
  })

  it('returns null rather than throwing when storage is unavailable', () => {
    // Private mode, or storage disabled by policy. The page must still work.
    vi.stubGlobal('window', {
      location: { search: '?gclid=abc' },
      localStorage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } },
    })
    expect(stickyParam('gclid')).toBe('abc')   // the URL value still comes back
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } },
    })
    expect(stickyParam('gclid')).toBe(null)
  })

  it('is inert server-side', () => {
    vi.unstubAllGlobals()
    expect(stickyParam('gclid')).toBe(null)
  })
})

describe('clickIdClaims', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('claims only the signals a network MARKS as click ids', () => {
    browser('?gclid=abc&_ga=xyz&ttclid=t1')
    const claims = clickIdClaims([net([
      { key: 'gclid', from: 'url', name: 'gclid', clickId: true },
      { key: 'ga_client_id', from: 'cookie', name: '_ga' },      // not a click id
      { key: 'other', from: 'url', name: 'other' },              // url, but unmarked
    ])])
    expect(claims).toEqual([{ type: 'clickid', name: 'gclid', value: 'abc' }])
  })

  it('uses the WEAK `clickid` type for every network', () => {
    // The whole safety property: weak identities never drive a merge, and click
    // ids are demonstrably shared between people.
    browser('?gclid=a&ttclid=b')
    const claims = clickIdClaims([
      net([{ key: 'gclid', from: 'url', name: 'gclid', clickId: true }]),
      net([{ key: 'ttclid', from: 'url', name: 'ttclid', clickId: true }]),
    ])
    expect(claims.map(c => c.type)).toEqual(['clickid', 'clickid'])
    expect(claims.map(c => c.name)).toEqual(['gclid', 'ttclid'])
  })

  it('skips a parameter the visit did not arrive with', () => {
    browser('?gclid=abc')
    const claims = clickIdClaims([net([
      { key: 'gclid', from: 'url', name: 'gclid', clickId: true },
      { key: 'wbraid', from: 'url', name: 'wbraid', clickId: true },
    ])])
    expect(claims).toEqual([{ type: 'clickid', name: 'gclid', value: 'abc' }])
  })

  it('claims each name once when two networks declare the same one', () => {
    browser('?gclid=abc')
    const spec = { key: 'gclid', from: 'url', name: 'gclid', clickId: true }
    expect(clickIdClaims([net([spec]), net([spec])])).toHaveLength(1)
  })

  it('is empty for no networks, and for networks without signals', () => {
    browser('?gclid=abc')
    expect(clickIdClaims([])).toEqual([])
    expect(clickIdClaims([{ name: 'n' }])).toEqual([])
  })
})
