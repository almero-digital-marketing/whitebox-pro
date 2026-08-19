import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import { register } from '../../src/query/index.js'

// register() wires the whole surface: REST routes + the auth seam + MCP tools.
// These tests cover that wiring (esp. the open-vs-gated auth decision); the
// engine itself is stubbed.
const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} }
const selector = { resolve: async () => ({ count: 0, passports: [] }), preview: async () => ({ filter: { survivors: 0 } }) }

const servers = []
afterEach(() => Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r)))))

// `auth: false` by default: the surface now REFUSES to boot with no auth (see
// tests/query/auth.test.js), and a test about tool registration or custom paths is not a
// test about auth. Spelling the opt-out here keeps those tests about their own subject.
async function mount(config) {
  const app = express()
  app.use(express.json())
  const tools = {}
  const withAuth = { ...config, query: { auth: false, ...(config?.query ?? {}) } }
  register(app, { selector, mcp: { tool: def => { tools[def.name] = def } }, config: withAuth, logger })
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  servers.push(server)
  return { base: `http://127.0.0.1:${server.address().port}`, tools }
}
const post = (base, path, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  })

describe('query surface registration', () => {
  it('registers the MCP tools', async () => {
    const { tools } = await mount({})
    expect(Object.keys(tools).sort()).toEqual(['whitebox.funnel', 'whitebox.preview', 'whitebox.query'])
  })

  it('mounts open ONLY when auth: false is explicit — dev mode', async () => {
    // This used to read "mounts open when no secret is configured", and asserted the
    // fail-open behaviour as correct: an absent or mistyped secret left POST /query — a
    // full selector over every customer — answering anyone. The open path still exists,
    // because local development needs it; it now has to be asked for by name.
    const { base } = await mount({ query: { auth: false } })
    expect((await post(base, '/query')).status).toBe(200)      // no token, still 200
    expect((await post(base, '/preview')).status).toBe(200)
  })

  it('refuses to boot when auth is absent, rather than mounting open', async () => {
    const app = express()
    expect(() => register(app, { selector, mcp: { tool: () => {} }, config: {}, logger }))
      .toThrow(/config\.query\.auth is required/)
  })

  it('gates the routes when a secret is configured', async () => {
    const { base } = await mount({ query: { auth: { secret: 's3cret' } } })
    expect((await post(base, '/query')).status).toBe(401)          // no token
    expect((await post(base, '/query', 'wrong')).status).toBe(401) // bad token
    expect((await post(base, '/query', 's3cret')).status).toBe(200)
  })

  it('honours custom paths', async () => {
    const { base } = await mount({ query: { path: '/q', previewPath: '/q/cost' } })
    expect((await post(base, '/q')).status).toBe(200)
    expect((await post(base, '/q/cost')).status).toBe(200)
    expect((await post(base, '/query')).status).toBe(404)   // default path no longer mounted
  })
})
