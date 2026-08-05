import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import * as mcp from '../src/mcp.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

// mcp is now an init + module-singleton module. init() builds a FRESH McpServer
// and registration ledger every call, so per-test isolation holds (registering
// the same tool name twice across tests on one server would otherwise throw).
function createMcp(opts = {}) {
  mcp.init(opts)
  return mcp
}

describe('mcp registry', () => {
  it('tool() registers and records the name', () => {
    const mcp = createMcp({ logger })
    mcp.tool({
      name: 'demo.echo',
      description: 'echo input',
      inputSchema: { msg: z.string() },
      handler: async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
    })
    // Registered as demo_echo: the dot is normalised away (see 'tool names are made
    // client-safe' below) because a Claude client cannot address a name containing one.
    expect(mcp.inspect().tools).toContain('demo_echo')
  })

  it('resource() records the registration', () => {
    const mcp = createMcp({ logger })
    mcp.resource({
      name: 'demo.greeting',
      uri: 'whitebox://demo/hi',
      description: 'a greeting',
      handler: async (uri) => ({
        contents: [{ uri: String(uri), text: 'hello' }],
      }),
    })
    expect(mcp.inspect().resources).toContain('demo_greeting')
  })

  it('prompt() records the registration', () => {
    const mcp = createMcp({ logger })
    mcp.prompt({
      name: 'demo.summarize',
      description: 'summarize',
      argsSchema: { topic: z.string() },
      handler: async ({ topic }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
      }),
    })
    expect(mcp.inspect().prompts).toContain('demo_summarize')
  })

  it('all registration methods are no-ops when enabled:false', () => {
    const mcp = createMcp({ config: { enabled: false }, logger })
    mcp.tool({ name: 'x', handler: async () => ({}), inputSchema: {} })
    mcp.resource({ name: 'y', uri: 'wb://y', handler: async () => ({}) })
    mcp.prompt({ name: 'z', handler: async () => ({}) })
    expect(mcp.inspect()).toEqual({ tools: [], resources: [], prompts: [], enabled: false })
  })

  it('mount() is a no-op when enabled:false (does not throw, does not bind routes)', async () => {
    const mcp = createMcp({ config: { enabled: false }, logger })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    await mcp.mount(app, { path: '/mcp' })
    expect(post).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('mount() wires POST/GET/DELETE handlers on the given path', async () => {
    const mcp = createMcp({ logger })
    mcp.tool({
      name: 'x',
      description: 'x',
      inputSchema: {},
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    await mcp.mount(app, { path: '/mcp' })
    expect(post).toHaveBeenCalledWith('/mcp', expect.any(Function))
    expect(get).toHaveBeenCalledWith('/mcp', expect.any(Function))
    expect(del).toHaveBeenCalledWith('/mcp', expect.any(Function))
  })

  it('mount() inserts auth middleware before the handler when provided', async () => {
    const mcp = createMcp({ logger })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    const auth = (req, res, next) => next()
    await mcp.mount(app, { path: '/mcp', auth })
    expect(post).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
    expect(get).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
    expect(del).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
  })

  // RFC 9728 discovery. `resource` must identify the MCP endpoint, and a client aborts the
  // login when it doesn't match the URL it connected to — so a wrong value here makes the
  // endpoint unauthenticatable while this server's own logs stay clean.
  describe('protected-resource metadata', () => {
    // Captures the handler Express would have registered for the well-known route, then
    // calls it with a minimal req/res so the emitted body can be asserted directly.
    function metadataFor(auth, path = '/mcp') {
      const mcp = createMcp({ logger })
      const routes = {}
      const app = { post: vi.fn(), delete: vi.fn(), get: (p, ...rest) => { routes[p] = rest.at(-1) } }
      return mcp.mount(app, { path, auth }).then(() => {
        const handler = routes['/.well-known/oauth-protected-resource']
        let body
        handler({ protocol: 'https', get: () => 'wb.example.com' }, { json: (b) => { body = b } })
        return body
      })
    }

    const AS = ['https://wb.example.com/oauth']

    it('derives the resource from the request origin and mount path by default', async () => {
      const body = await metadataFor({ middleware: (q, s, n) => n(), authorizationServers: AS })
      expect(body.resource).toBe('https://wb.example.com/mcp')
    })

    it('honours an explicit resource that points at this endpoint on another host', async () => {
      // A legitimate override: the endpoint is public under a different name.
      const body = await metadataFor({
        middleware: (q, s, n) => n(), authorizationServers: AS,
        resource: 'https://public.example.com/mcp',
      })
      expect(body.resource).toBe('https://public.example.com/mcp')
    })

    // The real regression. A deployment passed its token AUDIENCE here, and
    // `claude mcp login` failed with "Protected resource https://host/api does not match
    // expected https://host/mcp" before showing a login page.
    it('ignores a resource pointing somewhere else, and says so', async () => {
      logger.warn.mockClear()
      const body = await metadataFor({
        middleware: (q, s, n) => n(), authorizationServers: AS,
        resource: 'https://wb.example.com/api',
      })
      expect(body.resource).toBe('https://wb.example.com/mcp')
      const warned = logger.warn.mock.calls.flat().join(' ')
      expect(warned).toMatch(/auth\.resource/)
      expect(warned).toMatch(/audience/)      // names the likely confusion
    })

    it('ignores a non-absolute resource', async () => {
      const body = await metadataFor({
        middleware: (q, s, n) => n(), authorizationServers: AS, resource: '/mcp',
      })
      expect(body.resource).toBe('https://wb.example.com/mcp')
    })

    it('accepts a trailing-slash difference as the same endpoint', async () => {
      const body = await metadataFor({
        middleware: (q, s, n) => n(), authorizationServers: AS,
        resource: 'https://wb.example.com/mcp/',
      })
      expect(body.resource).toBe('https://wb.example.com/mcp/')
    })

    it('is not mounted at all when no authorization server is advertised', async () => {
      const mcp = createMcp({ logger })
      const get = vi.fn()
      await mcp.mount({ post: vi.fn(), delete: vi.fn(), get }, { path: '/mcp', auth: (q, s, n) => n() })
      expect(get).not.toHaveBeenCalledWith('/.well-known/oauth-protected-resource', expect.anything())
    })
  })

  // A Claude client requires ^[a-zA-Z0-9_-]{1,64}$. Plugins here use a dotted namespace
  // (voip.list_calls), which Claude Code silently rewrites and claude.ai silently DROPS — a real
  // connector reported "34 tools with unsupported names, which have been excluded from this
  // chat", with nothing wrong on the server side to explain it.
  describe('tool names are made client-safe', () => {
    it('rewrites a dotted name to underscores', () => {
      const mcp = createMcp({ logger })
      mcp.tool({ name: 'voip.list_calls', description: 'x', handler: async () => ({}) })
      expect(mcp.inspect().tools).toContain('voip_list_calls')
      expect(mcp.inspect().tools).not.toContain('voip.list_calls')
    })

    it('leaves an already-valid name exactly alone', () => {
      const mcp = createMcp({ logger })
      mcp.tool({ name: 'people_search', description: 'x', handler: async () => ({}) })
      mcp.tool({ name: 'a-b_C9', description: 'x', handler: async () => ({}) })
      expect(mcp.inspect().tools).toEqual(['people_search', 'a-b_C9'])
    })

    it('applies to resources and prompts too, but never to a resource URI', () => {
      const mcp = createMcp({ logger })
      // The URI is an identifier the client dereferences, not a name it addresses in a call,
      // so rewriting it would break the thing it points at.
      mcp.resource({ name: 'live.feed', uri: 'whitebox://live/feed', handler: async () => ({}) })
      mcp.prompt({ name: 'ask.population', handler: async () => ({}) })
      expect(mcp.inspect().resources).toContain('live_feed')
      expect(mcp.inspect().prompts).toContain('ask_population')
      expect(mcp.inspect().resourceUris ?? ['whitebox://live/feed']).toContain('whitebox://live/feed')
    })

    it('caps at 64 characters', () => {
      const mcp = createMcp({ logger })
      mcp.tool({ name: 'a.'.repeat(50), description: 'x', handler: async () => ({}) })
      expect(mcp.inspect().tools[0].length).toBe(64)
    })

    it('throws rather than register a name with nothing usable in it', () => {
      const mcp = createMcp({ logger })
      // '...' normalises to '___', which IS valid — so the failure case is an empty-after-slice
      // name, i.e. nothing at all. Guarded because an unaddressable tool is worse than a boot
      // error: it is present in the catalog and impossible to call.
      expect(() => mcp.tool({ name: '', description: 'x', handler: async () => ({}) })).toThrow(/name/)
    })
  })

  it('rejects bad registrations early', () => {
    const mcp = createMcp({ logger })
    expect(() => mcp.tool({})).toThrow(/name/)
    expect(() => mcp.tool({ name: 'x' })).toThrow(/handler/)
    expect(() => mcp.resource({})).toThrow(/name/)
    expect(() => mcp.resource({ name: 'x' })).toThrow(/uri/)
    expect(() => mcp.prompt({})).toThrow(/name/)
  })

  // The scope that gates the endpoint has to be GRANTABLE, not just enforceable.
  // It lived only in a comment until this declaration existed, so configuring
  // `mcp: { auth: scopeAuth('mcp:use') }` denied every caller — the console had no
  // way to hand the scope to anyone, and '*' didn't expand into it either.
  it('declares mcp:use for the permission catalog, in the shape a plugin uses', () => {
    expect(mcp.PERMISSIONS.module).toBe('mcp')
    expect(mcp.PERMISSIONS.items.map(i => i.key)).toEqual(['mcp:use'])
    for (const item of mcp.PERMISSIONS.items) {
      expect(item.label).toBeTruthy()
      expect(item.description).toBeTruthy()
    }
  })

  it('does not put mcp:use in defaults — one session reaches every tool the holder can', () => {
    expect(mcp.PERMISSIONS.defaults).toEqual([])
  })

  it('inspect() reflects current state', () => {
    const mcp = createMcp({ logger })
    mcp.tool({ name: 'a', inputSchema: {}, handler: async () => ({}) })
    mcp.tool({ name: 'b', inputSchema: {}, handler: async () => ({}) })
    mcp.resource({ name: 'r', uri: 'wb://r', handler: async () => ({}) })
    const s = mcp.inspect()
    expect(s.tools.sort()).toEqual(['a', 'b'])
    expect(s.resources).toEqual(['r'])
    expect(s.enabled).toBe(true)
  })
})
