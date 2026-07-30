// The server is DOWN. Every one of these is a thing a host page does, and none of
// them may take the page with it.
//
// A tracking SDK has an unusual obligation: it is loaded by pages whose actual job is
// something else, its calls are fire-and-forget (nobody awaits `pageView()`), and an
// outage on our side must not surface as an error in their product. "Degrades to a
// no-op" is the requirement, not "reports the failure".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import whitebox from '../src/index.js'

// The core retries the session resolve when the TRANSPORT reports a connection, so
// testing that path needs a socket to report one. Same fake as transport.test.js.
vi.mock('socket.io-client', () => {
  const handlers = new Map()
  const fakeSocket = {
    on: vi.fn((event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(fn)
    }),
    onAny: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    id: 'fake-sock-1',
    _trigger(event, ...args) { handlers.get(event)?.forEach(fn => fn(...args)) },
    _reset() { handlers.clear() },
  }
  return { io: vi.fn(() => fakeSocket), _fakeSocket: fakeSocket }
})
import { _fakeSocket } from 'socket.io-client'

// Every fetch rejects, the way it does when the host is unreachable — DNS failure,
// connection refused, CORS preflight failure. NOT a 500: a 500 means something
// answered, and the http layer's own error path already covers that.
function offline() {
  globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
}

// Unhandled rejections are the failure mode that matters here, and they are invisible
// to a normal assertion: the promise is created inside the SDK, rejected inside the
// SDK, and the host never touches it. In a browser it lands in the console and in
// whatever error reporter the host has wired up — so a page with a tracking call on
// every navigation reports an error on every navigation.
function watchUnhandled() {
  const seen = []
  const onNode = (err) => seen.push(err)
  process.on('unhandledRejection', onNode)
  return {
    seen,
    async settle() {
      // Two macrotask turns: one for the rejection to be queued, one for Node to
      // decide nobody handled it.
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))
      process.off('unhandledRejection', onNode)
      return seen
    },
  }
}

const quiet = { debug() {}, warn() {}, error() {}, info() {} }

