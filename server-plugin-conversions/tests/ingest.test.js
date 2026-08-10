import { describe, it, expect, vi, beforeEach } from 'vitest'

// Replace the audit store with spies — no DB needed for the core logic.
vi.mock('../src/store.js', () => ({
  init: vi.fn(),
  seen: vi.fn(async () => null),
  insert: vi.fn(async (r) => ({ id: 1, ...r })),
  listForPassport: vi.fn(async () => []),
  list: vi.fn(async () => []),
}))

import * as store from '../src/store.js'
import * as ingest from '../src/ingest.js'

const PID = 'p-123'

function setup({ consent = true } = {}) {
  const awareness = { record: vi.fn(async () => {}) }
  const reporter = { report: vi.fn(async () => ({ meta: 'skipped', google: 'skipped', tiktok: 'skipped' })) }
  const consentOk = vi.fn(async () => consent)
  const notify = vi.fn()
  ingest.init({ awareness, reporter, consentOk, logger: { warn: vi.fn() }, notify })
  return { awareness, reporter, consentOk, notify }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.seen.mockResolvedValue(null)
  store.insert.mockImplementation(async (r) => ({ id: 1, ...r }))
})

describe('ingestEvent', () => {
  it('records a first-party signal and fans out a valid purchase', async () => {
    const { awareness, reporter } = setup()
    const r = await ingest.ingestEvent(PID, {
      standard: 'purchase', event_id: 'e1', ts: '2026-06-18T00:00:00Z',
      url: 'https://shop/checkout', value: 49.99, currency: 'USD', content_ids: ['sku1'], num_items: 2,
      transaction_id: 'ORD-9',
    })

    expect(r).toMatchObject({ event_id: 'e1', name: 'purchase', status: 'recorded' })

    expect(awareness.record).toHaveBeenCalledOnce()
    const rec = awareness.record.mock.calls[0][0]
    expect(rec).toMatchObject({ passport_id: PID, channel: 'web', direction: 'conversion', content_id: 'conversion:purchase:e1' })
    expect(rec.text).toContain('purchase')

    expect(reporter.report).toHaveBeenCalledOnce()
    const canonical = reporter.report.mock.calls[0][1]
    expect(canonical).toMatchObject({ standard: 'purchase', event_id: 'e1', value: 49.99, currency: 'USD', content_ids: ['sku1'], num_items: 2, transaction_id: 'ORD-9' })

    expect(store.insert).toHaveBeenCalledOnce()
    expect(store.insert.mock.calls[0][0]).toMatchObject({ passport_id: PID, event_id: 'e1', name: 'purchase', kind: 'standard' })
  })

  it('generates an event_id when the client omits it', async () => {
    setup()
    const r = await ingest.ingestEvent(PID, { standard: 'page_view' })
    expect(r.event_id).toBeTruthy()
    expect(r.status).toBe('recorded')
  })

  it('is idempotent by event_id (duplicate beacon)', async () => {
    const { awareness, reporter } = setup()
    store.seen.mockResolvedValue({ event_id: 'e1', networks: { meta: 'accepted' } })
    const r = await ingest.ingestEvent(PID, { standard: 'lead', event_id: 'e1' })
    expect(r.status).toBe('duplicate')
    expect(r.networks).toEqual({ meta: 'accepted' })
    expect(awareness.record).not.toHaveBeenCalled()
    expect(reporter.report).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('still records but skips fan-out when consent is withheld', async () => {
    const { awareness, reporter } = setup({ consent: false })
    const r = await ingest.ingestEvent(PID, { standard: 'lead', event_id: 'e2' })
    expect(awareness.record).toHaveBeenCalledOnce()
    expect(reporter.report).not.toHaveBeenCalled()
    expect(r.networks).toEqual({ skipped: 'consent' })
  })

  it('handles a custom (non-standard) event', async () => {
    const { reporter } = setup()
    await ingest.ingestEvent(PID, { event: 'wb_high_intent', event_id: 'e3', meta: { tier: 'gold' } })
    const canonical = reporter.report.mock.calls[0][1]
    expect(canonical.event).toBe('wb_high_intent')
    expect(canonical.standard).toBeUndefined()
  })

  it('throws on an event with no name', async () => {
    setup()
    await expect(ingest.ingestEvent(PID, { value: 1 })).rejects.toThrow(/standard.*or.*event/)
  })

  it('notifies conversion.<name> — a distinctly-named event, not just generic awareness.recorded', async () => {
    const { notify } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'purchase', event_id: 'e1', url: 'https://shop/checkout', value: 49.99, currency: 'USD',
    })
    expect(notify).toHaveBeenCalledWith('conversion.purchase', {
      type: 'conversion.purchase',
      data: { event_id: 'e1', passport_id: PID, kind: 'standard', value: 49.99, currency: 'USD', url: 'https://shop/checkout', networks: { meta: 'skipped', google: 'skipped', tiktok: 'skipped' } },
    })
  })

  it('does not notify on a duplicate (idempotent) event', async () => {
    const { notify } = setup()
    store.seen.mockResolvedValue({ event_id: 'e1', networks: { meta: 'accepted' } })
    await ingest.ingestEvent(PID, { standard: 'lead', event_id: 'e1' })
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('ingestBatch', () => {
  it('processes each event independently — one bad event does not sink the rest', async () => {
    const { awareness } = setup()
    const results = await ingest.ingestBatch(PID, [
      { standard: 'purchase', event_id: 'ok', value: 10, currency: 'USD' },
      { standard: 'purchase', event_id: 'bad' },              // missing value/currency
      { standard: 'view_content', event_id: 'ok2', content_ids: ['a'] },
    ])
    expect(results.map(r => r.status)).toEqual(['recorded', 'invalid', 'recorded'])
    expect(results[1].error).toMatch(/invalid payload/)
    expect(awareness.record).toHaveBeenCalledTimes(2)
  })
})

// The awareness `text` is what gets EMBEDDED, and it used to be the event name
// and nothing else — "Conversion: page view", identical on every row and every
// page. So the one question this data exists to answer ("who looked at the
// booking page?") could not be answered by recall at all, while an engagement row
// beside it embedded the sentence the person actually read.
describe('what the conversion embeds', () => {
  const textOf = (awareness) => awareness.record.mock.calls[0][0].text

  it('names the page, so two different page views do not embed the same sentence', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'page_view', event_id: 'p1',
      url: 'https://gpoint.bg/booking', title: 'Запазване на час',
    })
    expect(textOf(awareness)).toBe('Conversion: page view — Запазване на час')
  })

  // A url is not language: `/%D0%B7%D0%B0%D0%BF…` embeds as noise. The decoded
  // path is the fallback when the client sends no title.
  it('falls back to the decoded path when there is no title', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'page_view', event_id: 'p2',
      url: 'https://gpoint.bg/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81',
    })
    expect(textOf(awareness)).toBe('Conversion: page view — /запазване-час')
  })

  it('adds nothing for the homepage, which the path cannot describe', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, { standard: 'page_view', event_id: 'p3', url: 'https://gpoint.bg/' })
    expect(textOf(awareness)).toBe('Conversion: page view')
  })

  // Recall relies on the verb being present — "who purchased?" has to match.
  it('keeps the event name first, because that is what recall matches on', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'purchase', event_id: 'p4', url: 'https://gpoint.bg/checkout',
      title: 'Checkout', value: 120, currency: 'BGN',
    })
    expect(textOf(awareness)).toBe('Conversion: purchase — Checkout — 120 BGN')
  })

  it('does not repeat the page when content_name already says it', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'view_content', event_id: 'p5', url: 'https://gpoint.bg/x',
      title: 'Laser hair removal', content_name: 'Laser hair removal',
    })
    expect(textOf(awareness)).toBe('Conversion: view content — Laser hair removal')
  })

  // `title` must not reach the network payload — it is context for us, not part
  // of any network's event schema.
  it('never sends the title on to the ad networks', async () => {
    const { reporter } = setup()
    await ingest.ingestEvent(PID, {
      standard: 'page_view', event_id: 'p6', url: 'https://gpoint.bg/x', title: 'A page',
    })
    const canonical = reporter.report.mock.calls[0][1]
    expect(JSON.stringify(canonical)).not.toContain('A page')
  })
})

