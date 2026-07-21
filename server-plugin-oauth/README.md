# whitebox-pro-server-plugin-oauth

> A self-hosted OAuth 2.1 authorization server for WhiteBox — no external
> identity provider account required.

## What it is

`whitebox-pro-auth-auth0` already lets any plugin's `auth` option (and
`mcp.auth`) accept a composed OAuth/OIDC verifier instead of a bare bearer
secret — but until now the only real option was Auth0: an external account,
an API registration, a tenant to configure. This package is the same
verifier contract, issued by WhiteBox itself.

It implements the piece Auth0 usually provides: an authorization endpoint
(login + PKCE), a token endpoint (code exchange + refresh rotation), a
JWKS endpoint, and RFC 8414 discovery — so an MCP client, the WhiteBox UI
itself, or any other OAuth client can log in against your own server, with
no third-party account anywhere in the loop. It also owns **invite-only
registration** (no open self-signup) and **per-module permission grants** —
still no named-role system, just an explicit set of catalog keys per user;
see "Permissions" below.

Unlike the ad-network/mail/SMS providers under `whitebox-pro-integrations/`,
this package ships **in this monorepo**: it isn't an adapter for an external
vendor, it's a first-party WhiteBox feature (an authorization server, not a
provider for one) — the same class of thing as `server-plugin-audiences` or
`server-plugin-campaigns`.

**Design choices, and why:**

- **Public clients only — PKCE (S256) required, no `client_secret`.** MCP
  clients and browser-based apps can't hold a secret safely; PKCE proves
  possession of the original authorization request instead.
- **Pre-registered clients only — no Dynamic Client Registration.** An
  admin explicitly registers each client (`scripts/create-client.mjs`).
  DCR is convenient for a multi-tenant SaaS; it's also a real attack
  surface for a self-hosted single-tenant deployment, and isn't needed here.
- **Node's built-in `scrypt`** for password hashing — no native dependency
  (bcrypt/argon2), no separate binary to install.
- **A minimal server-rendered login form** at `GET /authorize` as the
  fallback for non-SPA clients (MCP, curl, manual testing) — a real product
  UI (like the WhiteBox UI) renders its own branded form and POSTs directly
  to `POST /authorize` instead; both hit the exact same endpoint.
- **A permission catalog, not a role system.** Every plugin declares its own
  set of permission keys (and sane defaults for brand-new users) into one
  aggregated catalog; an admin grants/revokes them per user through the
  Users module. There's still no named "editor"/"viewer" layer on top —
  just explicit per-user grants. See "Permissions" below.
- **Token scope is always computed server-side, never trusted from the
  client.** Every plugin's REST surface (including this one's own `/users`
  routes) is gated by `jwt({ scope })` with no per-request DB re-check, so
  the ONLY thing standing between a user and elevated access is that the
  token's `scope` claim is minted from their actual stored permissions at
  login/refresh — never from whatever a client's `/authorize` request asks
  for. See "Permissions" for why this matters.

## Use

```js
import { oauth } from 'whitebox-pro-server-plugin-oauth'
import { jwt } from 'whitebox-pro-auth-auth0'

const ISSUER = 'http://localhost:3000/oauth'   // your server's own URL + oauth path
const AUDIENCE = 'https://whitebox/api'         // any fixed string identifying your API

plugins: [
  oauth({
    issuer: ISSUER, audience: AUDIENCE,
    appUrl: 'http://localhost:5173',        // where the UI lives — invite emails link here
  }),
  // …
],

mcp: {
  auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'mcp:use' }),
},

// any other plugin works the same way — its own scope(s), from its own
// `permissions` catalog entries (see "Permissions" below). A plugin whose
// REST surface has a meaningful read/write distinction takes { read, write }
// instead of one verifier (see whitebox-pro-server/auth's resolveReadWriteAuth):
analytics({
  auth: {
    read: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'analytics:read' }),
    write: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'analytics:write' }),
  },
}),
```

`basePath` (where this mounts — `/authorize`, `/token`, `/.well-known/*`)
is *derived* from `issuer`'s own path, not a second option to keep in sync
— `issuer: 'http://localhost:3000/oauth'` mounts at `/oauth` automatically.
This is deliberate: `issuer` and where the server actually serves its
endpoints must never be able to drift apart, since a mismatch there would
make the discovery document lie about its own location.

## Bootstrapping

There's no way to create the *first* user or register a client except two
one-off CLI scripts — after that, an admin invites everyone else through
the UI's Users module:

```bash
# Create the first user — granted every permission via the '*' sentinel,
# since there's no admin yet to grant them users:manage individually:
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/create-admin.mjs

# Register an OAuth client (the WhiteBox UI, an MCP client, …):
node scripts/create-client.mjs --name="WhiteBox UI" \
  --redirect-uri="http://localhost:5173/callback"
```

Both read the same `WB_DB_*` env vars the main WhiteBox server does, and
run their own migration first (in case this is the very first thing ever
run against a fresh database).

## Users & invites

