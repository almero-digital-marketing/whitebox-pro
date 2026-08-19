# 04 · Configuration

WhiteBox is configured by one file — `whitebox.config.js` in the server's working
directory — plus environment variables for every secret.

## The config factory

The default export is an `async (runtime) => ({ … })` function. It returns the
runtime config object. Because it's a function, you can branch on the environment,
read files, or compute values:

```js
export default async (runtime) => ({
  port, logger, db, redis, webhooks, ai, passports, mcp, plugins,
})
```

`runtime` carries `{ argv, env }`. A plain object export also works (legacy), but
the factory form is preferred.

## Top-level keys

| key | required | what it is |
|---|---|---|
| `port` | yes | HTTP listen port (e.g. `Number(process.env.WB_PORT || 3000)`) |
| `db` | yes | Postgres: `{ host, port, database, user, password }` (pgvector required) |
| `redis` | yes | Redis: `{ host, port, password?, db? }` (BullMQ) |
| `ai` | for embeddings/ask | `{ apiKey }` — the OpenAI key |
| `mcp` | for MCP | `{ path, auth }` — see [MCP](06-mcp.md) |
| `plugins` | yes | array of **built** plugin objects (see below) |
| `logger` | no | `{ level, transport }` — level is `trace…fatal`; `transport: null` disables pretty-print in prod |
| `webhooks` | no | outbound webhook worker: `{ concurrency, retries, timeout }` |
| `passports` | no | `{ lifespans: { fingerprint, phone, email } }` in **days** (merge freshness) |
| `awareness` | no | embedding/redaction tuning (model, chunk size, PII redaction, `url.keep` query-string allowlist, concurrency) |
| `facts` | no | `{ labels, use }` — human names for fact keys, and what each key MEANS when a passport holds several values; see below |
| `sessions` | no | `{ idleMinutes }` — how long a visit survives without activity (default `30`); see below |
| `trustProxy` | behind a reverse proxy | Express's `trust proxy` setting — see below |
| `connect` | mounted under a path prefix a proxy preserves | `{ path }` — where socket.io's engine listens — see below |
| `console` | no | `{ enabled }` — set `false` to install `whitebox-pro-ui` but not serve it |

## The plugin pattern

`plugins` is an array of objects returned by **calling** each plugin factory with
its options — right there in the config. There is no separate config block to keep
in sync; the factory arguments *are* the plugin's config.

```js
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { mail }      from 'whitebox-pro-server-plugin-mail'
import { mailgun }   from 'whitebox-pro-mail-mailgun'

plugins: [
  analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } }),

  // Conditionally enable: the && short-circuits to false, and .filter(Boolean)
  // drops it — so mail only mounts when its key is present.
  process.env.WB_MAILGUN_API_KEY && mail({
    company: 'team@example.com',
    provider: mailgun({ apiKey: process.env.WB_MAILGUN_API_KEY, domain: '…' }),
    auth: { secret: process.env.WB_MAIL_TOKEN },
  }),
].filter(Boolean)
```

**Providers compose the same way.** A channel that talks to the outside world
(mail, sms, conversions) takes a provider (or array of networks) built by its own
factory — `mail({ provider: mailgun({…}) })`, `sms({ provider: twilio({…}) })`,
`conversions({ networks: [meta({…})] })`. See [Integrations](08-integrations.md).

Each plugin's full option set is documented in [07 · Channels](07-channels.md) and
in the plugin's own README.

## Fact labels

Anything that shows a **fact** to a person or an AI — the analytics compose agent's
vocabulary, the audience rule-authoring panel — prefers a human label over the raw
key (`geo_city` → "City"). Labels come from two places:

- **Plugin defaults.** A plugin registers a label for the keys it owns (e.g.
  `server-plugin-geolocation` → `geo_city: "City"`) via `ctx.facts.describe(key, label)`
  when it registers.
- **`facts.labels` in `whitebox.config.js`** — for anything a plugin author could
  never anticipate, above all `server-plugin-crm`'s fact keys, which come straight
  from *your* external CRM's field names:
  ```js
  facts: {
    labels: {
      loyalty_tier: 'Loyalty tier',
    },
  },
  ```

**Config always wins.** Labels are seeded from `facts.labels` before any plugin
registers, and a plugin's `describe()` call only sets a key that's still unset — so
an entry here can never be clobbered by a plugin default, but a plugin default fills
in anything you haven't named yourself. A fact with no label anywhere still works
everywhere; it just falls back to showing its raw key.

## Fact semantics — what a key MEANS

A fact is single-valued per passport, so every read that needs one value **picks** one.
`facts.use` says which:

