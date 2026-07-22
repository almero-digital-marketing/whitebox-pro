// Whitebox runtime config.
//
// The default export is an `async (runtime) => ({ ... })` factory. Plugins are
// imported by name and CALLED with their options right here in the `plugins`
// array — the object they return ({ name, register, migrate }) is what the
// server loads. Use `.filter(Boolean)` so a plugin can be conditionally enabled
// by a short-circuiting expression (e.g. only mount mail when its key is set).
//
// All credentials come from the environment. Start with `npm start` (it runs
// `node --env-file-if-exists=.env`), so anything in ./.env is already loaded
// into process.env by the time this file is imported. This file holds NO
// secrets — only structure and non-sensitive defaults.

import { engagement } from 'whitebox-pro-server-plugin-engagement'
import { crm } from 'whitebox-pro-server-plugin-crm'
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { conversions } from 'whitebox-pro-server-plugin-conversions'
import { shortener } from 'whitebox-pro-server-plugin-shortener'
import { voip } from 'whitebox-pro-server-plugin-voip'
import { mail } from 'whitebox-pro-server-plugin-mail'
import { sms } from 'whitebox-pro-server-plugin-sms'
import { geolocation } from 'whitebox-pro-server-plugin-geolocation'
// Built-in OAuth 2.1 authorization server — the default auth for the WhiteBox
// UI (login, invite-only registration, admin user management). Auth0 is still
// a drop-in alternative (see the mcp.auth comment below); to use it instead,
// just delete this block and swap analytics({ auth }) for auth0({ … }).
import { oauth } from 'whitebox-pro-server-plugin-oauth'
import { jwt } from 'whitebox-pro-auth-auth0'   // generic OIDC verifier, reused
const OAUTH_ISSUER = process.env.WB_OAUTH_ISSUER || 'http://localhost:3000/oauth'
const OAUTH_AUDIENCE = 'https://whitebox/api'          // any fixed string identifying your API
const OAUTH_APP_URL = process.env.WB_APP_URL || 'http://localhost:5173'   // where the UI lives — invite links point here

// Ad networks, mail providers, and SMS providers compose like plugins — one
// self-contained, independently-released package each, living in their own repos
// outside this monorepo (see ../whitebox-pro-integrations + `npm run link:integrations`).
import { meta } from 'whitebox-pro-adnetworks-meta'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok'
// import { google } from 'whitebox-pro-adnetworks-google'   // server GA4 — see note below
import { mailgun } from 'whitebox-pro-mail-mailgun'
// import { postmark } from 'whitebox-pro-mail-postmark'      // swap the mail provider below
import { twilio } from 'whitebox-pro-sms-twilio'
import { mobica } from 'whitebox-pro-sms-mobica'
import { maxmind } from 'whitebox-geolocation-maxmind'

