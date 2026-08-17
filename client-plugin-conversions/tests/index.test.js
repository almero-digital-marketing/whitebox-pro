import { describe, it, expect, vi } from 'vitest'
import conversionsPlugin from '../src/index.js'
import { google } from 'whitebox-pro-adnetworks-google/client'

// Build a fake client core and install the plugin; return the attached API plus
// the captured /conversions/events requests.
function setup({ consented = true, requireConsent, networks, passportId = 'p-123', failRequests = false } = {}) {
  const requests = []
  const core = {
    http: { request: vi.fn(async (path, opts) => {
      requests.push({ path, opts })
      if (failRequests) throw new Error('network down')
      return {}
    }) },
    queue: (fn) => fn(),                          // run inline
    consent: { has: vi.fn(() => consented) },
    logger: { debug: vi.fn(), warn: vi.fn() },
    getPassportId: () => passportId,
    attach: vi.fn(),
  }
  const opts = requireConsent === undefined ? {} : { requireConsent }
  if (networks) opts.networks = networks
  conversionsPlugin(opts).install(core)
  const api = core.attach.mock.calls[0][1]
  return { api, requests, core }
}

const STANDARD_METHODS = [
  'pageView', 'viewContent', 'search', 'addToCart', 'addToWishlist',
  'beginCheckout', 'addPaymentInfo', 'purchase', 'lead',
  'completeRegistration', 'subscribe', 'contact', 'findLocation',
]

describe('conversions plugin — method surface', () => {
  it('attaches one method per standard event plus track/custom/identify', () => {
    const { api, core } = setup()
    expect(core.attach).toHaveBeenCalledWith('conversions', expect.any(Object))
    for (const m of STANDARD_METHODS) expect(typeof api[m]).toBe('function')
    expect(typeof api.track).toBe('function')
    expect(typeof api.custom).toBe('function')
    expect(typeof api.identify).toBe('function')
  })

  it('identify() with no composed networks is a harmless no-op', () => {
    const { api } = setup()
    expect(api.identify([{ type: 'email', name: 'email', value: 'a@x.com' }])).toEqual([])
  })

  it('identify() returns [] when consent is withheld', () => {
    const { api } = setup({ consented: false })
    expect(api.identify([{ type: 'email', name: 'email', value: 'a@x.com' }])).toEqual([])
  })
})

describe('conversions plugin — validation', () => {
  it('purchase sends a well-formed event with value + currency', async () => {
    const { api, requests } = setup()
    const { event_id } = await api.purchase({ value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })

    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/conversions/events')
    const body = requests[0].opts.body
    expect(body.passport_id).toBe('p-123')
    expect(body.events).toHaveLength(1)
    const ev = body.events[0]
    expect(ev).toMatchObject({ standard: 'purchase', value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })
    expect(ev.event_id).toBeTruthy()
    expect(ev.event_id).toBe(event_id)
    expect(typeof ev.ts).toBe('string')
  })

  it('purchase throws when value/currency are missing (no request sent)', async () => {
    const { api, requests } = setup()
    expect(() => api.purchase({ content_ids: ['x'] })).toThrow(/invalid payload/)
    expect(requests).toHaveLength(0)
  })

  it('rejects wrong field types', () => {
    const { api } = setup()
    expect(() => api.purchase({ value: 'free', currency: 'USD' })).toThrow(/value/)
    expect(() => api.addToCart({ content_ids: 'sku-1' })).toThrow(/content_ids/)
  })

  it('strips unknown keys, keeps meta passthrough', async () => {
    const { api, requests } = setup()
    await api.viewContent({ content_ids: ['a'], typo_field: 1, meta: { source: 'pdp' } })
    const ev = requests[0].opts.body.events[0]
    expect(ev.typo_field).toBeUndefined()
    expect(ev.meta).toEqual({ source: 'pdp' })
    expect(ev.standard).toBe('view_content')
  })

  it('honors a caller-supplied event_id (pixel dedup)', async () => {
    const { api, requests } = setup()
    await api.lead({ event_id: 'fixed-123' })
    expect(requests[0].opts.body.events[0].event_id).toBe('fixed-123')
  })
})

