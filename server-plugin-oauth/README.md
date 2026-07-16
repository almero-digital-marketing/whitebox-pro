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
JWKS endpoint, and RFC 8414 discovery — so an MCP client (or any OAuth
client) can log in against your own server, with no third-party account
anywhere in the loop.

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
- **A minimal server-rendered login form**, not a SPA — this is an
  operator/admin login surface, not a product login page.

## Use

```js
import { oauth } from 'whitebox-pro-server-plugin-oauth'
import { jwt } from 'whitebox-pro-auth-auth0'

const ISSUER = 'http://localhost:3000/oauth'   // your server's own URL + oauth path
const AUDIENCE = 'https://whitebox/api'         // any fixed string identifying your API

plugins: [
  oauth({ issuer: ISSUER, audience: AUDIENCE }),
  // …
],

mcp: {
  auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'mcp:use' }),
},

// any other plugin works the same way:
analytics({ auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'analytics:read' }) }),
```

`basePath` (where this mounts — `/authorize`, `/token`, `/.well-known/*`)
is *derived* from `issuer`'s own path, not a second option to keep in sync
— `issuer: 'http://localhost:3000/oauth'` mounts at `/oauth` automatically.
This is deliberate: `issuer` and where the server actually serves its
endpoints must never be able to drift apart, since a mismatch there would
make the discovery document lie about its own location.

## Bootstrapping

No UI exists yet to create users or register clients — both are one-off
CLI scripts, run once per user/client:

```bash
# Create the first (or another) user:
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/create-admin.mjs

# Register an OAuth client (an MCP client, an app, …):
node scripts/create-client.mjs --name="Claude Desktop" \
  --redirect-uri="http://localhost:PORT/callback"
```

Both read the same `WB_DB_*` env vars the main WhiteBox server does, and
run their own migration first (in case this is the very first thing ever
run against a fresh database).

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
