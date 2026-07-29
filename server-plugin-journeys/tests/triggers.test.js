import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as triggers from '../src/triggers.js'

function makeHarness({ activeEventNames = [], eventJourneysByName = {}, audienceJourneys = [], resolveIds = ['p-aud-1'], resolveIdsByAudience = null } = {}) {
  const store = {
    distinctActiveEventNames: vi.fn(async () => activeEventNames),
    activeEventJourneys: vi.fn(async name => eventJourneysByName[name] || []),
    activeAudienceJourneys: vi.fn(async () => audienceJourneys),
  }

  const subs = new Map()   // channel -> Set(fn)
  const events = {
    subscribe: vi.fn((ch, fn) => { if (!subs.has(ch)) subs.set(ch, new Set()); subs.get(ch).add(fn) }),
    unsubscribe: vi.fn((ch, fn) => { subs.get(ch)?.delete(fn) }),
  }

  const enrollCalls = []
  const service = { enroll: vi.fn(async (journeyId, passportId, meta) => { enrollCalls.push({ journeyId, passportId, meta }); return { id: 'enr-x' } }) }
  // resolveIdsByAudience lets multi-audience tests control what each distinct
  // audience_id resolves to; single-audience tests just use the flat resolveIds.
  const audiences = {
    resolveAudience: vi.fn(async id => {
      const ids = resolveIdsByAudience ? (resolveIdsByAudience[id] || []) : resolveIds
      return { count: ids.length, ids }
    }),
  }

  triggers.init({ store, events, service, audiences, logger: console, debounceMs: 50, sweepIntervalMs: 999_999 })

  const queueAdds = []
  const fakeQueue = {
    add: vi.fn(async (name, data, opts) => { queueAdds.push({ name, data, opts }) }),
    remove: vi.fn(async id => { queueAdds.push({ removed: id }) }),
  }
  let workerFn
  triggers.initQueue({ createQueue: () => fakeQueue, createWorker: (name, fn) => { workerFn = fn } })

  return { store, events, subs, service, audiences, enrollCalls, fakeQueue, queueAdds, getWorker: () => workerFn }
}

beforeEach(() => vi.clearAllMocks())

describe('refresh() — event trigger subscription diffing', () => {
  it('subscribes to every distinct active event name', async () => {
    const h = makeHarness({ activeEventNames: ['mail.sent', 'sms.delivered'] })
    await triggers.refresh()
    expect(h.subs.has('mail.sent')).toBe(true)
    expect(h.subs.has('sms.delivered')).toBe(true)
  })

  it('does not re-subscribe to an event name it is already subscribed to', async () => {
    const h = makeHarness({ activeEventNames: ['mail.sent'] })
    await triggers.refresh()
    await triggers.refresh()
    expect(h.events.subscribe).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes from an event name once no active journey references it anymore', async () => {
    let names = ['mail.sent']
    const h = makeHarness({ activeEventNames: [] })
    h.store.distinctActiveEventNames.mockImplementation(async () => names)
    await triggers.refresh()
    expect(h.subs.get('mail.sent').size).toBe(1)
    names = []
    await triggers.refresh()
    expect(h.subs.get('mail.sent').size).toBe(0)
    expect(h.events.unsubscribe).toHaveBeenCalled()
  })
})

describe('refresh() — audience fast-path subscription', () => {
  it('subscribes to awareness.recorded only when at least one audience journey is active', async () => {
    const h = makeHarness({ audienceJourneys: [{ id: 'j-aud' }] })
    await triggers.refresh()
    expect(h.subs.get('awareness.recorded')?.size).toBe(1)
  })

  it('does not subscribe to awareness.recorded when there are no active audience journeys', async () => {
    const h = makeHarness({ audienceJourneys: [] })
    await triggers.refresh()
    expect(h.subs.has('awareness.recorded')).toBe(false)
  })

  it('unsubscribes once the last active audience journey is deactivated', async () => {
    let auds = [{ id: 'j-aud' }]
    const h = makeHarness()
    h.store.activeAudienceJourneys.mockImplementation(async () => auds)
    await triggers.refresh()
    expect(h.subs.get('awareness.recorded').size).toBe(1)
    auds = []
    await triggers.refresh()
    expect(h.subs.get('awareness.recorded').size).toBe(0)
  })
})

