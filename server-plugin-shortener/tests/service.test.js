import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/store.js', () => ({
  init: vi.fn(),
  insertLink: vi.fn(async (r) => ({ id: 1, click_count: 0, ...r })),
  getLink: vi.fn(async () => null),
  bumpClicks: vi.fn(async () => 1),
  consumeIdentity: vi.fn(async () => 1),
  listLinks: vi.fn(async () => []),
  insertClick: vi.fn(async (r) => ({ id: 1, ...r })),
  getClick: vi.fn(async () => null),
  claimToken: vi.fn(async () => 1),
  setClickPassport: vi.fn(async () => 1),
  clickStats: vi.fn(async () => ({ total: 0, claimed: 0, last_at: null })),
  healthStats: vi.fn(async () => ({
    links: { created: 0, personalized: 0 },
    clicks: { total: 0, claimed: 0, expired_unclaimed: 0, unbound: 0 },
  })),
}))
vi.mock('../src/codes.js', () => ({
  newCode: vi.fn(() => 'CODE1234'),
  newClaimToken: vi.fn(() => 'TOKEN-XYZ'),
}))

import * as store from '../src/store.js'
import * as service from '../src/service.js'

const config = {
  baseUrl: 'https://go.clinic.com', host: 'go.clinic.com', param: 'wb',
  codeLength: 8, defaultTtlSec: 100, identityTtlSec: 100, claimTtlSec: 180,
}

function setup() {
  const passports = {
    resolve: vi.fn(async (id) => id),
    identify: vi.fn(async () => 'minted'),
    findByIdentity: vi.fn(async () => null),
    link: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
  }
  const awareness = { record: vi.fn(async () => {}) }
  const notify = vi.fn()
  service.init({ passports, awareness, logger: { warn() {}, error() {} }, config, notify })
  return { passports, awareness, notify }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.getLink.mockResolvedValue(null)
  store.getClick.mockResolvedValue(null)
  store.claimToken.mockResolvedValue(1)
  store.insertLink.mockImplementation(async (r) => ({ id: 1, click_count: 0, ...r }))
  store.insertClick.mockImplementation(async (r) => ({ id: 1, ...r }))
  store.healthStats.mockResolvedValue({
    links: { created: 0, personalized: 0 },
    clicks: { total: 0, claimed: 0, expired_unclaimed: 0, unbound: 0 },
  })
})

describe('createLink', () => {
  it('resolves the bound passport and builds the short_url', async () => {
    const { passports } = setup()
    const out = await service.createLink({ url: 'https://clinic.com/whitening', passport_id: 'P1', data: { name: 'Jane' } })
    expect(passports.resolve).toHaveBeenCalledWith('P1')
    expect(out).toMatchObject({ code: 'CODE1234', short_url: 'https://go.clinic.com/CODE1234' })
    expect(store.insertLink).toHaveBeenCalledWith(expect.objectContaining({ code: 'CODE1234', url: 'https://clinic.com/whitening', passport_id: 'P1' }))
  })

  it('rejects a non-http url (400)', async () => {
    setup()
    await expect(service.createLink({ url: 'ftp://x/y' })).rejects.toMatchObject({ status: 400 })
  })

  it('bakes UTM params into the destination query and mirrors them into data', async () => {
    setup()
    await service.createLink({
      url: 'https://clinic.com/whitening',
      utm: { source: 'email', medium: 'mail', campaign: 'spring', id: '42' },
    })
    const row = store.insertLink.mock.calls.at(-1)[0]
    const u = new URL(row.url)
    expect(u.searchParams.get('utm_source')).toBe('email')
    expect(u.searchParams.get('utm_medium')).toBe('mail')
    expect(u.searchParams.get('utm_campaign')).toBe('spring')
    expect(u.searchParams.get('utm_id')).toBe('42')
    expect(row.data).toMatchObject({ utm_source: 'email', utm_campaign: 'spring' })
  })

  it('overrides existing utm_* while preserving other query params', async () => {
    setup()
    await service.createLink({
      url: 'https://clinic.com/promo?ref=abc&utm_source=old',
      utm: { source: 'email', campaign: 'spring' },
    })
    const u = new URL(store.insertLink.mock.calls.at(-1)[0].url)
    expect(u.searchParams.get('utm_source')).toBe('email')   // overridden
    expect(u.searchParams.get('utm_campaign')).toBe('spring') // added
    expect(u.searchParams.get('ref')).toBe('abc')             // preserved
  })

  it('ignores empty/missing utm fields and leaves the url untouched when no utm', async () => {
    setup()
    await service.createLink({ url: 'https://clinic.com/x', utm: { source: '', medium: undefined } })
    expect(store.insertLink.mock.calls.at(-1)[0].url).toBe('https://clinic.com/x')
  })
})

