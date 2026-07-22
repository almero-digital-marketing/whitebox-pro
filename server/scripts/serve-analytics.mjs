// Dev server for testing the UI: boots core + registers the analytics/
// audiences/campaigns plugins plus the built-in OAuth server, so the UI's
// real login/invite flow works end-to-end in dev. Reuses the real .env for
// db/redis/ai. Not for production.
//
//   node --env-file-if-exists=.env scripts/serve-analytics.mjs
//
// First run: bootstrap an admin user and the UI's OAuth client (from
// server-plugin-oauth/):
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/create-admin.mjs
//   node scripts/create-client.mjs --name="WhiteBox UI" --redirect-uri=http://localhost:5173/callback
// then put the printed client_id in ui/.env.local as VITE_OAUTH_CLIENT_ID.

import '../src/quiet-deprecations.js'
import http from 'node:http'
import { load as loadConfig } from '../src/config.js'
import logger, { init as initLogger } from '../src/logger.js'
import createApp from '../src/app.js'
import * as db from '../src/db.js'
import * as redis from '../src/redis.js'
import * as queue from '../src/queue.js'
import * as events from '../src/events.js'
import * as cache from '../src/cache.js'
import * as lock from '../src/lock.js'
import * as webhooks from '../src/webhooks.js'
import * as connect from '../src/connect.js'
import * as passports from '../src/passports.js'
import * as sessions from '../src/sessions.js'
import * as ai from '../src/ai.js'
import * as context from '../src/context.js'
import * as awareness from '../src/awareness/index.js'
import * as facts from '../src/facts/index.js'
import * as selector from '../src/selector/index.js'
import * as mcp from '../src/mcp.js'
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { audiences } from 'whitebox-pro-server-plugin-audiences'
import { campaigns } from 'whitebox-pro-server-plugin-campaigns'
import { oauth } from 'whitebox-pro-server-plugin-oauth'
import { mail } from 'whitebox-pro-server-plugin-mail'
import { sms } from 'whitebox-pro-server-plugin-sms'
import { mailgun } from 'whitebox-pro-mail-mailgun'
import { mobica } from 'whitebox-pro-sms-mobica'
import { jwt } from 'whitebox-pro-auth-auth0'

const port = Number(process.env.WB_PORT || 3000)
// The UI's dev server (vite) — invite links point here, not at this API port.
const APP_URL = process.env.WB_APP_URL || 'http://localhost:5173'
const OAUTH_ISSUER = `http://localhost:${port}/oauth`
const OAUTH_AUDIENCE = 'https://whitebox/api'
// Each module gets its own read/write scope pair now — see each plugin's
// `permissions` catalog entry below (analytics:read/write, audiences:read/write,
// campaigns:read/write, users:manage) instead of one shared 'app:use'.
const scopeAuth = (scope) => jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope })
const readWriteAuth = (module) => ({ read: scopeAuth(`${module}:read`), write: scopeAuth(`${module}:write`) })

const config = await loadConfig({ argv: process.argv, env: process.env })
initLogger({ config })
logger.info('Analytics dev server booting (analytics/audiences/campaigns/mail/sms + built-in OAuth)…')

// Real providers — same gpoint.bg Mailgun/Mobica accounts as the production
// deployment (credentials in .env, gitignored). mail.send/sms.send (and the
// campaigns `deliver` hook, if wired) will genuinely deliver through these —
// no dry-run/no-op layer here. Campaigns' own dryRun switch (below) is
// independent of this and stays on regardless.
const mailProvider = mailgun({
  apiKey: process.env.WB_MAILGUN_API_KEY,
  domain: process.env.WB_MAILGUN_DOMAIN,
  webhookSigningKey: process.env.WB_MAILGUN_WEBHOOK_SIGNING_KEY,
})
const smsProvider = mobica({
  user: process.env.WB_MOBICA_USER,
  pass: process.env.WB_MOBICA_PASS,
  from: '1220',
})

await db.init({ config }); await redis.init({ config })
queue.init({ config }); await events.init({ config })
lock.init({ redis: redis.get() }); webhooks.init({ queue, config })
await passports.init({ db: db.get(), lock, config })
await sessions.init({ db: db.get(), passports })
await ai.init({ config })
context.init({ logger })
awareness.init({ db: db.get(), queue, ai, events, webhooks, config, logger, context, passports })
await awareness.migrate()
facts.init({ db: db.get(), passports, logger, config }); await facts.migrate()
selector.init({ db: db.get(), passports, logger, awareness, ai, config })

const app = createApp({ trustProxy: config.trustProxy })
const server = http.createServer(app)
connect.init({ server, events, sessions })
sessions.register(app)
mcp.init({ config: config.mcp || {}, logger })

