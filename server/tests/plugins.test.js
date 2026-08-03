import { describe, it, expect } from 'vitest'
import { load } from '../src/plugins.js'
import * as mcp from '../src/mcp.js'

// A minimal Express stand-in — load() only ever hands `app` to each plugin's
// register(), and these plugins ignore it.
const app = {}

const plugin = (name, extra = {}) => ({ name, register: async () => {}, ...extra })
const withPermissions = (name, keys, defaults = []) => plugin(name, {
  permissions: {
    items: keys.map(key => ({ key, label: key, description: key })),
    defaults,
  },
})

const ctxFor = (plugins) => ({ config: { plugins }, plugins: {} })

describe('permission catalog aggregation', () => {

  it('folds every plugin that declares permissions into the catalog', async () => {
    const ctx = ctxFor([
      withPermissions('people', ['people:read', 'people:write']),
      withPermissions('analytics', ['analytics:read'], ['analytics:read']),
    ])
    await load(app, ctx)

    const byModule = Object.fromEntries(ctx.permissions.catalog.map(m => [m.module, m]))
    expect(byModule.people.items.map(i => i.key)).toEqual(['people:read', 'people:write'])
    expect(byModule.analytics.defaults).toEqual(['analytics:read'])
  })

  it('skips a plugin that declares none, rather than emitting an empty group', async () => {
    const ctx = ctxFor([plugin('crm'), withPermissions('people', ['people:read'])])
    await load(app, ctx)

    expect(ctx.permissions.catalog.map(m => m.module)).not.toContain('crm')
  })

  // Core enforces scopes too, and a scope absent from this catalog can be enforced
  // but never granted: the catalog is what the console's user editor lists, and
  // what '*' expands into. Before core declared its own, gating the MCP endpoint on
  // `mcp:use` denied everybody — and looked like a broken deployment rather than an
  // ungrantable permission.
  it('includes CORE own permissions, not only the plugins\'', async () => {
    const ctx = ctxFor([withPermissions('people', ['people:read'])])
    await load(app, ctx)

    const keys = ctx.permissions.catalog.flatMap(m => m.items.map(i => i.key))
    expect(keys).toContain('mcp:use')
  })

  it('carries core\'s entry through unchanged, so mcp.js stays the single source', async () => {
    const ctx = ctxFor([])
    await load(app, ctx)

    expect(ctx.permissions.catalog).toEqual([mcp.PERMISSIONS])
  })

  it('puts core ahead of the plugins — the console renders groups in array order', async () => {
    const ctx = ctxFor([withPermissions('people', ['people:read'])])
    await load(app, ctx)

    expect(ctx.permissions.catalog.map(m => m.module)).toEqual(['mcp', 'people'])
  })

  // The universe '*' expands into, built the way server-plugin-oauth builds it
  // (routes.js: permissionsCatalog.flatMap(m => m.items.map(i => i.key))). This is
  // the path by which an admin's token comes to carry mcp:use at all.
  it('exposes core keys to the same flatten oauth uses for the \'*\' sentinel', async () => {
    const ctx = ctxFor([withPermissions('people', ['people:read'])])
    await load(app, ctx)

    const allPermissionKeys = ctx.permissions.catalog.flatMap(m => m.items.map(i => i.key))
    expect(allPermissionKeys).toEqual(['mcp:use', 'people:read'])
  })

  it('is built before any register() runs, so load order cannot matter', async () => {
    // oauth's own register() reads the catalog and may be registered first.
    let seen = null
    const oauth = plugin('oauth', {
      register: async (_app, ctx) => { seen = ctx.permissions.catalog.map(m => m.module) },
    })
    const ctx = ctxFor([oauth, withPermissions('people', ['people:read'])])
    await load(app, ctx)

    expect(seen).toEqual(['mcp', 'people'])
  })
})

describe('plugin loading', () => {

  it('rejects an unbuilt factory with a message naming the mistake', async () => {
    await expect(load(app, ctxFor([() => {}]))).rejects.toThrow(/expected a plugin factory result/)
    await expect(load(app, ctxFor([null]))).rejects.toThrow(/expected a plugin factory result/)
  })

  it('records a returned api under the plugin name, and nothing when none is returned', async () => {
    const ctx = ctxFor([
      plugin('campaigns', { register: async () => ({ send: () => 'sent' }) }),
      plugin('crm'),
    ])
    await load(app, ctx)

    expect(ctx.plugins.campaigns.send()).toBe('sent')
    expect(ctx.plugins).not.toHaveProperty('crm')
  })

  it('stamps awareness.record() with the plugin name, so a row knows what collected it', async () => {
    const recorded = []
    const ctx = {
      ...ctxFor([plugin('voip', { register: async (_a, c) => { c.awareness.record({ kind: 'call' }) } })]),
      awareness: { record: (event) => recorded.push(event) },
    }
    await load(app, ctx)

    expect(recorded).toEqual([{ plugin: 'voip', kind: 'call' }])
  })

  it('runs migrate() before register() for the same plugin', async () => {
    const order = []
    const ctx = {
      ...ctxFor([plugin('facts', {
        migrate: async () => { order.push('migrate') },
        register: async () => { order.push('register') },
      })]),
      db: {},
    }
    await load(app, ctx)

    expect(order).toEqual(['migrate', 'register'])
  })
})