export default async (runtime) => ({
  port: Number(process.env.WB_PORT || 3000),

  // Set this behind a reverse proxy (nginx, an ALB, Cloudflare) so req.ip /
  // req.hostname reflect the VISITOR, not the proxy — required for
  // server-plugin-geolocation's IP lookup and the shortener's public-host
  // detection. Use a hop count (1 = exactly one reverse proxy) or an explicit
  // trusted address/subnet — NEVER a bare `true` (see docs/04-configuration.md).
  // trustProxy: 1,

  logger: {
    level: process.env.WB_LOG_LEVEL || 'info',   // trace | debug | info | warn | error | fatal
    // transport: null                            // set to null to disable pretty-print in production
  },

  db: {
    host: process.env.WB_DB_HOST || 'localhost',
    port: Number(process.env.WB_DB_PORT || 5432),
    database: process.env.WB_DB_NAME || 'whitebox',
    user: process.env.WB_DB_USER || 'whitebox',
    password: process.env.WB_DB_PASSWORD || '',
  },

  redis: {
    host: process.env.WB_REDIS_HOST || 'localhost',
    port: Number(process.env.WB_REDIS_PORT || 6379),
    // password: process.env.WB_REDIS_PASSWORD,
    // db: 0,
  },

  webhooks: {
    concurrency: 5,
    retries: 3,
    timeout: 10000,
  },

  ai: {
    apiKey: process.env.WB_OPENAI_API_KEY,   // AI SDK provider key (OpenAI today)
  },

  passports: {
    lifespans: {
      fingerprint: 7,   // days
      phone: 30,
      email: 365,
    },
  },

  // Human labels for fact keys, shown wherever a fact is surfaced to a person or
  // an AI (analytics compose vocabulary, audience rule authoring) instead of the
  // raw key. Plugins register sensible defaults for the keys they own (e.g.
  // server-plugin-geolocation → geo_city: "City") — this is only for keys with
  // no such owner, above all whitebox-pro-server-plugin-crm's fact keys, which
  // come straight from YOUR external CRM's field names and can't have a
  // built-in default. An entry here always wins over a plugin's default.
  facts: {
    labels: {
      // loyalty_tier: 'Loyalty tier',
    },
  },

  // MCP endpoint + auth. `auth` is a pluggable verifier — here the same
  // built-in OAuth server the UI logs into (see the oauth() plugin entry
  // below and its README). Swap for auth0({ domain, audience, scope }) to
  // use Auth0 instead, or a bare string/{ secret } for a static Bearer token.
  // Both OAuth options also serve their own discovery metadata so a client
  // can find the authorization server with no pre-shared secrets. Omit
  // `auth` entirely for no auth (dev only).
  mcp: {
    path: '/mcp',
    auth: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'mcp:use' }),
  },

  // Each entry is a built plugin object. Options passed to the factory are the
  // plugin's config — there is no separate top-level block to keep in sync.
  plugins: [
    engagement({
      auth: { secret: process.env.WB_ENGAGEMENT_TOKEN },
      // image: { detail: 'low' }, video: { visionDetail: 'low' },
    }),

    crm({
      auth: { secret: process.env.WB_CRM_TOKEN },
    }),

    analytics({
      // The UI logs in through the built-in OAuth server (below) and calls every
      // module with that same session token, but each module requires its OWN
      // scope(s) — the user's actual granted permissions, computed server-side
      // at login (see server-plugin-oauth's README on why the token's scope is
      // never trusted from the client). `analytics:read`/`analytics:write` are
      // this plugin's own catalog entries (both granted to every new user by
      // default — see its index.js). `auth` splits independently-resolved
      // verifiers per catalog key: `{ read, write }`, each accepting a static
      // Bearer secret ({ secret: ... }), auth0({ domain, audience, scope }), or
      // a bare jwt() like below — every plugin's `auth` option works the same
      // way, see docs/04-configuration.md.
      auth: {
        read: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'analytics:read' }),
        write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'analytics:write' }),
      },
    }),

    // Receives /conversions/events from the browser, records them, and (when a
    // network's creds are present) fans out to the ad platforms, deduped by
    // event_id. With no networks configured it records into awareness only.
    conversions({
      auth: { secret: process.env.WB_CONVERSIONS_TOKEN },   // Bearer for the GET audit endpoint (optional)
      // Compose the server-side (SST) networks. No networks ⇒ records into
      // awareness only. Each is a self-contained package called with its creds.
      networks: [
        meta({ pixelId: process.env.WB_META_PIXEL_ID, accessToken: process.env.WB_META_CAPI_TOKEN }),
        tiktok({ pixelCode: process.env.WB_TIKTOK_PIXEL_CODE, accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN }),
        // GA4 is handled CLIENT-SIDE via the gtag pixel (no pixel↔MP event_id
        // dedup). Don't add google() here alongside client gtag — non-purchase
        // events would double-count. Use it only for a server-ONLY GA4 setup.
        // google({ measurementId: process.env.WB_GA4_MEASUREMENT_ID, apiSecret: process.env.WB_GA4_API_SECRET }),
      ],
    }),

    // Short links served on their own host (baseUrl's hostname gates the bare
    // /:code redirect — point a vhost at this same server). A personalized link
    // hard-binds the clicker's session to its passport; the id never hits a URL.
    shortener({
      baseUrl: process.env.WB_SHORTENER_BASEURL || 'https://go.example.com',
      auth: { secret: process.env.WB_SHORTENER_TOKEN },   // Bearer for POST /shortener/links
    }),

    voip({
      country: 'BG',
      recordsFolder: 'recordings',   // relative to the server's working dir (absolute paths also work)
      context: './context/speech.md',
      transcription: false,
      language: 'bg-BG',
      lines: [
        {
          in: ['+35924000000'],
          out: ['+359880000000'],
          tag: 'sales',
          strategy: 'hunt',
          prefix: '00',
          // message: '/path/to/hold.mp3',
        },
      ],
      // ari: { url: process.env.WB_ARI_URL, user: process.env.WB_ARI_USER, password: process.env.WB_ARI_PASSWORD },
      // webhooks: {
      //   ring: { url: 'https://example.com/hooks/voip/ring', method: 'POST' },
      //   pick: { url: 'https://example.com/hooks/voip/pick', method: 'POST' },
      //   call: { url: 'https://example.com/hooks/voip/call', method: 'POST' },
      // },
    }),

    // Mail only mounts when a Mailgun key is present — the && short-circuits to a
    // falsy value otherwise, and `.filter(Boolean)` drops it from the array.
    process.env.WB_MAILGUN_API_KEY && mail({
      company: 'team@example.com',   // forwarding destination for inbound + form submissions
      // The mail provider is composed like a plugin — Mailgun here. To use
      // Postmark instead, import { postmark } above and swap:
      //   provider: postmark({ serverToken: process.env.WB_POSTMARK_SERVER_TOKEN,
      //     from: process.env.WB_POSTMARK_FROM,
      //     webhookUser: process.env.WB_POSTMARK_WEBHOOK_USER,
      //     webhookPassword: process.env.WB_POSTMARK_WEBHOOK_PASSWORD }),
      provider: mailgun({
        apiKey: process.env.WB_MAILGUN_API_KEY,
        domain: process.env.WB_MAILGUN_DOMAIN || 'mg.example.com',
        webhookSigningKey: process.env.WB_MAILGUN_WEBHOOK_SIGNING_KEY,
        replayWindowMs: 5 * 60 * 1000,               // reject webhook signatures older than this
      }),
      auth: { secret: process.env.WB_MAIL_TOKEN },   // Bearer token for POST /mail/inbox and /mail/outbox
      outbox: {
        rate: { max: 10, duration: 60000 },          // worker rate limit (per duration)
        attempts: 5,                                 // total send attempts before terminal failure
        backoffMs: 5000,                             // initial exponential backoff
      },
    }),

    // SMS, with a provider chosen by destination: Twilio by default, Mobica for
    // Bulgarian (+359) numbers. Providers own send + webhook auth + payload
    // parsing; the plugin owns outbox/status/suppressions/awareness. Mobica is
    // a send + DLR gateway (no inbound); Twilio does send + inbound + status.
    sms({
      provider: twilio({
        accountSid: process.env.WB_TWILIO_SID,
        authToken: process.env.WB_TWILIO_TOKEN,
        from: process.env.WB_TWILIO_FROM,                                  // a Twilio number or messagingServiceSid
        statusCallback: 'https://wb.example.com/sms/webhooks/twilio/status',
      }),
      routes: {
        '+359': mobica({
          user: process.env.WB_MOBICA_USER,
          pass: process.env.WB_MOBICA_PASS,
          from: 'WhiteBox',                                                // alphanumeric sender id
          // dlrSecret: process.env.WB_MOBICA_DLR_SECRET,                  // ?secret= on the DLR URL
        }),
      },
      defaultCountry: 'BG',                                                // for normalizing national numbers
      auth: { secret: process.env.WB_SMS_TOKEN },                         // Bearer for /sms/outbox + /sms/bulk
    }),

    // Passive, no-permission-prompt IP geolocation — piggybacks on the
    // /sessions/resolve call every client SDK already makes (see
    // sessions.onResolve in core). No REST route, no auth of its own.
    process.env.WB_GEOIP_DB_PATH && geolocation({
      // watch: true polls the .mmdb file's mtime (every 5 min by default) and
      // hot-reloads it once your deploy's geoipupdate cron/sidecar replaces it
      // on disk — no restart needed. See whitebox-geolocation-maxmind's README.
      provider: maxmind({ dbPath: process.env.WB_GEOIP_DB_PATH, watch: true }),
      // recordFacts: true (default) — geo_country/geo_region/geo_city/geo_lat/
      // geo_lon become core facts, queryable via the selector for segmentation.
    }),

    // Built-in OAuth 2.1 authorization server — the UI's login, invite-only
    // registration, and per-module permission management. Mounts /authorize,
    // /token, /.well-known/jwks.json and /.well-known/oauth-authorization-server
    // at OAUTH_ISSUER's own path. Declares its own `users:manage` permission
    // (gating the Users module's invite/list/remove/permissions routes) into
    // the same catalog every other plugin contributes to — see the package's
    // README. `appUrl` is where invite emails link to. Bootstrap the first
    // user (granted every permission via the '*' sentinel) + the UI's OAuth
    // client with the package's create-admin.mjs / create-client.mjs CLI
    // scripts (see its README); remove this block entirely to fall back to
    // Auth0 or a static token.
    oauth({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, appUrl: OAUTH_APP_URL }),
  ].filter(Boolean),
})
