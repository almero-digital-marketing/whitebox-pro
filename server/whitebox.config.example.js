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
// The surface plugins — what the operator console is built on. Registered last,
// in dependency order; see the block at the bottom of `plugins`.
import { audiences } from 'whitebox-pro-server-plugin-audiences'
import { campaigns } from 'whitebox-pro-server-plugin-campaigns'
import { journeys } from 'whitebox-pro-server-plugin-journeys'
import { people } from 'whitebox-pro-server-plugin-people'
// Built-in OAuth 2.1 authorization server — the default auth for the WhiteBox
// UI (login, invite-only registration, admin user management). Auth0 is still
// a drop-in alternative (see the mcp.auth comment below); to use it instead,
// just delete this block and swap analytics({ auth }) for auth0({ … }).
import { oauth } from 'whitebox-pro-server-plugin-oauth'
import { jwt } from 'whitebox-pro-auth-auth0'   // generic OIDC verifier, reused
const OAUTH_ISSUER = process.env.WB_OAUTH_ISSUER || 'http://localhost:3000/oauth'
const OAUTH_AUDIENCE = 'https://whitebox/api'          // any fixed string identifying your API
const OAUTH_APP_URL = process.env.WB_APP_URL || 'http://localhost:9269'   // where the UI lives — invite links point here

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

  // Where socket.io's engine listens. Needed ONLY when the server is mounted under
  // a path prefix by a proxy that PRESERVES that prefix when forwarding — e.g.
  // `location /whitebox/ { proxy_pass http://127.0.0.1:3000; }` (no trailing slash
  // on proxy_pass), where the server receives `/whitebox/socket.io/…` and would
  // otherwise 404 it. The SDK derives the same value from the `url` it is given, so
  // this is the only end that needs telling.
  //
  // Leave it unset for a root mount, and for the more common prefix-STRIPPING proxy
  // (`proxy_pass http://127.0.0.1:3000/` — note the trailing slash), where the
  // server never sees the prefix at all. Everything else in the server is already
  // path-agnostic; the socket is the exception because socket.io reads a url's path
  // as a namespace rather than a prefix.
  // connect: { path: '/whitebox/socket.io' },

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

    // WHICH value a key means, when a passport holds several.
    //
    // A fact is single-valued per passport, so every read picks one — `use` says which,
    // and without it `last` (the newest write) wins by default. That default is wrong for
    // any key whose meaning is definitional: a FIRST booking cannot move forward, however
    // many duplicate customer records or passport merges contribute a date.
    //
    //   last (default) | first   → by observed_at
    //   max | min                → by VALUE
    //
    // Declared here it applies everywhere — filters, fact: buckets, aggregates, window
    // anchors — so no caller repeats it. A query can still override with `use`.
    //
    // Declaring `last` is NOT a no-op: it records a decision and takes the key off
    // facts.undeclaredAmbiguous(), which is the list of keys still choosing silently.
    // Whoever WRITES a key should declare it, via ctx.facts.describe(key, { use }).
    use: {
      // first_booked_at: 'min',   // a first cannot move forward
      // last_visit_at: 'max',     // a last cannot move back
      // visits_total: 'max',      // monotonic — the largest count is the true one
      // ltv_paid: 'last',         // a refund lowers it, so the newest total is true
    },
  },

  // How long a VISIT survives without activity. A session also ends when the campaign
  // changes — UTMs that differ from the ones it carries — which is not configurable,
  // because that is what attribution means.
  //
  // Activity is a /sessions/resolve call OR an awareness record carrying the session_id.
  // The second matters on a single-page app: resolve fires once per page LOAD, so a
  // visitor can read one page for longer than the window while plainly still present.
  sessions: {
    idleMinutes: 30,
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
        concurrency: 5,                              // sends in flight; 1 caps throughput
                                                     // at 1/send_duration whatever `rate` says.
                                                     // Keep well under the DB pool (max 10).
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

    // ── The surface plugins the console is built on ───────────────────────
    //
    // ORDER MATTERS for these four, and only these four. The plugin loader
    // registers in array order and each of them reads a SERVICE off an
    // earlier one via ctx.plugins.<name>.service:
    //
    //   audiences  →  (none)
    //   campaigns  →  audiences        (resolution + consent/suppression)
    //   journeys   →  campaigns, mail, sms
    //   people     →  journeys, audiences   — both OPTIONAL
    //
    // Get it wrong and the dependent plugin either throws at register (the
    // required ones) or silently omits a section (people's two). See
    // scripts/serve-analytics.mjs for the same sequence written out by hand.

    audiences({
      auth: {
        read: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'audiences:read' }),
        write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'audiences:write' }),
      },
      // The ad networks a live audience is pushed to. Empty ⇒ segments and
      // static lists still work; there is just nowhere to fan out to.
      networks: [],
    }),

    campaigns({
      auth: {
        read: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'campaigns:read' }),
        write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'campaigns:write' }),
      },
      // The safety switch, and it defaults ON. With dryRun a send resolves the
      // audience and writes the outbox rows but never hands anything to the
      // provider — so you can rehearse the whole path before real mail leaves.
      dryRun: process.env.WB_CAMPAIGNS_DRYRUN !== 'false',
    }),

    journeys({
      auth: {
        read: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'journeys:read' }),
        write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'journeys:write' }),
      },
      // HMAC secret for the `notify` step's outbound webhooks, so a receiver
      // can verify a call really came from here.
      webhookSecret: process.env.WB_JOURNEYS_WEBHOOK_SECRET,
    }),

    people({
      // Three verifiers, not two. Erasure is deliberately its own authority: a
      // support role that fixes a wrong email is not automatically a role that
      // may delete someone forever. Omit `erase` and it falls back to `write`
      // — the stricter of the pair, never to `read`.
      auth: {
        read: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'people:read' }),
        write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'people:write' }),
        erase: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'people:erase' }),
      },
    }),
  ].filter(Boolean),
})
