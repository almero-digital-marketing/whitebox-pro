import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock ari-client BEFORE importing the module under test, so the real
// WebSocket connection is never attempted.
const mockClient = {
  handlers: {},
  on(name, fn) { this.handlers[name] = fn },
  start: vi.fn(async () => {}),
  stop:  vi.fn(async () => {}),
  recordings: {
    deleteStored: vi.fn(async () => {}),
  },
}

// Hoisted so both the vi.mock factory and test assertions share one spy —
// needed to count reconnect attempts (ari.js uses the named import).
const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }))
mockConnect.mockImplementation(async () => mockClient)
vi.mock('ari-client', () => ({
  connect: mockConnect,
  default: { connect: mockConnect },
}))

// Controls what the watchdog's GET /ari/applications/:app "sees". ari.js uses
// Node's raw http.request (not fetch), so mock that directly rather than
// stubbing a higher-level client.
// Synchronous by design (no setImmediate) so these tests can use fake timers
// for the watchdog interval without also having to fake/flush a simulated
// async I/O layer underneath it — same code paths in ariGet(), simpler test.
let httpBehavior = 'ok'   // 'ok' | 'error' | 'non200'
function makeMockRequest(callback) {
  let errorHandler = null
  const req = {
    on: vi.fn((event, handler) => {
      if (event === 'error') errorHandler = handler
      return req
    }),
    destroy: vi.fn(),
    end: vi.fn(() => {
      if (httpBehavior === 'error') return errorHandler?.(new Error('connect ECONNREFUSED'))
      const res = {
        statusCode: httpBehavior === 'non200' ? 404 : 200,
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify({ name: 'whitebox' })))
          if (event === 'end') handler()
          return res
        },
      }
      callback(res)
    }),
  }
  return req
}
vi.mock('http', () => ({
  default: { request: vi.fn((options, callback) => makeMockRequest(callback)) },
  request: vi.fn((options, callback) => makeMockRequest(callback)),
}))

// The converted sibling modules ari.js imports directly are mocked so the
// test controls their behavior (they used to be injected via the factory).
vi.mock('../src/calls.js', () => ({
  init: vi.fn(),
  ring: vi.fn(async () => {}),
  pick: vi.fn(async () => {}),
  end:  vi.fn(async () => ({ vault_id: 'v1' })),
  find: vi.fn(async () => ({ vault_id: 'v1', passport_id: 'p1' })),
}))
vi.mock('../src/phonebook.js', () => ({
  init: vi.fn(),
  guessRegionByLineIn: () => 'BG',
  toE164: (n) => n.startsWith('+') ? n : `+359${n}`,
  findLine: () => 'sofia',
  format: (n) => n,
}))
vi.mock('../src/pool.js', () => ({
  init: vi.fn(),
  find: vi.fn(() => null),
  notifyRing: vi.fn(),
}))
vi.mock('../src/encoder.js', () => ({
  init: vi.fn(),
  duration: vi.fn(async () => 30),
  encode: vi.fn(async (f) => f),
}))
vi.mock('../src/speech.js', () => ({
  init: vi.fn(async () => {}),
  transcribe: vi.fn(async () => ''),
}))

const ari = await import('../src/ari.js')
const calls = await import('../src/calls.js')
const pool = await import('../src/pool.js')

function makeDeps(overrides = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return {
    config: {
      voip: {
        ari: { url: 'http://pbx.test:8088', user: 'u', password: 'p', app: 'whitebox' },
        recordsFolder: '/tmp/wb-voip-test',
        url: 'https://example.com',
        country: 'US',
        webhooks: [],
        lines: { sofia: ['+35921234567'] },
      },
    },
    webhooks: { dispatch: vi.fn() },
    events:   { publish: vi.fn(), on: vi.fn() },
    logger,
    passports: { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) },
    sessions:  { findById: vi.fn(async () => null) },
    awareness: { record: vi.fn(async () => {}) },
    speechEnabled: false,
    ...overrides,
  }
}

