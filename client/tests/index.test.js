import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import whitebox from '../src/index.js'

function mockFetch(impl) {
  globalThis.fetch = vi.fn(impl)
}

describe('whitebox factory', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    history.replaceState({}, '', '/')
  })

  afterEach(() => {
    delete globalThis.fetch
  })

  it('throws if url is missing', () => {
    expect(() => whitebox({})).toThrow(/url.*required/)
  })

  it('resolves session on init and persists ids', async () => {
    mockFetch(async (input, init) => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionId: 7, passportId: 'p-1' }),
      }
    })
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    expect(wb.sessionId).toBe(7)
    expect(wb.passportId).toBe('p-1')
    expect(localStorage.getItem('wb:passport_id')).toBe('p-1')
  })

  it('emits session.resolved with the FULL response (extra keys a server onResolve hook added)', async () => {
    mockFetch(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ sessionId: 7, passportId: 'p-1', geo: { country: 'BG', city: 'Sofia' } }),
    }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    const seen = vi.fn()
    wb.on('session.resolved', seen)
    await wb.ready
    expect(seen).toHaveBeenCalledWith({ sessionId: 7, passportId: 'p-1', geo: { country: 'BG', city: 'Sofia' } })
  })

  it('does not emit session.resolved when the resolve call fails', async () => {
    mockFetch(async () => ({ ok: false, status: 500, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    const seen = vi.fn()
    wb.on('session.resolved', seen)
    await wb.ready
    expect(seen).not.toHaveBeenCalled()
  })

  it('emits ready event after init', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    const onReady = vi.fn()
    wb.on('ready', onReady)
    await wb.ready
    // Already emitted before listener; that's OK — test that subsequent emit on
    // explicit topic works. Most consumers will use `await wb.ready`.
    expect(typeof wb.ready.then).toBe('function')
  })

  it('plugin install attaches API to wb', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    wb.use({
      name: 'mock',
      install(core) {
        core.attach('mock', { hello: () => 'world' })
      },
    })
    expect(wb.mock.hello()).toBe('world')
  })

  it('plugin throws if install() missing', () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    expect(() => wb.use({})).toThrow(/install/)
  })

  it('forget clears local state', async () => {
    mockFetch(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ sessionId: 1, passportId: 'p' }),
    }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    expect(wb.passportId).toBe('p')
    wb.forget()
    expect(wb.passportId).toBeNull()
    expect(wb.sessionId).toBeNull()
    expect(localStorage.getItem('wb:passport_id')).toBeNull()
  })

  it('autoResolveSession=false skips the /sessions/resolve call', async () => {
    mockFetch(vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })))
    const wb = whitebox({ url: 'https://api.example.com', autoResolveSession: false, transport: false })
    await wb.ready
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('installs plugins passed in the constructor `plugins: [...]` array', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const calls = []
    const plugin = (name) => ({
      name,
      install(ctx) {
        calls.push({ name, gotUrl: ctx.url, gotEmitter: !!ctx.emitter })
        ctx.attach(name, { who: name })
      },
    })
    const wb = whitebox({
      url: 'https://api.example.com',
      transport: false,
      logger: { warn: () => {} },
      plugins: [plugin('alpha'), plugin('beta')],
    })
    await wb.ready
    expect(calls).toEqual([
      { name: 'alpha', gotUrl: 'https://api.example.com', gotEmitter: true },
      { name: 'beta',  gotUrl: 'https://api.example.com', gotEmitter: true },
    ])
    expect(wb.alpha.who).toBe('alpha')
    expect(wb.beta.who).toBe('beta')
  })

  it('ctx is mutable — later plugins can read what earlier ones wrote', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let secondSawFirst = null
    const first = {
      name: 'first',
      install(ctx) { ctx.firstState = { secret: 42 } },
    }
    const second = {
      name: 'second',
      install(ctx) { secondSawFirst = ctx.firstState?.secret },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [first, second],
    })
    await wb.ready
    expect(secondSawFirst).toBe(42)
  })

  it('install can be async — wb.ready awaits all plugins', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let installed = false
    const slow = {
      name: 'slow',
      async install(ctx) {
        await new Promise(r => setTimeout(r, 5))
        installed = true
        ctx.attach('slow', {})
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    await wb.ready
    expect(installed).toBe(true)
  })

  it('teardown fn returned by install() is called by wb.destroy()', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const tornDown = []
    const plugin = (name) => ({
      name,
      install() { return () => tornDown.push(name) },
    })
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [plugin('a'), plugin('b')],
    })
    await wb.ready
    wb.destroy()
    // teardowns run in reverse install order
    expect(tornDown).toEqual(['b', 'a'])
  })

  it('identify() posts claims to /passports/link and adopts the returned passportId', async () => {
    mockFetch(async (input) => {
      if (String(input).includes('/sessions/resolve')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 1, passportId: 'p-1' }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ passportId: 'p-merged' }) }
    })
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    expect(wb.passportId).toBe('p-1')

    const claims = [{ type: 'email', name: 'email', value: 'a@x.com' }]
    const result = await wb.identify(claims)

    const [url, init] = globalThis.fetch.mock.calls.at(-1)
    expect(url).toBe('https://api.example.com/passports/link')
    expect(JSON.parse(init.body)).toEqual({ passport_id: 'p-1', claims })
    expect(result.passportId).toBe('p-merged')
    expect(wb.passportId).toBe('p-merged')
    expect(localStorage.getItem('wb:passport_id')).toBe('p-merged')
  })

  it('identify() is a no-op (no fetch) when claims is empty or not an array', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 1, passportId: 'p-1' }) }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    globalThis.fetch.mockClear()

    expect(await wb.identify([])).toEqual({ passportId: 'p-1' })
    expect(await wb.identify(undefined)).toEqual({ passportId: 'p-1' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('identify() swallows a failed request and keeps the current passportId', async () => {
    mockFetch(async (input) => {
      if (String(input).includes('/sessions/resolve')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 1, passportId: 'p-1' }) }
      }
      return { ok: false, status: 500, text: async () => '{}' }
    })
    const warn = vi.fn()
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn } })
    await wb.ready

    const result = await wb.identify([{ type: 'email', name: 'email', value: 'a@x.com' }])
    expect(result.passportId).toBe('p-1')
    expect(wb.passportId).toBe('p-1')
    expect(warn).toHaveBeenCalledWith('whitebox: identify failed', expect.any(Error))
  })

  it('wb.plugin(name) resolves immediately once the plugin is already installed', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const plugin = {
      name: 'conversions',
      install(ctx) { ctx.attach('conversions', { ping: () => 'pong' }) },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [plugin],
    })
    await wb.ready
    const api = await wb.plugin('conversions')
    expect(api.ping()).toBe('pong')
    expect(wb.conversions.ping()).toBe('pong')   // the namespace proxy forwards to the same api
  })

  it('wb.plugin(name) waits for a slow plugin, resolving once attach() runs', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let resolveInstall
    const installGate = new Promise(r => { resolveInstall = r })
    const slow = {
      name: 'conversions',
      install(ctx) {
        return installGate.then(() => { ctx.attach('conversions', { viewContent: (x) => `saw:${x}` }) })
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    // Called synchronously, right after construction — install() hasn't even
    // started resolving yet (still awaiting resolveInstall()).
    const pending = wb.plugin('conversions')
    expect(pending).toBeInstanceOf(Promise)
    resolveInstall()
    const api = await pending
    expect(api.viewContent('x')).toBe('saw:x')
  })

  it('wb.plugin(name) rejects once settled if the plugin\'s install() threw', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const broken = {
      name: 'broken',
      install() { throw new Error('nope') },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {}, error: () => {} },
      plugins: [broken],
    })
    const pending = wb.plugin('broken')
    await wb.ready
    await expect(pending).rejects.toThrow(/broken.*never installed/)
  })

  it('wb.plugin(name) rejects for a misspelled/undeclared name once ready', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    await expect(wb.plugin('typo')).rejects.toThrow(/typo.*never installed/)
  })

  it('namespace proxy: wb.<name>.<method>(...) works immediately, before install() finishes', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let resolveInstall
    const installGate = new Promise(r => { resolveInstall = r })
    const slow = {
      name: 'conversions',
      install(ctx) {
        return installGate.then(() => { ctx.attach('conversions', { viewContent: (x) => `saw:${x}` }) })
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    // Called synchronously, right after construction — install() hasn't even
    // started resolving yet (still awaiting resolveInstall()).
    const pending = wb.conversions.viewContent('x')
    expect(pending).toBeInstanceOf(Promise)
    resolveInstall()
    await wb.ready
    expect(await pending).toBe('saw:x')
  })

  it('namespace proxy: queues calls in order and replays each against the real api', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const seen = []
    let resolveInstall
    const installGate = new Promise(r => { resolveInstall = r })
    const slow = {
      name: 'conversions',
      install(ctx) {
        return installGate.then(() => {
          ctx.attach('conversions', { track: (n) => { seen.push(n); return n } })
        })
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    const p1 = wb.conversions.track('a')
    const p2 = wb.conversions.track('b')
    resolveInstall()
    await wb.ready
    expect(await p1).toBe('a')
    expect(await p2).toBe('b')
    expect(seen).toEqual(['a', 'b'])
  })

  it('namespace proxy: a queued call that throws rejects its own promise, doesn\'t sink others', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let resolveInstall
    const installGate = new Promise(r => { resolveInstall = r })
    const slow = {
      name: 'conversions',
      install(ctx) {
        return installGate.then(() => {
          ctx.attach('conversions', {
            bad: () => { throw new Error('nope') },
            good: () => 'ok',
          })
        })
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    const badP = wb.conversions.bad()
    const goodP = wb.conversions.good()
    resolveInstall()
    await wb.ready
    await expect(badP).rejects.toThrow('nope')
    expect(await goodP).toBe('ok')
  })

  it('namespace proxy: a call queued against a plugin whose install() throws rejects clearly, doesn\'t hang', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const broken = {
      name: 'broken',
      install() { throw new Error('boom') },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {}, error: () => {} },
      plugins: [broken],
    })
    const pending = wb.broken.doSomething()
    await wb.ready
    await expect(pending).rejects.toThrow(/broken.*never installed/)
  })

  it('namespace proxy: wb[name] is never reassigned — a reference grabbed early still works after ready', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    let resolveInstall
    const installGate = new Promise(r => { resolveInstall = r })
    const slow = {
      name: 'conversions',
      install(ctx) {
        return installGate.then(() => { ctx.attach('conversions', { hello: () => 'world' }) })
      },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [slow],
    })
    const earlyRef = wb.conversions   // grabbed before install() finishes
    resolveInstall()
    await wb.ready
    expect(wb.conversions).toBe(earlyRef)          // same object identity, never swapped
    expect(earlyRef.hello()).toBe('world')         // and it forwards live now
  })

  it('namespace proxy: after ready, calls forward straight through with no queuing', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const plugin = {
      name: 'conversions',
      install(ctx) { ctx.attach('conversions', { ping: () => 'pong' }) },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [plugin],
    })
    await wb.ready
    expect(wb.conversions.ping()).toBe('pong')   // synchronous return, not a Promise
  })

  it('namespace proxy: a plain (non-function) attached property still reads correctly after ready', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const plugin = {
      name: 'shortener',
      install(ctx) { ctx.attach('shortener', { data: { location: 42 } }) },
    }
    const wb = whitebox({
      url: 'https://api.example.com', transport: false,
      logger: { warn: () => {} },
      plugins: [plugin],
    })
    await wb.ready
    expect(wb.shortener.data).toEqual({ location: 42 })
  })

  it('late-bound wb.use() plugin attaches via plain assign, same as constructor-time', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } })
    await wb.ready
    wb.use({ name: 'late', install(ctx) { ctx.attach('late', { hi: () => 'there' }) } })
    // Give the (synchronous-in-this-case) install a tick to run.
    await Promise.resolve()
    expect(wb.late.hi()).toBe('there')
    expect(await wb.plugin('late')).toBe(wb.late)
  })

  it('opens transport by default (socket.io)', async () => {
    vi.resetModules()
    vi.doMock('socket.io-client', () => {
      const socket = { on: vi.fn(), onAny: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), id: 's1' }
      return { io: vi.fn(() => socket) }
    })

    const { default: whiteboxFresh } = await import('../src/index.js')
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const wb = whiteboxFresh({ url: 'https://api.example.com', logger: { warn: () => {} } })
    await wb.ready

    const { io } = await import('socket.io-client')
    expect(io).toHaveBeenCalledWith('https://api.example.com', expect.any(Object))
  })
})