describe('event trigger dispatch', () => {
  it('extracts passport_id from data.passport_id and enrolls', async () => {
    const eventJourney = { id: 'j-event', trigger: JSON.stringify({ kind: 'event', event: ['mail.sent'] }) }
    const h = makeHarness({ activeEventNames: ['mail.sent'], eventJourneysByName: { 'mail.sent': [eventJourney] } })
    await triggers.refresh()
    const handler = [...h.subs.get('mail.sent')][0]
    await handler({ type: 'mail.sent', data: { passport_id: 'p-event-1' } })
    expect(h.enrollCalls).toEqual([{ journeyId: 'j-event', passportId: 'p-event-1', meta: { source: 'event', event: 'mail.sent', data: { passport_id: 'p-event-1' } } }])
  })

  it('skips enrollment silently when the extracted passport_id is missing', async () => {
    const eventJourney = { id: 'j-event3', trigger: JSON.stringify({ kind: 'event', event: ['mail.sent'] }) }
    const h = makeHarness({ activeEventNames: ['mail.sent'], eventJourneysByName: { 'mail.sent': [eventJourney] } })
    await triggers.refresh()
    const handler = [...h.subs.get('mail.sent')][0]
    await handler({ type: 'mail.sent', data: {} })
    expect(h.enrollCalls).toHaveLength(0)
  })
})

describe('audience trigger — debounce', () => {
  it('debounces awareness.recorded into a delayed recheck job keyed by passport', async () => {
    const h = makeHarness({ audienceJourneys: [{ id: 'j-aud' }] })
    await triggers.refresh()
    const handler = [...h.subs.get('awareness.recorded')][0]
    await handler({ type: 'awareness.recorded', data: { passport_id: 'p-aud-1' } })
    const add = h.queueAdds.find(a => a.name === 'recheck')
    expect(add).toMatchObject({ data: { passport_id: 'p-aud-1' }, opts: { jobId: 'recheck.p-aud-1', delay: 50 } })
  })

  it('cancels the previous pending recheck before re-adding, every time (unconditional guarded remove)', async () => {
    // remove() is called on every invocation, not just when a job is known
    // to be pending — same idiom as mail/sms's outbox.js. A no-op remove on
    // an already-fired/nonexistent job is harmless in real BullMQ.
    const h = makeHarness({ audienceJourneys: [{ id: 'j-aud' }] })
    await triggers.refresh()
    const handler = [...h.subs.get('awareness.recorded')][0]
    await handler({ type: 'awareness.recorded', data: { passport_id: 'p-aud-1' } })
    await handler({ type: 'awareness.recorded', data: { passport_id: 'p-aud-1' } })
    expect(h.queueAdds.filter(a => a.removed === 'recheck.p-aud-1')).toHaveLength(2)
    expect(h.queueAdds.filter(a => a.name === 'recheck')).toHaveLength(2)
  })

  it('ignores an awareness event with no passport_id', async () => {
    const h = makeHarness({ audienceJourneys: [{ id: 'j-aud' }] })
    await triggers.refresh()
    const handler = [...h.subs.get('awareness.recorded')][0]
    await handler({ type: 'awareness.recorded', data: {} })
    expect(h.queueAdds).toHaveLength(0)
  })
})