// Attribution lives on the SESSION. The awareness timeline reaches it by joining
// exposures to sessions, so an exposure with a null session_id can never show
// where the person came from — and every conversions row had one (182 of them on
// the dev database) because the client knew its session and never sent it.
describe('the session a conversion happened in', () => {
  it('records the session, so the row can reach that visit attribution', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, { standard: 'page_view', event_id: 's1' }, { sessionId: 42 })
    expect(awareness.record.mock.calls[0][0].session_id).toBe(42)
  })

  // An older client doesn't send one, and a conversion without a session is still
  // worth recording — it just can't be attributed.
  it('still records the conversion when no session was sent', async () => {
    const { awareness } = setup()
    await ingest.ingestEvent(PID, { standard: 'page_view', event_id: 's2' })
    expect(awareness.record).toHaveBeenCalledOnce()
    expect(awareness.record.mock.calls[0][0].session_id).toBeNull()
  })
})

// The browser stamps `ts` so a queued or beacon-on-unload send keeps its real
// time. That also means a device with a wrong clock writes a wrong row, and
// nothing downstream can tell — nine reached gpoint's exposures, one of them a
// week out, quietly inflating every bounded window and growing a tail of empty
// future buckets on a by-day chart.
describe('ingest — the event time comes from a clock we do not control', () => {
  const at = (aw) => aw.record.mock.calls[0][0].ts

  it('keeps a past timestamp — a delayed send is what the field is for', async () => {
    const { awareness } = setup()
    const earlier = new Date(Date.now() - 60 * 60 * 1000)
    await ingest.ingestEvent(PID, { standard: 'page_view', ts: earlier.toISOString() })
    expect(at(awareness).toISOString()).toBe(earlier.toISOString())
  })

  it('refuses a future timestamp and uses the arrival time', async () => {
    const { awareness } = setup()
    const before = Date.now()
    await ingest.ingestEvent(PID, { standard: 'page_view', ts: '2026-08-17T08:11:39.029Z' })
    const t = at(awareness).getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })

  it('tolerates ordinary clock drift rather than flattening it', async () => {
    // A minute ahead is a normal desktop; rewriting it would lose real ordering
    // within a session for no gain.
    const { awareness } = setup()
    const slightlyAhead = new Date(Date.now() + 60 * 1000)
    await ingest.ingestEvent(PID, { standard: 'page_view', ts: slightlyAhead.toISOString() })
    expect(at(awareness).toISOString()).toBe(slightlyAhead.toISOString())
  })

  it('falls back to now when ts is absent or unparseable', async () => {
    // An invalid Date reaching the insert is a driver error naming a column,
    // not an event — useless for finding the client that sent it.
    for (const ts of [undefined, '', 'not-a-date', 'yesterday']) {
      const { awareness } = setup()
      await ingest.ingestEvent(PID, { standard: 'page_view', ...(ts === undefined ? {} : { ts }) })
      expect(Number.isFinite(at(awareness).getTime()), String(ts)).toBe(true)
    }
  })
})