describe('with the server unreachable', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    offline()
  })
  afterEach(() => { delete globalThis.fetch })

  it('constructs without throwing', () => {
    expect(() => whitebox({ url: 'http://down', transport: false, logger: quiet })).not.toThrow()
  })

  // Anything the host awaits must resolve. `wb.ready` rejecting is the worst case:
  // a host that does `await wb.ready` before rendering would never render.
  it('resolves wb.ready rather than rejecting it', async () => {
    const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
    await expect(wb.ready).resolves.toBeUndefined()
  })

  it('leaves identify() resolved, with no passport rather than a throw', async () => {
    const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
    await wb.ready
    await expect(wb.identify([{ type: 'email', name: 'email', value: 'a@b.c' }]))
      .resolves.toEqual({ passportId: null })
  })

  // The one that bites in practice. A plugin whose install() awaits the network
  // fails when the server is down; every later `wb.<plugin>.<method>()` then hits the
  // namespace proxy's "never installed" path. Those calls are fire-and-forget, so a
  // rejection there is unhandled — one per call, forever.
  it('does not raise unhandled rejections when a failed plugin is called', async () => {
    const watch = watchUnhandled()
    const wb = whitebox({
      url: 'http://down',
      transport: false,
      logger: quiet,
      plugins: [{
        name: 'conversions',
        // exactly what the real conversions/engagement/shortener plugins do
        async install(ctx) { await ctx.http.request('/conversions/config') },
      }],
    })
    await wb.ready

    // The host's own code, unawaited — a router afterEach hook, say.
    wb.conversions.pageView({ url: '/x' })
    wb.conversions.pageView({ url: '/y' })

    expect(await watch.settle()).toEqual([])
  })

  // Same call, but awaited by a host that does care. It must resolve, not reject:
  // "the analytics call did nothing" is not an error the page can act on.
  it('resolves an awaited call on a failed plugin instead of rejecting', async () => {
    const wb = whitebox({
      url: 'http://down',
      transport: false,
      logger: quiet,
      plugins: [{ name: 'conversions', async install(ctx) { await ctx.http.request('/c') } }],
    })
    await wb.ready
    await expect(wb.conversions.pageView({ url: '/x' })).resolves.toBeUndefined()
  })

  // wb.plugin(name) is the EXPLICIT lookup — a caller asking that question wants a
  // real answer, so it still rejects. The proxy is the forgiving path; this is not.
  it('still rejects an explicit wb.plugin() lookup, so a typo stays loud', async () => {
    const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
    await wb.ready
    await expect(wb.plugin('nope')).rejects.toThrow(/never installed/)
  })

  // A rejection nobody asked for, from the settle sweep: if a proxy call was made
  // BEFORE init finished and its plugin never attached, the waiter is rejected during
  // settle — with no handler anywhere.
  it('does not raise unhandled rejections from calls made before init settled', async () => {
    const watch = watchUnhandled()
    const wb = whitebox({
      url: 'http://down',
      transport: false,
      logger: quiet,
      plugins: [{ name: 'conversions', async install(ctx) { await ctx.http.request('/c') } }],
    })
    // Synchronously after construction — init() has not settled yet.
    wb.conversions.pageView({ url: '/early' })
    await wb.ready
    expect(await watch.settle()).toEqual([])
  })

  it('says so once per plugin rather than on every call', async () => {
    const warn = vi.fn()
    const wb = whitebox({
      url: 'http://down',
      transport: false,
      logger: { ...quiet, warn },
      plugins: [{ name: 'conversions', async install(ctx) { await ctx.http.request('/c') } }],
    })
    await wb.ready
    warn.mockClear()
    for (let i = 0; i < 5; i++) wb.conversions.pageView({ url: '/x' })
    await new Promise(r => setTimeout(r, 0))
    const aboutPlugin = warn.mock.calls.filter(c => String(c[0]).includes('conversions'))
    expect(aboutPlugin.length).toBe(1)
  })

  // The visitor who arrives DURING an outage. Without a retry their whole visit is
  // session-less even after the server comes back, because /sessions/resolve is
  // attempted exactly once at load — so everything they then do is recorded against
  // nothing at all.
  describe('recovering the session', () => {
    // First resolve fails, later ones succeed: the server came back.
    function backAfterFirstAttempt() {
      const state = { attempts: 0 }
      globalThis.fetch = vi.fn(async (input) => {
        if (!String(input).includes('/sessions/resolve')) throw new TypeError('Failed to fetch')
        state.attempts++
        if (state.attempts === 1) throw new TypeError('Failed to fetch')
        return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 9, passportId: 'p-9' }) }
      })
      return state
    }

    it('retries when asked directly, and adopts the ids', async () => {
      const state = backAfterFirstAttempt()
      const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
      await wb.ready
      expect(wb.sessionId).toBeFalsy()            // the outage cost us the session

      await wb.resolveSession()
      expect(state.attempts).toBe(2)
      expect(wb.sessionId).toBe(9)
      expect(wb.passportId).toBe('p-9')
    })

    it('does nothing when a session already exists', async () => {
      const state = backAfterFirstAttempt()
      const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
      await wb.ready
      await wb.resolveSession()                   // recovers, attempt 2
      await wb.resolveSession()                   // already has one — no third attempt
      expect(state.attempts).toBe(2)
    })

    it('retries again on demand with force, for a host that knows better', async () => {
      const state = backAfterFirstAttempt()
      const wb = whitebox({ url: 'http://down', transport: false, logger: quiet })
      await wb.ready
      await wb.resolveSession()
      await wb.resolveSession({ force: true })
      expect(state.attempts).toBe(3)
    })

    // The automatic path: a socket connect means the server is answering again.
    it('retries by itself when the transport reconnects', async () => {
      _fakeSocket._reset()
      const state = backAfterFirstAttempt()
      const wb = whitebox({ url: 'http://down', logger: quiet })
      await wb.ready
      expect(wb.sessionId).toBeFalsy()

      _fakeSocket._trigger('connect')
      await new Promise(r => setTimeout(r, 0))
      await new Promise(r => setTimeout(r, 0))

      expect(state.attempts).toBe(2)
      expect(wb.sessionId).toBe(9)
    })

    // Every ordinary reconnect must not mint a fresh resolve — only one that cost us
    // the session.
    it('ignores a reconnect when the session survived', async () => {
      _fakeSocket._reset()
      let attempts = 0
      globalThis.fetch = vi.fn(async (input) => {
        if (!String(input).includes('/sessions/resolve')) throw new TypeError('Failed to fetch')
        attempts++
        return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 4 }) }
      })
      const wb = whitebox({ url: 'http://up', logger: quiet })
      await wb.ready
      expect(wb.sessionId).toBe(4)

      _fakeSocket._trigger('connect')
      await new Promise(r => setTimeout(r, 0))
      expect(attempts).toBe(1)
    })
  })
})

// socket.io retries with backoff to a 30s ceiling and never gives up, so a warning
// per attempt means a warning every 30 seconds for as long as the outage lasts — in
// the host's console, about a system that is not theirs.
describe('realtime connection warnings', () => {
  it('warns once per outage, not once per retry', async () => {
    _fakeSocket._reset()
    const warn = vi.fn()
    const wb = whitebox({ url: 'http://down', logger: { ...quiet, warn } })
    await wb.ready

    for (let i = 0; i < 6; i++) _fakeSocket._trigger('connect_error', new Error('websocket error'))
    const about = () => warn.mock.calls.filter(c => /realtime connection unavailable/.test(String(c[0])))
    expect(about().length).toBe(1)
  })

  // A successful connect ends the outage, so the NEXT failure is news again. Per
  // outage, not once per page.
  it('warns again after a reconnect and a fresh failure', async () => {
    _fakeSocket._reset()
    const warn = vi.fn()
    const wb = whitebox({ url: 'http://down', logger: { ...quiet, warn } })
    await wb.ready

    _fakeSocket._trigger('connect_error', new Error('e1'))
    _fakeSocket._trigger('connect')                       // back up
    _fakeSocket._trigger('connect_error', new Error('e2')) // and down again
    const about = warn.mock.calls.filter(c => /realtime connection unavailable/.test(String(c[0])))
    expect(about.length).toBe(2)
  })
})
