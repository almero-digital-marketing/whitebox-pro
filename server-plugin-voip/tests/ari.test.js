import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Mock `ws` BEFORE importing the module under test, so the real WebSocket
// connection is never attempted. Tests drive it by emitting 'message' with a
// JSON-stringified ARI event — exactly what the real Asterisk WS would send.
let wsBehavior = 'open'   // 'open' | 'error' — controls what happens on construction
const wsInstances = []
class MockWebSocket extends EventEmitter {
  constructor(url) {
    super()
    this.url = url
    this.closed = false
    wsInstances.push(this)
    queueMicrotask(() => {
      if (wsBehavior === 'error') this.emit('error', new Error('connect ECONNREFUSED'))
      else this.emit('open')
    })
  }
  close() { this.closed = true; this.emit('close') }
}
vi.mock('ws', () => ({ default: MockWebSocket }))

// Mock global fetch — used for the REST calls (answer/record/continue/
// deleteStored/snoop). Keyed by a pathname substring so individual tests can
// make one specific call fail without affecting the others.
let fetchBehavior = {}
global.fetch = vi.fn((url) => {
  const pathname = new URL(url).pathname
  const match = Object.entries(fetchBehavior).find(([k]) => pathname.includes(k))
  if (match) {
    const behavior = match[1]
    return Promise.resolve({
      ok: behavior.ok,
      status: behavior.status,
      json: async () => behavior.json ?? null,
      text: async () => behavior.text ?? '',
    })
  }
  // Real ARI's POST .../snoop returns the newly created snoop channel as a
  // JSON body (200, not 204) — onStasisStart reads its `id` to record +
  // later hang it up. Every other call this file makes is fire-and-forget,
  // so a bare 204 is the right default for anything that isn't a snoop.
  if (pathname.endsWith('/snoop')) {
    const snoopId = `snoop-${pathname.split('/').at(-2)}`
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: snoopId }), text: async () => '' })
  }
  return Promise.resolve({
    ok: true,
    status: 204,
    json: async () => null,
    text: async () => '',
  })
})

// Controls what the watchdog's GET /ari/applications/:app "sees", and what
// fetchRecording's GET .../file sees. ari.js uses Node's raw http.request
// (not fetch) for both, so mock that directly rather than a higher-level
// client. Synchronous by design (no setImmediate) so these tests can use
// fake timers for the watchdog interval without also having to fake/flush a
// simulated async I/O layer underneath it.
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

// Simulates Asterisk pushing an ARI event over the WebSocket — drives the
// most recently connected mock socket, matching how ari.js only ever has one
// live connection at a time.
function emitAriEvent(type, channel, extra = {}) {
  const socket = wsInstances[wsInstances.length - 1]
  socket.emit('message', Buffer.from(JSON.stringify({ type, channel, ...extra })))
}

function fetchCallsTo(pathSuffix) {
  return global.fetch.mock.calls.filter(([url]) => new URL(url).pathname.includes(pathSuffix))
}