const ctx = {
  config, db: db.get(), redis: redis.get(), queue, events, cache, lock,
  webhooks, connect, passports, sessions, ai, awareness, facts, selector,
  context, mcp, plugins: {}, logger,
}

// Audiences plugin registers first here (no dependency on oauth) — same
// session-token auth; no ad networks in dev (segments/resolve don't need
// them). Gives the UI the /audiences/* surface (segments, rules).
const audiencesPlugin = audiences({ auth: readWriteAuth('audiences'), networks: [] })
await audiencesPlugin.migrate(db.get())
ctx.plugins.audiences = await audiencesPlugin.register(app, ctx)   // { service } — campaigns reuses it

// Campaigns plugin — reuses the audiences service for resolution + consent, so its factory can
// only be built once audiences has registered. `dryRun` is the whitebox-config safety switch
// (default ON) — here it's read from WB_CAMPAIGNS_DRYRUN so it can be toggled without code edits.
// Mail/sms are registered below with real providers (so their own MCP tools + REST genuinely
// deliver), but campaigns stays dry-run by default regardless — no `deliver` hook is wired, since
// it would never be called while dryRun is on (see service.js's runDelivery).
const campaignDryRun = process.env.WB_CAMPAIGNS_DRYRUN !== 'false'
const campaignsPlugin = campaigns({ auth: readWriteAuth('campaigns'), audiences: ctx.plugins.audiences.service, dryRun: campaignDryRun })

const analyticsPlugin = analytics({ auth: readWriteAuth('analytics') })

// A real mail plugin means oauth's invite flow will actually send via getMail() now —
// through the same gpoint.bg Mailgun account — and the invite response's inviteUrl is
// still always returned too, for the UI to copy/share manually if needed.
const oauthPlugin = oauth({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, appUrl: APP_URL })

const mailPlugin = mail({ auth: scopeAuth('mail:use'), provider: mailProvider })
const smsPlugin = sms({ auth: scopeAuth('sms:use'), provider: smsProvider })

// Aggregate every plugin's declared permission catalog BEFORE oauth
// registers (it reads ctx.permissions.catalog at register time) — mirrors
// server/src/plugins.js's load() pre-pass, since this script sequences
// migrate/register calls by hand instead of using that loader.
// 'mcp:use' is added by hand (not a real plugin.permissions entry) since MCP
// is wired directly via mcp.mount() below, not through the plugin loader —
// without a catalog entry, expandPermissions(['*'], ...) would never grant it,
// so even the bootstrap admin's token would never carry it in its scope.
// 'mail:use' / 'sms:use' are added by hand too — neither plugin declares a
// `permissions` catalog entry (they use a single resolveAuth() secret, not the
// read/write split the other three plugins support), so without these entries
// expandPermissions(['*'], ...) would never grant them.
ctx.permissions = {
  catalog: [audiencesPlugin, campaignsPlugin, analyticsPlugin, oauthPlugin]
    .filter(p => p.permissions)
    .map(p => ({ module: p.name, ...p.permissions }))
    .concat([{
      module: 'mcp',
      items: [{ key: 'mcp:use', label: 'Use MCP', description: 'Connect an MCP client (e.g. Claude) to query and act through WhiteBox' }],
      defaults: [],
    }, {
      module: 'mail',
      items: [{ key: 'mail:use', label: 'Use Mail', description: 'Send and inspect transactional email' }],
      defaults: [],
    }, {
      module: 'sms',
      items: [{ key: 'sms:use', label: 'Use SMS', description: 'Send and inspect SMS' }],
      defaults: [],
    }]),
}

await oauthPlugin.migrate(db.get())
await oauthPlugin.register(app, ctx)

await analyticsPlugin.migrate(db.get())
await analyticsPlugin.register(app, ctx)

await campaignsPlugin.migrate(db.get())
await campaignsPlugin.register(app, ctx)

await mailPlugin.migrate(db.get())
ctx.plugins.mail = await mailPlugin.register(app, ctx)   // { service: { send } } — oauth's invite flow uses it lazily

await smsPlugin.migrate(db.get())
await smsPlugin.register(app, ctx)

// MCP — mounted last so every plugin's tools are registered on the McpServer first.
// Reuses the same built-in OAuth server as the UI's own login (scopeAuth === jwt()
// against OAUTH_ISSUER/OAUTH_AUDIENCE) — a separate 'mcp:use' grant, not tied to any
// UI module's read/write scopes. Register a client for it with create-client.mjs.
await mcp.mount(app, { path: '/mcp', auth: scopeAuth('mcp:use') })

server.listen(port, () => logger.info('Analytics dev server ready on http://localhost:%d (OAuth issuer: %s)', port, OAUTH_ISSUER))

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
