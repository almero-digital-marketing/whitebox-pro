import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createTransport, { socketTarget } from '../src/transport.js'
import createEmitter from '../src/emitter.js'

// Mock socket.io-client at the module level so the dynamic import in transport.js
// receives our fake `io` factory.
vi.mock('socket.io-client', () => {
  const handlers = new Map()
  const fakeSocket = {
    on: vi.fn((event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(fn)
    }),
    onAny: vi.fn(fn => { fakeSocket._any = fn }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    id: 'fake-sock-1',
    _trigger(event, ...args) {
      handlers.get(event)?.forEach(fn => fn(...args))
    },
  }
  return {
    io: vi.fn(() => fakeSocket),
    _fakeSocket: fakeSocket,
  }
})

describe('transport (socket.io)', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open() loads socket.io-client and creates a socket', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => 'p-1',
      emitter,
      logger: { warn: () => {} },
    })

    const socket = await t.open()
    expect(socket).toBeDefined()

    const { io } = await import('socket.io-client')
    expect(io).toHaveBeenCalledWith('http://test', expect.objectContaining({
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))
    // Passport should be passed in the connection query
    const options = io.mock.calls[0][1]
    expect(options.query.passport).toBe('p-1')
  })

  it('emits transport:connected on socket connect', async () => {
    const emitter = createEmitter()
    const onConnected = vi.fn()
    emitter.on('transport:connected', onConnected)

    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => null,
      emitter,
      logger: { warn: () => {} },
    })

    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._trigger('connect')

    expect(onConnected).toHaveBeenCalled()
  })

  it('send() returns false when not connected', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    expect(t.send('foo', {})).toBe(false)
  })

  it('send() emits via the socket when connected', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._trigger('connect')

    const ok = t.send('engagement.batch', { events: [{ x: 1 }] })
    expect(ok).toBe(true)
    expect(_fakeSocket.emit).toHaveBeenCalledWith('engagement.batch', { events: [{ x: 1 }] })
  })

  it('onAny re-emits socket events through the emitter', async () => {
    const emitter = createEmitter()
    const onCustom = vi.fn()
    emitter.on('voip.ring', onCustom)

    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    const { _fakeSocket } = await import('socket.io-client')
    _fakeSocket._any('voip.ring', { caller: '+1234' })

    expect(onCustom).toHaveBeenCalledWith({ caller: '+1234' })
  })

  it('close() disconnects the socket', async () => {
    const emitter = createEmitter()
    const t = createTransport({
      url: 'http://test', getSessionId: () => null, getPassportId: () => null,
      emitter, logger: { warn: () => {} },
    })
    await t.open()
    t.close()
    const { _fakeSocket } = await import('socket.io-client')
    expect(_fakeSocket.disconnect).toHaveBeenCalled()
  })
})

// The handshake has to carry the CURRENT passport, not the one we had when the
// socket was constructed. `query` is captured once by socket.io; `auth` is
// re-evaluated before every connection attempt — and that difference is why a page
// whose /sessions/resolve failed used to stay anonymous for its whole life, even
// after the retry on `transport:connected` acquired a real passport.
describe('handshake identity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the passport as a re-evaluated auth callback', async () => {
    const { io } = await import('socket.io-client')
    let passport = null            // none yet — the outage case
    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => passport,
      emitter: createEmitter(),
      logger: { warn: () => {} },
    })
    await t.open()

    const { auth } = io.mock.calls[0][1]
    expect(typeof auth).toBe('function')

    // first attempt: nothing to send, which is honest
    let sent
    auth(v => { sent = v })
    expect(sent).toEqual({ passport: '' })

    // the passport arrives later (resolveSession retry) — the NEXT attempt must
    // pick it up without a page reload
    passport = 'p-late'
    auth(v => { sent = v })
    expect(sent).toEqual({ passport: 'p-late' })
  })

  it('still puts the open-time passport in query, for a server that reads only that', async () => {
    const { io } = await import('socket.io-client')
    const t = createTransport({
      url: 'http://test',
      getSessionId: () => null,
      getPassportId: () => 'p-1',
      emitter: createEmitter(),
      logger: { warn: () => {} },
    })
    await t.open()
    expect(io.mock.calls[0][1].query).toEqual({ passport: 'p-1' })
  })
})

// A url with a path prefix. socket.io reads a url's path as a NAMESPACE, not a
// prefix — so passing the configured url straight to io() puts the engine at the
// ORIGIN root, outside whatever the proxy forwards, and asks for a namespace the
// server doesn't serve. Silently: the HTTP half of the SDK is unaffected, so
// tracking keeps working and only realtime is dead.
describe('socketTarget', () => {

  it('moves a path prefix out of the origin and into the engine path', () => {
    expect(socketTarget('https://gpoint.bg/whitebox'))
      .toEqual({ origin: 'https://gpoint.bg', path: '/whitebox/socket.io' })
  })

  it('ignores a trailing slash, so both spellings of the same url agree', () => {
    expect(socketTarget('https://gpoint.bg/whitebox/'))
      .toEqual({ origin: 'https://gpoint.bg', path: '/whitebox/socket.io' })
  })

  it('keeps a multi-segment prefix whole', () => {
    expect(socketTarget('https://a.bg/deep/er'))
      .toEqual({ origin: 'https://a.bg', path: '/deep/er/socket.io' })
  })

  it('leaves a root-mounted url exactly as it was — the overwhelming case', () => {
    expect(socketTarget('https://wb.example.com'))
      .toEqual({ origin: 'https://wb.example.com', path: '/socket.io' })
    expect(socketTarget('http://localhost:3100'))
      .toEqual({ origin: 'http://localhost:3100', path: '/socket.io' })
  })

  it('treats a bare / as no prefix rather than emitting //socket.io', () => {
    expect(socketTarget('http://localhost:3100/'))
      .toEqual({ origin: 'http://localhost:3100', path: '/socket.io' })
  })

  it('passes a non-absolute url through instead of guessing', () => {
    // A relative base already resolves same-origin, which is what it did before.
    expect(socketTarget('/rel')).toEqual({ origin: '/rel', path: '/socket.io' })
    expect(socketTarget('')).toEqual({ origin: '', path: '/socket.io' })
  })
})