describe('voip/ari', () => {
  beforeEach(() => {
    wsInstances.length = 0
    wsBehavior = 'open'
    fetchBehavior = {}
    global.fetch.mockClear()
    vi.clearAllMocks()
    // Restore default mock return values cleared by clearAllMocks.
    calls.end.mockImplementation(async () => ({ vault_id: 'v1' }))
    calls.find.mockImplementation(async () => ({ vault_id: 'v1', passport_id: 'p1' }))
    pool.find.mockImplementation(() => null)
  })

  it('connects to ARI and starts the configured Stasis app on init()', async () => {
    await ari.init(makeDeps())
    expect(wsInstances).toHaveLength(1)
    expect(wsInstances[0].url).toContain('app=whitebox')
  })

  it('throws if voip.ari config is incomplete', async () => {
    const deps = makeDeps()
    deps.config.voip.ari = { url: 'x' }                       // no user / pass
    await expect(ari.init(deps)).rejects.toThrow(/voip\.ari/)
  })

  it('rejects cleanly if the ARI WebSocket fails to connect (bad host/creds)', async () => {
    wsBehavior = 'error'
    await expect(ari.init(makeDeps())).rejects.toThrow(/ECONNREFUSED/)
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
    }
    emitAriEvent('StasisStart', channel, { args: [] })
    await new Promise(r => setImmediate(r))

    expect(calls.ring).toHaveBeenCalledWith(expect.objectContaining({
      caller: '+359888001122',
      line:   '+35921234567',
      tag:    'sofia',
    }))
    expect(deps.passports.identify).toHaveBeenCalled()
    expect(deps.passports.link).toHaveBeenCalledWith('p1', [{ type: 'phone', name: 'e164', value: '+359888001122' }])

    expect(fetchCallsTo('/channels/ch-1/answer')).toHaveLength(1)
    // Recorded via a snoop channel, not ch-1 directly — see onStasisStart's
    // comment on why (an active recording blocks Stasis' continue on a real
    // PJSIP channel). The mock derives its id as `snoop-${originalId}`.
    expect(fetchCallsTo('/channels/ch-1/snoop')).toHaveLength(1)
    const [recordUrl] = fetchCallsTo('/channels/snoop-ch-1/record')[0]
    expect(new URL(recordUrl).searchParams.get('format')).toBe('wav')
    expect(fetchCallsTo('/channels/ch-1/continue')).toHaveLength(1)
  })

  it('on StasisStart: logs answer failure distinctly and still records + continues', async () => {
    const deps = makeDeps()
    await ari.init(deps)
    fetchBehavior['/answer'] = { ok: false, status: 500, text: 'Internal Server Error' }

    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
    }
    emitAriEvent('StasisStart', channel, { args: [] })
    await new Promise(r => setImmediate(r))

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), channelId: 'ch-1' }),
      'Failed to answer channel; continuing anyway',
    )
    expect(fetchCallsTo('/channels/snoop-ch-1/record')).toHaveLength(1)
    expect(fetchCallsTo('/channels/ch-1/continue')).toHaveLength(1)
  })

  it('on StasisStart: logs record failure distinctly (with recordingName) and still continues', async () => {
    const deps = makeDeps()
    await ari.init(deps)
    fetchBehavior['/record'] = { ok: false, status: 500, text: 'Internal Server Error' }

    const channel = {
      id: 'ch-1',
      linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
    }
    emitAriEvent('StasisStart', channel, { args: [] })
    await new Promise(r => setImmediate(r))

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), channelId: 'ch-1', recordingName: expect.stringContaining('wb-') }),
      'Failed to record channel; continuing anyway',
    )
    expect(fetchCallsTo('/channels/ch-1/continue')).toHaveLength(1)
  })

  it('on ChannelStateChange to Up: marks pick + notifies', async () => {
    const deps = makeDeps()
    await ari.init(deps)

    // Set up an in-flight call by feeding a StasisStart first
    const channel = {
      id: 'ch-1', linkedid: 'L-1',
      caller: { number: '+359888001122' },
      dialplan: { exten: '+35921234567' },
    }
    emitAriEvent('StasisStart', channel, { args: [] })
    await new Promise(r => setImmediate(r))
    calls.pick.mockClear()

    // Now Up
    emitAriEvent('ChannelStateChange', { id: 'ch-1', state: 'Up', caller: { number: '+359888001122' } })
    await new Promise(r => setImmediate(r))

    expect(calls.pick).toHaveBeenCalledWith(expect.objectContaining({ vaultId: expect.any(String) }))
  })

  it('ignores ChannelStateChange for channels we don\'t know about', async () => {
    const deps = makeDeps()
    await ari.init(deps)
    emitAriEvent('ChannelStateChange', { id: 'untracked', state: 'Up' })
    await new Promise(r => setImmediate(r))
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
    }
    emitAriEvent('StasisStart', channel, { args: [] })
    await new Promise(r => setImmediate(r))

    // Destroy — fetch will fail because the mocked http response has no real
    // stream interface (.pipe isn't implemented) so the write side rejects.
    // That's fine; the handler should still call calls.end with the
    // no-record path.
    emitAriEvent('ChannelDestroyed', { id: 'ch-1' })
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
      expect(wsInstances).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)

      expect(wsInstances).toHaveLength(1)   // no reconnect triggered
      await ari.stop()
    })

    it('reconnects when the ARI app check fails (the silent-death case)', async () => {
      vi.useFakeTimers()
      const deps = makeDeps()
      deps.config.voip.ari.watchdogIntervalMs = 1000
      await ari.init(deps)
      expect(wsInstances).toHaveLength(1)

      httpBehavior = 'error'   // simulate the app having silently vanished
      await vi.advanceTimersByTimeAsync(1000)

      expect(wsInstances).toHaveLength(2)   // reconnected
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

      expect(wsInstances).toHaveLength(1)   // never re-checked, never reconnected
      await ari.stop()
    })
  })
})