Registration is invite-only — there is no open self-signup route. An admin
invites a teammate (`POST /users/invite`, `{ email }`); that creates a
*pending* user (no password yet, `password_hash IS NULL`) with a single-use,
7-day expiring token, and — if a mail plugin is registered (`ctx.plugins.mail`)
— emails a link to `{appUrl}/accept-invite?token=…`. If no mail plugin is
configured, the response's `inviteUrl` is the link — share it manually.

The invited person visits that link, which round-trips through this
package's own public endpoints (`GET /invite/:token` to look up the email,
`POST /invite/:token/accept` to set a password) — the UI's `/accept-invite`
view is a thin wrapper over these two calls, not a parallel auth system.
Once accepted, they log in exactly like any other user.

Routes (all under the plugin's `basePath`, e.g. `/oauth`):

| route | auth | purpose |
|---|---|---|
| `GET /me` | any valid token | who am I — `{ id, email, permissions }` (permissions already expanded — see below) |
| `GET /permissions/catalog` | `users:manage` | the full aggregated catalog every plugin declared, grouped by module |
| `GET /users` | `users:manage` | list every user (never the password hash) |
| `POST /users/invite` | `users:manage` | `{ email }` → creates a pending user, emails/returns the invite link |
| `POST /users/:id/resend-invite` | `users:manage` | re-issues the token (409 if the user already has a password) |
| `PUT /users/:id/permissions` | `users:manage` | `{ permissions: [...] }` → replaces a user's grant set wholesale; 400 if it would strip `users:manage` from the last active user who holds it |
| `PATCH /users/:id` | `users:manage` | `{ first_name?, last_name?, phone?, email? }` — any subset; 409 on a duplicate email |
| `GET /users/:id/logins` | `users:manage` | login history — real logins only (never a silent token refresh), newest first; each row includes `ip` and a best-effort `browser`/`os` (parsed from the User-Agent, display-only — see userAgent.js) |
| `DELETE /users/:id` | `users:manage` | remove a user (400 on removing yourself) |
| `GET /invite/:token` | public | `{ email }` for a live invite, 404 if invalid/expired |
| `POST /invite/:token/accept` | public | `{ password, firstName?, lastName?, phone? }` — single-use, sets the password and seeds the current catalog defaults |

## Permissions

Every plugin can declare a `permissions` field on its factory's return value
— a set of catalog keys plus which ones a brand-new user gets by default:

```js
// e.g. inside analytics()'s return value — a plugin can declare as many keys
// as its REST surface has meaningful distinctions; analytics/audiences/
// campaigns each split theirs into :read and :write (enforced per-route by
// mutation semantics, not HTTP verb — see each plugin's rest.js):
permissions: {
  items: [
    { key: 'analytics:read', label: 'View Analytics', description: 'View reports and ask grounded questions' },
    { key: 'analytics:write', label: 'Edit Analytics', description: 'Create and edit reports and widgets' },
  ],
  defaults: ['analytics:read', 'analytics:write'],
}
```

`server/src/plugins.js`'s loader aggregates every registered plugin's
catalog into `ctx.permissions.catalog` before any plugin's `register()`
runs, so this plugin's own routes (and `GET /permissions/catalog`) can see
every module's entries regardless of load order. This package declares one
entry of its own: `users:manage` — managing users & permissions is just
another module capability, not a special superuser flag.

A user's `permissions` column is a flat array of these keys, or the single
reserved sentinel `"*"` ("every permission that exists, including ones added
later"). `"*"` is **bootstrap-only** — `scripts/create-admin.mjs` is the one
place it's ever set (there's no admin yet to grant the first user
`users:manage` individually); it's never a value the Users module (or
`PUT /users/:id/permissions`) will accept, so there's no way to re-grant it
through the running product.

**Enforcement is JWT-scope-only, with no per-request DB re-check** — same as
every other plugin. A granted or revoked permission takes effect on the
user's next token refresh (≤1h), not instantly. That tradeoff is only safe
because of one invariant: **`issueTokens()` always computes a token's
`scope` claim fresh from the user's current DB-stored `permissions`,
never from anything the client requests at `/authorize`.** Earlier, the
now-removed `is_admin` flag had its own redundant DB re-check specifically
because client-requested scope wasn't trustworthy on its own; moving to
pure JWT-scope trust across every module made fixing that the load-bearing
piece of the whole design, not optional hardening.

## What it returns

A `client_id` with no secret. Point any OAuth 2.1 client at the discovery
document:

```
GET {issuer}/.well-known/oauth-authorization-server
```

and it can complete the authorization_code + PKCE flow entirely on its
own, exactly as it would against Auth0.

## Security notes

- Signing key: ES256, generated once on first boot and persisted (not
  regenerated per restart — a fresh key every boot would silently
  invalidate every outstanding token and desync the JWKS response across
  replicas sharing the same database).
- `redirect_uri` is matched **exactly** against a client's registered
  URIs — no prefix/wildcard matching.
- Authorization codes are single-use (atomically redeemed) and short-lived
  (~60s).
- Refresh tokens rotate on every use — the old token is revoked before the
  new one is minted, and a replayed (already-rotated) token is rejected.
