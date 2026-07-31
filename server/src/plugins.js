import logger from './logger.js'
import * as eventCatalog from './event-catalog.js'

// Plugins are built in whitebox.config.js — each plugin package exports a named
// factory (`engagement`, `crm`, …) that is imported there and called with its
// options, producing a `{ name, register, migrate? }` object. By the time we get
// here, `ctx.config.plugins` is already an array of those built objects, so the
// loader just runs each one in order. (No dynamic name → package resolution —
// the config file's `import` statements are the explicit, checkable manifest.)
// Each plugin sees the shared ctx with ONE thing swapped: an awareness whose
// record() stamps `plugin: <name>`. That's how an exposure row knows which
// subsystem collected it without every call site having to remember to say so
// (they all predate the column, and a new plugin would silently omit it).
//
// A shallow copy rather than a Proxy: ctx.awareness is a module *namespace*
// object, whose exotic property invariants make it a poor proxy target. The
// copy is safe here because nothing mutates ctx during register() — the
// loader's own `ctx.plugins[name] = api` writes to the original, and
// `plugins` is shared by reference, so late lookups (journeys → campaigns)
// still see it.
const scopedCtx = (ctx, name) =>
  ctx.awareness
    ? { ...ctx, awareness: { ...ctx.awareness, record: (event) => ctx.awareness.record({ plugin: name, ...event }) } }
    : ctx

async function load(app, ctx) {
  // Pre-pass: aggregate every plugin's declared permission catalog BEFORE
  // any register() runs, so it's available to all of them regardless of
  // load order (e.g. oauth's own register() needs analytics/audiences/
  // campaigns' entries even if oauth is registered first). A plugin's
  // `permissions` is a static field on its factory's return value — no
  // register() call needed to read it.
  ctx.permissions = { catalog: ctx.config.plugins.filter(p => p?.permissions).map(p => ({ module: p.name, ...p.permissions })) }

  // Same pre-pass, same reasoning, for what each plugin's EVENTS mean — the
  // direction they flow and the channel they belong to. Read from the static
  // `events` field, so this needs no register() call and no ordering: live can
  // register before the plugins it reports on and still classify all of them.
  // See event-catalog.js for the contract and for why this is not a map inside
  // server-plugin-live.
  ctx.eventCatalog = eventCatalog.build(ctx.config.plugins, { logger })

  for (const plugin of ctx.config.plugins) {
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error(`Invalid entry in config.plugins — expected a plugin factory result { name, register }, got ${typeof plugin}. Did you forget to call the factory, e.g. engagement({ ... })?`)
    }
    const name = plugin.name || '(unnamed)'
    logger.info('Loading plugin: %s', name)

    if (plugin.migrate) {
      await plugin.migrate(ctx.db)
      logger.info('Migrations done: %s', name)
    }

    const api = await plugin.register(app, scopedCtx(ctx, name))
    if (api) ctx.plugins[name] = api
    logger.info('Plugin ready: %s', name)
  }
}

export { load }