describe('conversions plugin — generics', () => {
  it('track(standard, payload) validates and sends', async () => {
    const { api, requests } = setup()
    await api.track('add_to_cart', { content_ids: ['z'] })
    expect(requests[0].opts.body.events[0].standard).toBe('add_to_cart')
  })

  it('track rejects an unknown standard event', () => {
    const { api } = setup()
    expect(() => api.track('frobnicate', {})).toThrow(/unknown standard event/)
  })

  it('custom(name, payload) sends a non-standard event', async () => {
    const { api, requests } = setup()
    await api.custom('wb_high_intent', { value: 1, meta: { tier: 'gold' } })
    const ev = requests[0].opts.body.events[0]
    expect(ev.event).toBe('wb_high_intent')
    expect(ev.standard).toBeUndefined()
    expect(ev.meta).toEqual({ tier: 'gold' })
  })

  it('custom requires a name', () => {
    const { api } = setup()
    expect(() => api.custom('', {})).toThrow(/name/)
  })
})

describe('conversions plugin — consent', () => {
  it('skips the send when marketing consent is not granted', async () => {
    const { api, requests, core } = setup({ consented: false })
    const res = await api.purchase({ value: 10, currency: 'USD' })
    expect(res).toEqual({ skipped: 'consent' })
    expect(requests).toHaveLength(0)
    expect(core.consent.has).toHaveBeenCalledWith('marketing')
  })

  it('sends regardless when requireConsent is false', async () => {
    const { api, requests } = setup({ consented: false, requireConsent: false })
    await api.purchase({ value: 10, currency: 'USD' })
    expect(requests).toHaveLength(1)
  })
})

// The server being unreachable must not surface in the host's product. A conversion
// send is fire-and-forget — a router hook tracks a page view and does not await it —
// so a rejection here has no handler anywhere and lands in the HOST's console and
// error reporter, once per navigation, about a failure they cannot act on.
describe('conversions plugin — server unreachable', () => {
  function offlineSetup() {
    const core = {
      http: { request: vi.fn(async () => { throw new TypeError('Failed to fetch') }) },
      queue: (fn) => fn(),
      consent: { has: () => true },
      logger: { debug: vi.fn(), warn: vi.fn() },
      getPassportId: () => 'p-123',
      attach: vi.fn(),
    }
    conversionsPlugin({}).install(core)
    return { api: core.attach.mock.calls[0][1], core }
  }

  it('resolves instead of rejecting', async () => {
    const { api } = offlineSetup()
    await expect(api.pageView({ url: '/x' })).resolves.toBeDefined()
  })

  it('raises no unhandled rejection when the call is not awaited', async () => {
    const seen = []
    const onUnhandled = (e) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    const { api } = offlineSetup()
    api.pageView({ url: '/a' })
    api.purchase({ value: 10, currency: 'BGN' })
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    process.off('unhandledRejection', onUnhandled)
    expect(seen).toEqual([])
  })

  // Reported on the RESULT, not thrown — a checkout that wants to know whether its
  // Purchase was recorded can still find out, without that being forced on the
  // page-view call in a router hook.
  it('reports the failure on the result for a caller who does await', async () => {
    const { api } = offlineSetup()
    const res = await api.purchase({ value: 10, currency: 'BGN' })
    expect(res.error).toMatch(/Failed to fetch/)
    expect(res.event_id).toBeTruthy()
  })

  // One warning per OUTAGE, not per event — a busy site tracks many, and a warning
  // each would fill the host's console with one message repeated. The rest go to
  // debug, where the detail is still available.
  it('warns once per outage and drops the rest to debug', async () => {
    const { api, core } = offlineSetup()
    await api.pageView({ url: '/a' })
    await api.pageView({ url: '/b' })
    await api.purchase({ value: 1, currency: 'BGN' })

    const warned = core.logger.warn.mock.calls.filter(c => /server unreachable/.test(String(c[0])))
    expect(warned.length).toBe(1)
    const debugged = core.logger.debug.mock.calls.filter(c => /send failed/.test(String(c[0])))
    expect(debugged.length).toBe(2)
  })

  // A success ends the outage, so a later failure is news again.
  it('warns again after a success in between', async () => {
    const core = {
      http: { request: vi.fn() },
      queue: (fn) => fn(),
      consent: { has: () => true },
      logger: { debug: vi.fn(), warn: vi.fn() },
      getPassportId: () => 'p',
      attach: vi.fn(),
    }
    conversionsPlugin({}).install(core)
    const api = core.attach.mock.calls[0][1]

    core.http.request.mockRejectedValueOnce(new TypeError('down'))
    await api.pageView({ url: '/a' })
    core.http.request.mockResolvedValueOnce({})          // back up
    await api.pageView({ url: '/b' })
    core.http.request.mockRejectedValueOnce(new TypeError('down again'))
    await api.pageView({ url: '/c' })

    const warned = core.logger.warn.mock.calls.filter(c => /server unreachable/.test(String(c[0])))
    expect(warned.length).toBe(2)
  })

  // The pixels fire synchronously BEFORE the server call, so an outage costs the
  // first-party record and the CAPI call — not the ad-platform signal. The result has
  // to keep saying so truthfully.
  it('still reports the pixels that did fire', async () => {
    const { api } = offlineSetup()
    const res = await api.pageView({ url: '/x' })
    expect(res).toHaveProperty('pixels')
  })
})