```js
facts: {
  use: {
    // Definitional: a FIRST cannot move forward, a LAST cannot move back —
    // whatever order the syncs arrive in, or how many customer records merge.
    first_booked_at: 'min',
    last_visit_at:   'max',
    // Monotonic: visits only accumulate, so the largest count is the true one.
    visits_total:    'max',
    // Current state. Declaring `last` is NOT a no-op — it records a decision and
    // takes the key off the undeclared-ambiguity report.
    ltv_paid:        'last',
  },
},
```

| rule | picks |
|---|---|
| `last` (default) | the newest `observed_at` |
| `first` | the oldest `observed_at` |
| `max` / `min` | the largest / smallest VALUE |

Precedence is **query `use` > this declaration > `last`**. Once declared, every filter,
`fact:` bucket, aggregate and window anchor honours it, so no caller has to repeat it.

**Why it is not academic.** Duplicate source records and passport merges make one passport
hold several legitimate values. On GPoint, 3,357 passports hold more than one
`first_booked_at` — 98% of them because one person exists as several CRM customer records,
each correctly reporting its own first booking. Under the `last` default, "clients acquired
since 1 January" over-reported by 586 people, because a first booking cannot move forward.

`facts.undeclaredAmbiguous()` lists the keys where the choice is still being made silently;
a query resting on an undeclared ambiguous key gets a `warnings` entry, and a **window
anchor** gets one whether or not the key is declared — a declaration says which value a key
means, not where each person's boundary falls.

The **writer** owns this, not the caller: a plugin declares it with
`ctx.facts.describe(key, { label, use })`, and config overrides. See
[query-language.md](../server/docs/query-language.md) for the query-side `use`.

## Sessions

```js
sessions: {
  idleMinutes: 30,       // default
},
```

How long a visit survives with no activity. A session also ends when a **campaign
changes** — UTMs that differ from the ones it carries — because a returning visitor
clicking a fresh ad is on a new visit, and that is not configurable: it is what
attribution means.

Activity means either a `/sessions/resolve` call or an awareness record carrying that
`session_id`. The second matters on a single-page app, where resolve fires once per page
LOAD and a visitor can read one page for longer than the window.

Raise it if your visits are genuinely long (a booking flow with a slow third-party step);
lower it if you want tighter visit counts. It cannot be zero or negative — that is refused
at boot rather than at request time.

