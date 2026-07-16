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
registration** (no open self-signup) and a minimal **admin/non-admin**
distinction — deliberately not a full role system; see "Users & invites"
below.

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
- **`is_admin` is one boolean, not a role system.** An admin can invite,
  list, and remove users; everyone else just uses the product. Adding
  proper roles/permissions is deliberately out of scope for now.

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
    adminScope: 'admin:manage',             // gates the /users routes below (defaults to this)
  }),
  // …
],

mcp: {
  auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'mcp:use' }),
},

// any other plugin works the same way:
analytics({ auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'app:use' }) }),
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
# Create the first user — always an admin (there's no other way to get one):
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
| `GET /me` | any valid token | who am I — `{ id, email, is_admin }` |
| `GET /users` | `adminScope` + `is_admin` | list every user (never the password hash) |
| `POST /users/invite` | `adminScope` + `is_admin` | `{ email }` → creates a pending user, emails/returns the invite link |
| `POST /users/:id/resend-invite` | `adminScope` + `is_admin` | re-issues the token (409 if the user already has a password) |
| `DELETE /users/:id` | `adminScope` + `is_admin` | remove a user (400 on removing yourself) |
| `GET /invite/:token` | public | `{ email }` for a live invite, 404 if invalid/expired |
| `POST /invite/:token/accept` | public | `{ password }` — single-use, sets the password |

The scope check (`adminScope`) is only a first filter — every admin route
re-checks the caller's **current** `is_admin` flag from the database on
every request, not something baked into the token at login time, so a
change takes effect immediately rather than only after the token expires.

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
