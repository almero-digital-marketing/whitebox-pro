// MCP — Model Context Protocol server, mounted as one HTTP endpoint on the
// whitebox Express app. Plugins register capabilities (tools, resources,
// prompts) via ctx.mcp.tool / resource / prompt during their register()
// phase, before the transport is mounted.
//
// Transport: Streamable HTTP, stateless mode (no sessionId multiplexing —
// each request stands alone). One McpServer instance for the whole process;
// every request reuses it.
//
// Auth: a bearer token/JWT gates the endpoint (mcp:use scope). That alone only
// answers "can this client use MCP at all" — WHICH capabilities it can invoke
// is enforced per-tool/resource below via an optional `scope` on tool()/
// resource(), checked against the verified JWT's `scope` claim. The SDK
// threads a bearer middleware's `req.auth` through to every handler as
// `extra.authInfo` by convention (see streamableHttp.js) — our own jwt()
// middleware already sets `req.auth = { sub, scope, claims }`, so this needs
// no extra plumbing beyond reading extra.authInfo.scope here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

// Dependencies + state captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
// init() resets the registration ledger every call: the SDK throws if a tool
// name is registered twice on one server, so a clean rebuild is what keeps
// re-init (and per-test isolation) sound.
//
// Registrations are recorded here rather than applied to one live McpServer,
// because the transport can't be shared across requests (see mount() below) —
// each request needs its own fresh McpServer with the full catalog replayed
// onto it, and replaying from a plain list is what makes that replay possible.
let logger
let enabled
let name, version
let registrations = { tools: [], resources: [], prompts: [] }
let registered = { tools: [], resources: [], prompts: [] }   // names only, for inspect()

export function init({ config = {}, logger: log } = {}) {
  logger = log
  enabled = config.enabled !== false
  name = config.name || 'whitebox'
  version = config.version || '2.0.0'
  registrations = { tools: [], resources: [], prompts: [] }
  registered = { tools: [], resources: [], prompts: [] }
}

// True when the verified token's space-separated `scope` claim includes the
// given scope. No scope required (undefined/null) always passes — that's how
// mcp:use-only tools (or a host running without per-tool scopes) keep working.
function hasScope(extra, scope) {
  if (!scope) return true
  const granted = String(extra?.authInfo?.scope || '').split(' ')
  return granted.includes(scope)
}
const insufficientScope = scope => ({
  isError: true,
  content: [{ type: 'text', text: `insufficient_scope: this requires the "${scope}" permission` }],
})

// Register a tool. `inputSchema` is a ZodRawShape (plain object of Zod
// schemas, NOT z.object(...) — the SDK wraps it). `handler(args)` returns
// an MCP CallToolResult: `{ content: [{ type: 'text', text: '...' }] }`.
// `scope`, when given, gates the tool on top of the endpoint-level mcp:use
// gate — e.g. a plugin declares 'audiences:write' on a mutating tool so a
// token with mcp:use but not audiences:write can't invoke it.
export function tool({ name, description, inputSchema, outputSchema, annotations, scope, handler }) {
  if (!enabled) return
  if (!name)    throw new Error('mcp.tool: name is required')
  if (!handler) throw new Error('mcp.tool: handler is required')

  registrations.tools.push({
    name,
    config: { description, inputSchema, outputSchema, annotations },
    handler: async (args, extra) => {
      if (!hasScope(extra, scope)) return insufficientScope(scope)
      try {
        return await handler(args, extra)
      } catch (err) {
        logger?.error?.({ err, name }, 'MCP tool failed')
        return {
          isError: true,
          content: [{ type: 'text', text: String(err?.message ?? err) }],
        }
      }
    },
  })
  registered.tools.push(name)
}

