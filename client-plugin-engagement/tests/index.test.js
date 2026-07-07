import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import engagementPlugin from '../src/index.js'

class FakeIO {
  static latest = null
  constructor(cb) {
    this.cb = cb
    FakeIO.latest = this
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger(el, ratio) {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
}

// All auto-trackers (text/image/video/link) disabled — this file only
// exercises the plugin's own enqueue/flush/eventsPath orchestration.
function makeCore({ passportId = null, sessionId = null, connected = false } = {}) {
  return {
    transport: {
      isConnected: () => connected,
      send: vi.fn(() => connected),
    },
    http: {
      request: vi.fn(async () => ({})),
      beacon: vi.fn(() => true),
    },
    queue: (fn) => fn(),
    emitter: { emit: vi.fn() },
    logger: { debug: vi.fn(), warn: vi.fn() },
    config: {},
    deepMerge: null,
    getPassportId: () => passportId,
    getSessionId: () => sessionId,
    attach(name, api) { this[name] = api },
  }
}

describe('engagement plugin: flush orchestration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends over transport when connected, with no HTTP fallback', async () => {
    const core = makeCore({ passportId: 'p1', connected: true })
    await engagementPlugin({ text: false, image: false, video: false, link: false }).install(core)

    core.engagement.section({ id: 's1', text: 'hello', dwell_ms: 100 })
    core.engagement.flush()

    expect(core.transport.send).toHaveBeenCalledWith('engagement.batch', {
      events: [expect.objectContaining({ id: 's1', type: 'engagement.section' })],
    })
    expect(core.http.request).not.toHaveBeenCalled()
  })

  it('falls back to HTTP with passport_id/session_id as query params when transport is disconnected', async () => {
    const core = makeCore({ passportId: 'p1', sessionId: 's42', connected: false })
    await engagementPlugin({ text: false, image: false, video: false, link: false }).install(core)

    core.engagement.section({ id: 's1', text: 'hello', dwell_ms: 100 })
    core.engagement.flush()

    expect(core.http.request).toHaveBeenCalledWith(
      '/engagement/events?passport_id=p1&session_id=s42',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('omits query params entirely when no passport/session is known yet', async () => {
    const core = makeCore({ connected: false })
    await engagementPlugin({ text: false, image: false, video: false, link: false }).install(core)

    core.engagement.section({ id: 's1', text: 'hello', dwell_ms: 100 })
    core.engagement.flush()

    expect(core.http.request).toHaveBeenCalledWith('/engagement/events', expect.anything())
  })

  it('logs a readable line for every captured event, at enqueue time (not just on flush)', async () => {
    const core = makeCore({ connected: false })
    await engagementPlugin({ text: false, image: false, video: false, link: false }).install(core)

    core.engagement.section({ id: 's1', text: 'Some long enough section text to preview', dwell_ms: 4200 })

    expect(core.logger.debug).toHaveBeenCalledWith(
      'whitebox: %s',
      expect.stringContaining('section "s1" (4200ms): Some long enough section text to preview'),
    )
  })

  it('attaches passport_id/session_id to the pagehide sendBeacon fallback too', async () => {
    const core = makeCore({ passportId: 'p1', sessionId: 's42', connected: false })
    await engagementPlugin({ text: false, image: false, video: false, link: false }).install(core)

    core.engagement.section({ id: 's1', text: 'hello', dwell_ms: 100 })
    window.dispatchEvent(new Event('pagehide'))

    expect(core.http.beacon).toHaveBeenCalledWith(
      '/engagement/events?passport_id=p1&session_id=s42',
      expect.objectContaining({ events: expect.any(Array) }),
    )
  })
})

describe('engagement plugin: progress logging', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    globalThis.IntersectionObserver = FakeIO
  })
  afterEach(() => {
    delete globalThis.IntersectionObserver
  })

  it('logs a reading-started line the moment a block starts accumulating dwell time — before it completes', async () => {
    // Elements must exist before install() so the orchestrator's synchronous
    // initial scan (inside start()) picks them up directly — adding them
    // afterwards would need a MutationObserver microtask tick to register.
    document.body.innerHTML = `<p data-wb-text="slide-1">${'A'.repeat(120)}</p>`
    const el = document.body.firstElementChild

    const core = makeCore({ connected: false })
    await engagementPlugin({
      image: false, video: false, link: false,
      text: { tickMs: 20, minRequiredMs: 5000 },   // long enough that we can inspect mid-read
    }).install(core)

    FakeIO.latest.trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 60))

    expect(core.logger.debug).toHaveBeenCalledWith(
      'whitebox: %s reading started: "%s" (%d%% of %dms required)',
      'text', 'slide-1', expect.any(Number), 5000,
    )
    // The read itself hasn't completed yet — only enqueue() logs a completed read.
    expect(core.logger.debug).not.toHaveBeenCalledWith('whitebox: %s', expect.stringContaining('text "slide-1"'))
  })
})