> Before 2026-08-19 there was no window at all: nothing ever ended a session, so each
> passport had exactly one for life and a returning visitor's campaign was never recorded.
> See [Concepts → Sessions](02-concepts.md#sessions).

## Trust proxy

**You usually don't need to set this.** Core defaults `trust proxy` to
`loopback, linklocal, uniquelocal`, which believes `X-Forwarded-For` only when the
immediate peer is loopback, link-local or a private range — something that cannot be
a client from the internet. So a proxy on the same host or the same private network
is trusted automatically, and a server exposed directly to the internet ignores the
header entirely. Set `trustProxy` explicitly only when your proxy reaches WhiteBox
from a **public** address (a CDN or load balancer outside your network), or to
narrow the default.

That default exists because getting it wrong is silent. Behind a reverse proxy
(nginx, Caddy, an ALB, Cloudflare — virtually any real deployment), Express's
`req.ip` and `req.hostname` reflect the **proxy**, not the visitor. Two features
depend on it:

- **`server-plugin-geolocation`** reads `req.ip` to look up the visitor's
  location — without `trustProxy`, every visitor resolves to your proxy's own
  IP (or `null`, if that's a private address).
- **`server-plugin-shortener`** reads `req.hostname` to detect the public host
  for the bare `/:code` redirect.

Override it in `whitebox.config.js` when the default doesn't fit:

```js
export default async (runtime) => ({
  trustProxy: 1,                      // a proxy reaching us from a PUBLIC address
  // trustProxy: '10.0.0.0/8',        // narrower than the default
  // trustProxy: false,               // no proxy at all; ignore the header
  // …
})
```

**Use a hop count or an explicit trusted address/subnet list — never a bare
`true`.** Note a hop count trusts the immediate peer *whatever it is*, which is
precisely why it isn't the default: `true` makes Express trust whatever `X-Forwarded-For` value arrives
with no verification; if there's no proxy in front actually stripping a
client-supplied header first (or if a request reaches this server directly,
bypassing your proxy), anyone can forge that header and spoof an arbitrary IP.
A hop count of `1` means "trust exactly the immediate one hop, ignore anything
further left in the header" — see [Express's `trust proxy`
docs](https://expressjs.com/en/guide/behind-proxies.html) for the full value
grammar (hop count, IP/subnet, or a custom function).

## Mounting under a path prefix

You can serve WhiteBox from a path on a shared origin (`https://example.com/whitebox`)
rather than its own subdomain. One origin means one DNS lookup, one TLS handshake, no
CORS preflight on `/sessions/resolve` — which sits on the critical path before the
socket opens — and HTTP/2 multiplexing over a single connection.

Point the SDK at the prefixed url and it works:

```js
whitebox({ url: 'https://example.com/whitebox' })
```

Everything in the SDK's HTTP half is already prefix-relative. The **socket** is the
one thing that needs care, because socket.io reads a url's path as a **namespace**,
not a prefix: `io('https://example.com/whitebox')` connects to the origin, asks for
namespace `/whitebox`, and puts its engine at `https://example.com/socket.io` — off
the end of whatever the proxy forwards, and a namespace the server doesn't serve.
The SDK handles this for you by splitting the url into an origin and an engine
`path` (`socketTarget()` in `client/src/transport.js`), so you don't configure it.

It's worth knowing the failure mode it avoids, because it is **silent**: the HTTP
half keeps working, so page views, sessions and conversions all land normally and
only realtime is dead.

What still matters is which of the two proxy shapes you use, because they differ in
what the server sees:

**Stripping the prefix** (the usual one — note the trailing slash on `proxy_pass`,
which is what makes nginx strip):

```nginx
location /whitebox/ {
  proxy_pass http://127.0.0.1:3000/;

  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;      # without these two the socket
  proxy_set_header Connection "upgrade";       # silently falls back to polling
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

The server never sees `/whitebox` and needs **no configuration at all** — it stays
path-agnostic, and the same server can be mounted at a different prefix, or at a
root, without a redeploy. Prefer this.

**Preserving the prefix** (`proxy_pass` with no trailing slash) sends the server
`/whitebox/socket.io/…`, which it would 404. Tell it where to listen:

```js
export default async (runtime) => ({
  connect: { path: '/whitebox/socket.io' },
  // …
})
```

This must match the SDK's `url` — the two are derived from the same prefix but
configured at opposite ends, so a mismatch here is the one way to reintroduce the
silent no-realtime failure. Leave `connect` unset for a root mount or a stripping
proxy.

Set [`trustProxy`](#trust-proxy) either way.

## Admin console

`npm install whitebox-pro-ui` and the console is served at the **root of the same origin as
the API**. Nothing to build, no static host, no reverse proxy. Omit the package and the
server is API-only — the absence is not an error.

```js
export default async (runtime) => ({
  // console: { enabled: false },   // installed but do not serve it
  // …
})
```

Same origin is the point, not a convenience. The console holds an OAuth access token and
talks to a dozen plugin surfaces; served from a different origin it would need CORS with
credentials on every one of them, plus its own proxy to reach them. Serving it from the
process that owns those routes removes all of that.

It is mounted **last**, after every plugin, and cannot shadow an API route: the static
handler only answers for files that exist, and the SPA fallback defers anything that is not
a browser navigation. That last part is deliberate — the fallback asks whether the client
*prefers* HTML over JSON, so `Accept: */*` from a `curl` resolves to JSON and a mistyped API
path still returns a 404 instead of the console's HTML with a 200.

To develop against a server on another host, the console reads `VITE_WB_API_BASE`; with it
unset, a build talks to its own origin and `npm run dev` talks to `/api` through Vite's
proxy.

## Auth model

Every privileged endpoint is protected by an **auth verifier** you set per plugin
via `auth: …`. The default is a **bearer token** (`auth: process.env.WB_<PLUGIN>_TOKEN`
or the legacy `{ secret: … }` shape), checked with a constant-time comparison — but
`auth` accepts anything [MCP's auth](06-mcp.md) does: a bare middleware function, or
a composed OAuth verifier from an external package — either `auth0({ domain, audience,
scope })` (external IdP) or `jwt({ issuer, audience, scope })` (verifies against any
OIDC-compliant issuer, including WhiteBox's own [built-in authorization
server](06-mcp.md#authentication) — no external account required).
`analytics({ auth: auth0({ … }) })` works exactly like
`mcp: { auth: auth0({ … }) }` — the normalization (`resolveAuth` in
`server/src/auth.js`) is the same code either way, not MCP-specific.

Public ingress endpoints (browser-facing: `/sessions/resolve`,
`/conversions/events`, `/engagement/events`, `/crm/observe`) and provider webhooks
(verified by the provider's own signature) are unauthenticated by bearer. Most
plugins refuse to boot without `auth` configured; a couple whose management
surface is optional (conversions' audit endpoint, the shortener's link
management) instead 401 that one route until `auth` is set, since their main
ingress (event collection, redirects) is meant to stay public either way.

### Split verifiers, and the permission catalog

The **surface** plugins take `auth` as an object of independently-resolved
verifiers, one per permission key, rather than a single one:

```js
analytics({
  auth: {
    read:  jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'analytics:read' }),
    write: jwt({ issuer: OAUTH_ISSUER, audience: OAUTH_AUDIENCE, scope: 'analytics:write' }),
  },
})
```

Each plugin also **declares its keys** in a `permissions` catalog, and core
aggregates the catalogs of every *registered* plugin (`server/src/plugins.js`).
That aggregate is what the console reads to decide which modules to show — so a
plugin you didn't register and a permission the user wasn't granted collapse into
the same answer, with no separate feature-flag list to keep in step.

| plugin | keys | granted to a new user by default |
|---|---|---|
| `analytics` | `analytics:read` · `analytics:write` | both |
| `audiences` | `audiences:read` · `audiences:write` | — |
| `campaigns` | `campaigns:read` · `campaigns:write` | — |
| `journeys` | `journeys:read` · `journeys:write` | — |
| `people` | `people:read` · `people:write` · `people:erase` | — |
| `oauth` | `users:manage` | — |

`people` is the one with a third verifier: `auth.erase`, because deleting someone
forever is a different authority from correcting their email. Omit it and it
falls back to `write` — the stricter of the two, never to `read`.

A user's granted scopes are computed **server-side at login** from their actual
grants; the scope in a presented token is never trusted on its own. See
[server-plugin-oauth's README](../server-plugin-oauth/README.md).

## Environment reference

All secrets and connection details come from `process.env` (loaded from
`server/.env` via `--env-file-if-exists`). The config file itself
holds no secrets.

### Core

| var | default | purpose |
|---|---|---|
| `WB_PORT` | 3000 | HTTP port |
| `WB_LOG_LEVEL` | info | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `WB_DB_HOST` `WB_DB_PORT` `WB_DB_NAME` `WB_DB_USER` `WB_DB_PASSWORD` | localhost/5432/whitebox/whitebox/"" | Postgres |
| `WB_REDIS_HOST` `WB_REDIS_PORT` `WB_REDIS_PASSWORD` | localhost/6379/— | Redis |
| `WB_OPENAI_API_KEY` | — | OpenAI (embeddings, ask, Whisper/Vision) |
| `WB_MCP_TOKEN` | — | bearer for `/mcp` (when using a static token) |

### Per-plugin bearer tokens

| var | plugin |
|---|---|
| `WB_ANALYTICS_TOKEN` | analytics |
| `WB_ENGAGEMENT_TOKEN` | engagement (cache admin) |
| `WB_CRM_TOKEN` | crm |
| `WB_CONVERSIONS_TOKEN` | conversions (audit endpoint) |
| `WB_SHORTENER_TOKEN` | shortener |
| `WB_MAIL_TOKEN` | mail |
| `WB_SMS_TOKEN` | sms |
| `WB_AUDIENCES_TOKEN` | audiences |

### Shortener

| var | purpose |
|---|---|
| `WB_SHORTENER_BASEURL` | public host for short links (its hostname gates the `/:code` redirect) |

### Mail providers

| var | provider |
|---|---|
| `WB_MAILGUN_API_KEY` `WB_MAILGUN_DOMAIN` `WB_MAILGUN_WEBHOOK_SIGNING_KEY` | Mailgun |
| `WB_POSTMARK_SERVER_TOKEN` `WB_POSTMARK_FROM` `WB_POSTMARK_WEBHOOK_USER` `WB_POSTMARK_WEBHOOK_PASSWORD` | Postmark |

### SMS providers

| var | provider |
|---|---|
| `WB_TWILIO_SID` `WB_TWILIO_TOKEN` `WB_TWILIO_FROM` | Twilio |
| `WB_MOBICA_USER` `WB_MOBICA_PASS` `WB_MOBICA_DLR_SECRET` | Mobica |

### Ad networks (conversions / audiences)

| var | network |
|---|---|
| `WB_META_PIXEL_ID` `WB_META_CAPI_TOKEN` `WB_META_TEST_EVENT_CODE` | Meta |
| `WB_TIKTOK_PIXEL_CODE` `WB_TIKTOK_EVENTS_TOKEN` | TikTok |
| `WB_GA4_MEASUREMENT_ID` `WB_GA4_API_SECRET` | Google GA4 |

### VoIP & MCP auth

| var | purpose |
|---|---|
| `WB_ARI_URL` `WB_ARI_USER` `WB_ARI_PASSWORD` | Asterisk ARI connection |
| `AUTH0_DOMAIN` (+ `audience`/`scope` set inline) | Auth0 verifier for `/mcp` |
| `WB_DB_*` (shared with core) | `whitebox-pro-server-plugin-oauth`'s CLI scripts (`create-admin.mjs`/`create-client.mjs`) — no separate DB config, no Auth0 account needed |

> A given deployment only needs the variables for the plugins and providers it
> actually enables.

Next: **[05 · Awareness & querying](05-awareness-and-querying.md)**.