describe('voip/ari', () => {
  beforeEach(() => {
    mockClient.handlers = {}
    vi.clearAllMocks()
    // Restore default mock return values cleared by clearAllMocks.
    calls.end.mockImplementation(async () => ({ vault_id: 'v1' }))
    calls.find.mockImplementation(async () => ({ vault_id: 'v1', passport_id: 'p1' }))
    pool.find.mockImplementation(() => null)
  })

  it('connects to ARI and starts the configured Stasis app on init()', async () => {
    await ari.init(makeDeps())
    expect(mockClient.start).toHaveBeenCalledWith('whitebox')
  })

  it('throws if voip.ari config is incomplete', async () => {
    const deps = makeDeps()
    deps.config.voip.ari = { url: 'x' }                       // no user / pass
    await expect(ari.init(deps)).rejects.toThrow(/voip\.ari/)
  })

  // Regression test: ari-client's swagger-client dependency has a bug where,
  // on a bad URL/auth, it correctly rejects connect()'s promise but then ALSO
  // synchronously re-throws the same error from outside the promise chain —
  // which would otherwise crash the whole process even though the caller
  // (index.js) already has a `.catch()` on ari.init(). connectAri() guards
  // against exactly this by installing a temporary 'uncaughtException'
  // listener for the duration of the connect() attempt.
  //
  // The real bug's exact throw-vs-reject tick ordering isn't reliably
  // reproducible in a test (Node calls every registered 'uncaughtException'
  // listener for a given event regardless of order, so a listener-was/wasn't
  // -called assertion can't distinguish "guard worked" from "guard did
  // nothing" the way it would in production, where the guard being the only
  // listener is what stops the crash). Instead this verifies the mechanism
  // directly: the guard listener is installed only while connect() is
  // pending, and a stray uncaughtException during that window resolves
  // ari.init()'s promise as a rejection rather than being left for whatever
  // (if anything) else is listening.
  it('installs an uncaughtException guard only while connect() is pending, and rejects through it', async () => {
    const before = process.listenerCount('uncaughtException')
    const ariClient = await import('ari-client')
    ariClient.connect.mockImplementationOnce(() => new Promise(() => {}))   // never settles on its own

    const initPromise = ari.init(makeDeps())
    await new Promise(r => setImmediate(r))   // let connectAri's executor run and install its guard
    expect(process.listenerCount('uncaughtException')).toBe(before + 1)

    process.emit('uncaughtException', new Error('Authentication required'))
    await expect(initPromise).rejects.toThrow(/Authentication required/)

    // Guard removed once settled — doesn't linger and swallow unrelated errors.
    expect(process.listenerCount('uncaughtException')).toBe(before)
  })

  it('on StasisStart: rings the call, links phone identity, answers + records the channel', async () => {
    const deps = makeDeps()
    deps.passports.identify = vi.fn(async () => 'p1')
    await ari.init(deps)

    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(async () => {}),
      record: vi.fn(async () => {}),
      continueInDialplan: vi.fn(async () => {}),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    // Give the wrapped promise a tick to flush
    await new Promise(r => setImmediate(r))

    expect(calls.ring).toHaveBeenCalledWith(expect.objectContaining({
      caller: '+359888001122',
      line:   '+35921234567',
      tag:    'sofia',
    }))
    expect(deps.passports.identify).toHaveBeenCalled()
    expect(deps.passports.link).toHaveBeenCalledWith('p1', [{ type: 'phone', name: 'e164', value: '+359888001122' }])
    expect(channel.answer).toHaveBeenCalled()
    expect(channel.record).toHaveBeenCalledWith(expect.objectContaining({ format: 'wav' }))
    expect(channel.continueInDialplan).toHaveBeenCalled()
  })

  it('on StasisStart: logs answer failure distinctly and still records + continues', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    const answerErr = new Error('Internal Server Error')
    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(async () => { throw answerErr }),
      record: vi.fn(async () => {}),
      continueInDialplan: vi.fn(async () => {}),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: answerErr, channelId: 'ch-1' }),
      'Failed to answer channel; continuing anyway',
    )
    expect(channel.record).toHaveBeenCalled()
    expect(channel.continueInDialplan).toHaveBeenCalled()
  })

  it('on StasisStart: logs record failure distinctly (with recordingName) and still continues', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    const recordErr = new Error('Internal Server Error')
    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(async () => {}),
      record: vi.fn(async () => { throw recordErr }),
      continueInDialplan: vi.fn(async () => {}),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: recordErr, channelId: 'ch-1', recordingName: expect.stringContaining('wb-') }),
      'Failed to record channel; continuing anyway',
    )
    expect(channel.continueInDialplan).toHaveBeenCalled()
  })

  it('on ChannelStateChange to Up: marks pick + notifies', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    // Set up an in-flight call by feeding a StasisStart first
    const channel = {
      id: 'ch-1', linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(), record: vi.fn(), continueInDialplan: vi.fn(),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))
    calls.pick.mockClear()

    // Now Up
    const upChannel = { id: 'ch-1', state: 'Up', caller: { number: '+359888001122' } }
    await mockClient.handlers.ChannelStateChange({ type: 'ChannelStateChange' }, upChannel)
    await new Promise(r => setImmediate(r))

    expect(calls.pick).toHaveBeenCalledWith(expect.objectContaining({ vaultId: expect.any(String) }))
  })

  it('ignores ChannelStateChange for channels we don\'t know about', async () => {
    const deps = makeDeps()
    await ari.init(deps)
    await mockClient.handlers.ChannelStateChange(
      { type: 'ChannelStateChange' },
      { id: 'untracked', state: 'Up' },
    )
    expect(calls.pick).not.toHaveBeenCalled()
  })

  it('on ChannelDestroyed: marks the call ended even when recording fetch fails', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    // Seed an in-flight call
    const channel = {
      id: 'ch-1', linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
      answer: vi.fn(), record: vi.fn(), continueInDialplan: vi.fn(),
    }
    await mockClient.handlers.StasisStart({ args: [], type: 'StasisStart' }, channel)
    await new Promise(r => setImmediate(r))

    // Destroy — fetch will fail because there's no PBX to talk to. That's
    // fine; the handler should still call calls.end with the no-record path.
    await mockClient.handlers.ChannelDestroyed(
      { type: 'ChannelDestroyed' },
      { id: 'ch-1' },
    )
    await new Promise(r => setImmediate(r))

    expect(calls.end).toHaveBeenCalled()
  })

  describe('watchdog', () => {
    afterEach(() => {
      vi.useRealTimers()
      httpBehavior = 'ok'
    })

    it('does not reconnect while the ARI app check keeps succeeding', async () => {
      vi.useFakeTimers()
      const deps = makeDeps()
      deps.config.voip.ari.watchdogIntervalMs = 1000
      await ari.init(deps)
      expect(mockConnect).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockConnect).toHaveBeenCalledTimes(1)   // no reconnect triggered
      await ari.stop()
    })

    it('reconnects when the ARI app check fails (the silent-death case)', async () => {
      vi.useFakeTimers()
      const deps = makeDeps()
      deps.config.voip.ari.watchdogIntervalMs = 1000
      await ari.init(deps)
      expect(mockConnect).toHaveBeenCalledTimes(1)

      httpBehavior = 'error'   // simulate the app having silently vanished
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockConnect).toHaveBeenCalledTimes(2)   // reconnected
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        expect.stringContaining('reconnecting'),
        'whitebox',
      )
      await ari.stop()
    })

    it('a disabled watchdog (watchdogIntervalMs: 0) never checks', async () => {
      vi.useFakeTimers()
      const deps = makeDeps()
      deps.config.voip.ari.watchdogIntervalMs = 0
      await ari.init(deps)
      httpBehavior = 'error'

      await vi.advanceTimersByTimeAsync(120_000)

      expect(mockConnect).toHaveBeenCalledTimes(1)   // never re-checked, never reconnected
      await ari.stop()
    })
  })
})