describe('resolveRedirect', () => {
  const bindable = { code: 'c', url: 'https://clinic.com/whitening', passport_id: 'P1', identify: null, identity_consumed_at: null, identity_expires_at: null, expires_at: null, click_count: 0, max_clicks: null }

  it('mints a claim token and hands it off in the FRAGMENT for a plain destination', async () => {
    setup()
    store.getLink.mockResolvedValue(bindable)
    const r = await service.resolveRedirect('c', { ip: '1.2.3.4', user_agent: 'UA' })
    expect(store.insertClick).toHaveBeenCalledWith(expect.objectContaining({ code: 'c', claim_token: 'TOKEN-XYZ' }))
    expect(r.location).toBe('https://clinic.com/whitening#wb=TOKEN-XYZ')
  })

  it('falls back to a QUERY param when the destination already has a fragment', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, url: 'https://clinic.com/app#/whitening' })
    const r = await service.resolveRedirect('c', {})
    expect(r.location).toBe('https://clinic.com/app?wb=TOKEN-XYZ#/whitening')
  })

  it('plain-redirects a campaign link (no identity) — no token', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, passport_id: null, identify: null })
    const r = await service.resolveRedirect('c', {})
    expect(store.insertClick).not.toHaveBeenCalled()
    expect(r.location).toBe('https://clinic.com/whitening')
  })

  it('stays bindable (mints a fresh token) after the identity was already consumed once — a revisit still redirects with a claim, it just wont re-merge on claim (see claim() below)', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, identity_consumed_at: new Date() })
    const r = await service.resolveRedirect('c', {})
    expect(store.insertClick).toHaveBeenCalledWith(expect.objectContaining({ code: 'c', claim_token: 'TOKEN-XYZ' }))
    expect(r.location).toBe('https://clinic.com/whitening#wb=TOKEN-XYZ')
  })

  it('plain-redirects once identity_expires_at has passed, even if never consumed', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, identity_expires_at: new Date(Date.now() - 1000) })
    const r = await service.resolveRedirect('c', {})
    expect(store.insertClick).not.toHaveBeenCalled()
    expect(r.location).toBe('https://clinic.com/whitening')
  })

  it('404s an unknown or expired link', async () => {
    setup()
    expect(await service.resolveRedirect('nope', {})).toBeNull()
    store.getLink.mockResolvedValue({ ...bindable, expires_at: new Date(Date.now() - 1000) })
    expect(await service.resolveRedirect('c', {})).toBeNull()
  })
})