// Register a resource at a static URI. For templated URIs, pass a
// ResourceTemplate instance (imported from @modelcontextprotocol/sdk).
export function resource({ name, uri, description, mimeType, scope, handler }) {
  if (!enabled) return
  if (!name) throw new Error('mcp.resource: name is required')
  if (!uri)  throw new Error('mcp.resource: uri is required')

  registrations.resources.push({
    name,
    uri,
    config: { description, mimeType },
    handler: async (parsedUri, extra) => {
      if (!hasScope(extra, scope)) throw new Error(`insufficient_scope: this requires the "${scope}" permission`)
      try {
        return await handler(parsedUri, extra)
      } catch (err) {
        logger?.error?.({ err, name, uri }, 'MCP resource read failed')
        throw err
      }
    },
  })
  registered.resources.push(name)
}

// Register a prompt template. `argsSchema` is a ZodRawShape; `handler`
// returns `{ messages: [{ role, content }] }`.
export function prompt({ name, description, argsSchema, handler }) {
  if (!enabled) return
  if (!name)    throw new Error('mcp.prompt: name is required')
  if (!handler) throw new Error('mcp.prompt: handler is required')

  registrations.prompts.push({
    name,
    config: { description, argsSchema },
    handler: async (args, extra) => handler(args, extra),
  })
  registered.prompts.push(name)
}

// Build a fresh McpServer with the full recorded catalog replayed onto it —
// cheap (plain function calls, no I/O), and what lets every request start
// from a clean, never-before-connected server instance.
function buildServer() {
  const server = new McpServer({ name, version }, { capabilities: { logging: {} } })
  for (const r of registrations.tools) server.registerTool(r.name, r.config, r.handler)
  for (const r of registrations.resources) server.registerResource(r.name, r.uri, r.config, r.handler)
  for (const r of registrations.prompts) server.registerPrompt(r.name, r.config, r.handler)
  return server
}

// Mount the three required Express handlers (POST/GET/DELETE). Stateless
// mode: sessionIdGenerator is omitted, each request is independent — and,
// per the SDK's own stateless example, that independence has to extend to
// the McpServer + transport pair too: a Server can only ever `connect()` one
// transport in its lifetime, so reusing one shared pair across requests (the
// previous approach here) works for exactly the first request and then
// errors on every one after it. A fresh pair per request avoids that entirely
// and is naturally safe under concurrent in-flight requests too.
export async function mount(app, { path = '/mcp', auth } = {}) {
  if (!enabled) {
    logger?.info?.('MCP disabled — endpoint not mounted')
    return
  }

  // `auth` is a verifier: { middleware, authorizationServers?, resource?, scopesSupported? }.
  const gate = auth?.middleware || (typeof auth === 'function' ? auth : null)
  const middlewares = gate ? [gate] : []

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — when the verifier
  // advertises an authorization server, expose discovery so MCP clients can
  // run the login flow themselves. Public (no gate).
  if (auth?.authorizationServers?.length) {
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const origin = `${req.protocol}://${req.get('host')}`
      res.json({
        resource: auth.resource || `${origin}${path}`,
        authorization_servers: auth.authorizationServers,
        bearer_methods_supported: ['header'],
        scopes_supported: auth.scopesSupported || [],
      })
    })
    logger?.info?.('MCP OAuth discovery at /.well-known/oauth-protected-resource (AS: %s)', auth.authorizationServers.join(', '))
  }

  async function handle(req, res) {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close(); server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      logger?.error?.({ err }, 'MCP request failed')
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }

  app.post(path,   ...middlewares, handle)
  app.get(path,    ...middlewares, handle)
  app.delete(path, ...middlewares, handle)

  logger?.info?.('MCP mounted at %s (%d tools, %d resources, %d prompts)',
    path, registered.tools.length, registered.resources.length, registered.prompts.length)
}

// Snapshot of registered capability names — useful for tests + a future
// /mcp/inspect admin endpoint.
export function inspect() {
  return {
    tools:     [...registered.tools],
    resources: [...registered.resources],
    prompts:   [...registered.prompts],
    enabled,
  }
}