describe('audience trigger — recheck + sweep worker dispatch', () => {
  it('recheck enrolls only if the passport is actually in the resolved audience', async () => {
    const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111'], op: 'any' }) }
    const h = makeHarness({ audienceJourneys: [audJourney], resolveIds: ['p-aud-1'] })
    await h.getWorker()({ name: 'recheck', data: { passport_id: 'p-aud-1' } })
    expect(h.enrollCalls).toEqual([{ journeyId: 'j-aud', passportId: 'p-aud-1', meta: { source: 'audience' } }])
  })

  it('recheck enrolls nothing when the passport is not in the resolved audience', async () => {
    const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111'], op: 'any' }) }
    const h = makeHarness({ audienceJourneys: [audJourney], resolveIds: ['someone-else'] })
    await h.getWorker()({ name: 'recheck', data: { passport_id: 'p-aud-1' } })
    expect(h.enrollCalls).toHaveLength(0)
  })

  it('sweep enrolls every resolved id, tagged source: audience-sweep', async () => {
    const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111'], op: 'any' }) }
    const h = makeHarness({ audienceJourneys: [audJourney], resolveIds: ['p1', 'p2', 'p3'] })
    await h.getWorker()({ name: 'sweep', data: {} })
    expect(h.enrollCalls).toHaveLength(3)
    expect(h.enrollCalls.every(c => c.meta.source === 'audience-sweep')).toBe(true)
  })

  describe('multi-audience op combinator', () => {
    const AUD_A = '11111111-1111-4111-8111-111111111111'
    const AUD_B = '22222222-2222-4222-8222-222222222222'

    it('op:any recheck enrolls a passport in EITHER audience', async () => {
      const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: [AUD_A, AUD_B], op: 'any' }) }
      const h = makeHarness({ audienceJourneys: [audJourney], resolveIdsByAudience: { [AUD_A]: ['p1'], [AUD_B]: ['p2'] } })
      await h.getWorker()({ name: 'recheck', data: { passport_id: 'p2' } })
      expect(h.enrollCalls).toEqual([{ journeyId: 'j-aud', passportId: 'p2', meta: { source: 'audience' } }])
    })

    it('op:all recheck enrolls only a passport in BOTH audiences', async () => {
      const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: [AUD_A, AUD_B], op: 'all' }) }
      const h = makeHarness({ audienceJourneys: [audJourney], resolveIdsByAudience: { [AUD_A]: ['p1', 'p2'], [AUD_B]: ['p2', 'p3'] } })
      await h.getWorker()({ name: 'recheck', data: { passport_id: 'p1' } })
      expect(h.enrollCalls).toHaveLength(0)
      await h.getWorker()({ name: 'recheck', data: { passport_id: 'p2' } })
      expect(h.enrollCalls).toEqual([{ journeyId: 'j-aud', passportId: 'p2', meta: { source: 'audience' } }])
    })

    it('op:any sweep enrolls the UNION of both audiences, deduped', async () => {
      const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: [AUD_A, AUD_B], op: 'any' }) }
      const h = makeHarness({ audienceJourneys: [audJourney], resolveIdsByAudience: { [AUD_A]: ['p1', 'p2'], [AUD_B]: ['p2', 'p3'] } })
      await h.getWorker()({ name: 'sweep', data: {} })
      expect(new Set(h.enrollCalls.map(c => c.passportId))).toEqual(new Set(['p1', 'p2', 'p3']))
      expect(h.enrollCalls).toHaveLength(3)
    })

    it('op:all sweep enrolls only the INTERSECTION of both audiences', async () => {
      const audJourney = { id: 'j-aud', trigger: JSON.stringify({ kind: 'audience', audience_ids: [AUD_A, AUD_B], op: 'all' }) }
      const h = makeHarness({ audienceJourneys: [audJourney], resolveIdsByAudience: { [AUD_A]: ['p1', 'p2'], [AUD_B]: ['p2', 'p3'] } })
      await h.getWorker()({ name: 'sweep', data: {} })
      expect(h.enrollCalls).toEqual([{ journeyId: 'j-aud', passportId: 'p2', meta: { source: 'audience-sweep' } }])
    })
  })
})

describe('startSweep()', () => {
  it('registers a single repeatable job keyed "audience-sweep"', async () => {
    const h = makeHarness()
    await triggers.startSweep()
    expect(h.fakeQueue.add).toHaveBeenCalledWith('sweep', {}, { repeat: { every: 999_999 }, jobId: 'audience-sweep' })
  })
})

describe('regression: jobId must never contain `:`', () => {
  // Same live-only BullMQ failure mode noted in executor.test.js — the
  // debounce recheck jobId is the one triggers.js constructs itself.
  it('the debounce recheck jobId is colon-free', async () => {
    const h = makeHarness({ audienceJourneys: [{ id: 'j-aud' }] })
    await triggers.refresh()
    const handler = [...h.subs.get('awareness.recorded')][0]
    await handler({ type: 'awareness.recorded', data: { passport_id: 'p-aud-1' } })
    const jobIds = h.queueAdds.map(a => a.opts?.jobId).filter(Boolean)
    expect(jobIds.length).toBeGreaterThan(0)
    for (const id of jobIds) expect(id).not.toContain(':')
  })
})