describe('claim', () => {
  const validClick = () => ({ code: 'c', claim_token: 'T', claimed_at: null, expires_at: new Date(Date.now() + 60_000) })

  it('hard-binds: merges the anonymous visitor into the linked customer', async () => {
    const { passports, awareness, notify } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.getLink.mockResolvedValue({ code: 'c', url: 'https://clinic.com/x', passport_id: 'P_known', identify: null, data: { name: 'Jane' } })
    const r = await service.claim('T', 'P_anon')
    expect(store.claimToken).toHaveBeenCalledWith('T', expect.any(Date))
    expect(passports.merge).toHaveBeenCalledWith('P_known', 'P_anon')
    expect(store.consumeIdentity).toHaveBeenCalled()
    expect(awareness.record).toHaveBeenCalled()
    expect(r).toMatchObject({ bound: true, passport_id: 'P_known', data: { name: 'Jane' } })
    expect(notify).toHaveBeenCalledWith('shortener.claimed', {
      type: 'shortener.claimed', data: { code: 'c', passport_id: 'P_known', merged: true },
    })
  })

  it('first-touch: adopts the customer with no merge', async () => {
    const { passports, notify } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.getLink.mockResolvedValue({ code: 'c', url: 'x', passport_id: 'P_known', data: {} })
    const r = await service.claim('T', null)
    expect(passports.merge).not.toHaveBeenCalled()
    expect(r.passport_id).toBe('P_known')
    expect(notify).toHaveBeenCalledWith('shortener.claimed', {
      type: 'shortener.claimed', data: { code: 'c', passport_id: 'P_known', merged: false },
    })
  })

  it('a repeat claim (identity already consumed) still binds to the target but does NOT merge — a different visitor reusing the link must not get folded into the customer a second time', async () => {
    const { passports } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.getLink.mockResolvedValue({
      code: 'c', url: 'https://clinic.com/x', passport_id: 'P_known', identify: null,
      identity_consumed_at: new Date(), data: { name: 'Jane' },
    })
    const r = await service.claim('T', 'P_stranger')
    expect(passports.merge).not.toHaveBeenCalled()
    expect(store.consumeIdentity).toHaveBeenCalled()   // still stamped, for stats/observability
    expect(r).toMatchObject({ bound: true, passport_id: 'P_known', data: { name: 'Jane' } })
  })

  it('is single-use — a lost race returns bound:false without merging', async () => {
    const { passports, notify } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.claimToken.mockResolvedValue(0)   // someone else won the ticket
    const r = await service.claim('T', 'P_anon')
    expect(r).toEqual({ bound: false })
    expect(passports.merge).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('returns bound:false for an unknown or expired token', async () => {
    setup()
    store.getClick.mockResolvedValue(null)
    expect(await service.claim('nope', null)).toEqual({ bound: false })
    store.getClick.mockResolvedValue({ ...validClick(), expires_at: new Date(Date.now() - 1000) })
    expect(await service.claim('old', null)).toEqual({ bound: false })
  })
})

describe('status', () => {
  const counts = {
    links: { created: 12, personalized: 9 },
    clicks: { total: 7, claimed: 5, expired_unclaimed: 2, unbound: 0 },
  }
  const byKey = (s) => Object.fromEntries(s.metrics.map(m => [m.key, m.value]))

  // Every counter must say what it counts (docs/10-plugin-status.md) — the guard
  // that stops the next metric shipping as a bare key.
  it('gives every metric a description that says more than the key', async () => {
    setup()
    store.healthStats.mockResolvedValue(counts)
    const s = await service.status({ since: new Date() })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) {
      // Rendered inline in a 340px pane, so length IS the constraint: one line.
      expect(m.description.length).toBeLessThanOrEqual(56)
      // ...and it must still say more than the key already does.
      expect(m.description.toLowerCase()).not.toBe(m.key.toLowerCase())
      expect(m.description.length).toBeGreaterThan(12)
    }
  })

  // `unclaimed` is the one that looks alarming and isn't — scanners and prefetchers
  // do it constantly. The prose has to say so, or an operator chases a non-problem.
  it('explains that unclaimed is not on its own a failure', async () => {
    setup()
    store.healthStats.mockResolvedValue(counts)
    const s = await service.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'unclaimed').description).toMatch(/scanners/i)
  })

  it('passes `since` straight through to the windowed query', async () => {
    setup()
    const since = new Date('2026-07-01T00:00:00Z')
    await service.status({ since })
    expect(store.healthStats).toHaveBeenCalledWith({ since })
  })

  it('reports links, clicks and claims in a fixed order', async () => {
    setup()
    store.healthStats.mockResolvedValue(counts)
    const s = await service.status({ since: new Date() })
    expect(s.label).toBe('shortener')
    expect(s.metrics.map(m => m.key)).toEqual([
      'links', 'personalized', 'clicks', 'claimed', 'unclaimed', 'unbound claims',
    ])
    expect(byKey(s)).toMatchObject({ links: 12, personalized: 9, clicks: 7, claimed: 5, unclaimed: 2 })
  })

  it('marks ONLY unbound claims as bad — an unclaimed token is a scanner, not a fault', async () => {
    setup()
    store.healthStats.mockResolvedValue({
      links: { created: 1, personalized: 1 },
      clicks: { total: 4, claimed: 1, expired_unclaimed: 3, unbound: 2 },
    })
    const s = await service.status({})
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['unbound claims'])
    expect(s.metrics.find(m => m.key === 'unbound claims').value).toBe(2)
  })

  it('says in the note that unknown-code hits are not counted — a zero would read as "no dead links"', async () => {
    setup()
    const s = await service.status({})
    expect(s.note).toMatch(/unknown or expired codes are not recorded/)
    expect(s.metrics.map(m => m.key)).not.toContain('unknown')
  })

  it('never throws when the query fails — the board stays up', async () => {
    setup()
    store.healthStats.mockRejectedValue(new Error('db down'))
    const s = await service.status({ since: new Date() })
    expect(s).toEqual({ label: 'shortener', metrics: [], note: 'link health counts are unavailable' })
  })
})