// A click id is in the URL only on the landing page, so it has to be captured on
// arrival — not at conversion time, when it is long gone. Stored as a WEAK
// `clickid` identity, which never drives a passport merge; click ids look unique
// but measurably are not (2,237 gclid values on live traffic had been seen by more
// than one passport).
describe('conversions plugin — click ids linked at install', () => {
  const store = {}
  const arrive = (search) => {
    for (const k of Object.keys(store)) delete store[k]
    window.localStorage = {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
    }
    window.location = { search, href: 'https://x.bg/land' + search }
    window.gtag = vi.fn()
  }
  const linkCalls = (requests) => requests.filter(r => r.path === '/passports/link')

  it('links the click ids the visit arrived with', async () => {
    arrive('?gclid=G1&wbraid=W1')
    const { requests } = setup({ networks: [google()] })
    await vi.waitFor(() => expect(linkCalls(requests)).toHaveLength(1))
    const body = linkCalls(requests)[0].opts.body
    expect(body.passport_id).toBe('p-123')
    expect(body.claims).toEqual([
      { type: 'clickid', name: 'gclid', value: 'G1' },
      { type: 'clickid', name: 'wbraid', value: 'W1' },
    ])
  })

  it('posts nothing when the visit carried no click id', async () => {
    arrive('')
    const { requests } = setup({ networks: [google()] })
    await new Promise(r => setTimeout(r, 5))
    expect(linkCalls(requests)).toHaveLength(0)
  })

  it('does not link without marketing consent', async () => {
    arrive('?gclid=G1')
    const { requests } = setup({ networks: [google()], consented: false })
    await new Promise(r => setTimeout(r, 5))
    expect(linkCalls(requests)).toHaveLength(0)
  })

  it('does not link before there is a passport to link to', async () => {
    arrive('?gclid=G1')
    const { requests } = setup({ networks: [google()], passportId: null })
    await new Promise(r => setTimeout(r, 5))
    expect(linkCalls(requests)).toHaveLength(0)
  })

  it('survives the link failing — attribution is worth less than the page', async () => {
    arrive('?gclid=G1')
    const { core } = setup({ networks: [google()], failRequests: true })
    await vi.waitFor(() => expect(core.logger.warn).toHaveBeenCalled())
  })
})
