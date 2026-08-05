// OAuth 2.1 authorization server surface: authorization_code + PKCE (S256
// only) + refresh_token, mounted at whatever `basePath` config picks
// (default /oauth). No client_secret anywhere — every client is public,
// PKCE is what proves possession of the original request.

import express from 'express'
import { jwt } from 'whitebox-pro-auth-auth0'
import * as store from './store.js'
import * as users from './users.js'
import * as keys from './keys.js'
import { verifyPkce } from './pkce.js'

const CODE_TTL_SEC = 60
const ACCESS_TOKEN_TTL = '1h'
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30   // 30 days

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// The login form for an authorization request. Every OAuth param rides as a hidden field so
// the POST re-submits them alongside credentials with no server-side session at all.
//
// Styled to match the console's own sign-in view, and that is not decoration. This page was
// previously deliberately plain, on the reasoning that a real product login lives in the SPA
// and only operators would ever land here. That reasoning does not survive MCP: a
// third-party client (Claude Code, claude.ai, any agent) sends the user straight to
// /authorize, so for every caller that ISN'T the console this page IS the product's login —
// and it looked like a debug page next to the console it belongs to.
//
// Values are copied from ui/src/style.css rather than imported: this must stay
// dependency-free (it renders whether or not whitebox-pro-ui is installed) and it cannot
// load the SPA's stylesheet. The logo is referenced, not inlined, with an onerror that
// removes it — so it appears when the console is installed to serve /logo.svg and simply
// isn't there when it isn't, rather than showing a broken-image icon.
//
// Two names, answering two different questions, and both have to be here:
//
//   `appName`  — WHERE you are signing in. From config, because only the deployment knows
//                what it calls itself ("GPoint WhiteBox"). A page showing just a logo could
//                be any whitebox, or a convincing copy of one.
//   `client`   — WHO gets your permissions. From the client row, because it is per-client
//                and config cannot know it.
//
// Without the second, the page said only "Sign in", which is the one thing a consent screen
// must not be ambiguous about: signing into the console and handing an agent your scopes
// looked identical.
function loginPage({ params, client, appName }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n')

  // The console signs its own users in; anything else is a third party asking for access.
  const thirdParty = client && client.client_id !== store.CONSOLE_CLIENT_ID
  const subtitle = thirdParty
    ? `<p class="sub">to give <strong>${escapeHtml(client.name || client.client_id)}</strong> access</p>`
    : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>
/* Measured off the running console's own /login rather than copied from the fallbacks in
   ui/src/style.css — those fallbacks are NOT what renders. The PrimeVue theme overrides
   --accent (#6366f1 → #09090b, so the button is near-black, not indigo), --text and
   --radius (10px → 6px) at runtime, so trusting the source would have produced a page that
   looked adjacent to the console instead of identical to it.
   Light only, also by measurement: the console's login stays light under
   prefers-color-scheme: dark, so a dark-mode block here would create the very mismatch it
   looks like it is preventing. */
:root{
  --bg:#f1f5f9; --panel:#fff; --border:#e2e8f0; --border-2:#cbd5e1;
  --text:#334155; --text-strong:#0f172a; --accent:#09090b;
  --radius:6px; --shadow:0 6px 18px rgba(15,23,42,.10);
}
*{box-sizing:border-box}
body{
  margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg);
  color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
form{
  width:320px; padding:32px; display:flex; flex-direction:column; align-items:center; gap:10px;
  background:var(--panel); border:1px solid var(--border);
  border-radius:var(--radius); box-shadow:var(--shadow);
}
img{width:36px;height:36px;margin-bottom:2px}
h1{font-size:17px;font-weight:700;margin:0 0 6px;color:var(--text-strong)}
.sub{margin:-4px 0 4px;font-size:13px;text-align:center;opacity:.8}
.sub strong{color:var(--text-strong);font-weight:600}
/* 8px on the fields against the card's 6px is the console's own combination, not a slip. */
input{
  width:100%; padding:9px 10px; border:1px solid var(--border-2); border-radius:8px;
  font-size:14px; background:var(--panel); color:var(--text);
}
input:focus{outline:2px solid color-mix(in srgb,var(--accent) 25%,transparent);border-color:var(--accent)}
button{
  width:100%; margin-top:6px; padding:9px; border:none; border-radius:8px;
  background:var(--accent); color:#fff; font-size:14px; font-weight:500; cursor:pointer;
}
button:hover{opacity:.92}
</style>
</head><body>
<form method="post">
${hidden}
<img src="/logo.svg" alt="" onerror="this.remove()">
<h1>Sign in${appName ? ` to ${escapeHtml(appName)}` : ''}</h1>
${subtitle}
<!-- autocomplete hints are load-bearing: without them a password manager guesses, and a
     saved credential for a different app on the same host gets filled instead. -->
<input type="email" name="email" placeholder="Email" autocomplete="username" required autofocus>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
</body></html>`
}

// The subset of query/body params that make up one authorization request —
// threaded through the login form's hidden fields untouched.
function authParams(src) {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = src
  return { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state }
}

// Validate client_id + redirect_uri BEFORE anything else. An invalid client
// or an unregistered redirect_uri must render an error page directly, never
// redirect anywhere — redirecting on an unvalidated URI is itself the
// vulnerability (an open redirect via the auth endpoint).
async function resolveClientAndRedirect(params, res) {
  const client = params.client_id && await store.getClient(params.client_id)
  if (!client) { res.status(400).send('Unknown client_id'); return null }
  if (!params.redirect_uri || !store.redirectUriAllowed(client, params.redirect_uri)) {
    res.status(400).send('redirect_uri is not registered for this client')
    return null
  }
  return client
}

function redirectWithError(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (description) url.searchParams.set('error_description', description)
  if (state != null) url.searchParams.set('state', state)
  res.redirect(302, url.toString())
}

export function mountRoutes(app, { basePath, issuer, audience, logger, appUrl, appName, mcpPath, dcr, fromEmail, getMail, permissionsCatalog = [] }) {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))

  // Every module-declared permission key, flattened once — the universe '*'
  // expands into, and what a PUT /users/:id/permissions body is validated
  // against (which also means submitting '*' itself is rejected: it's not a
  // real catalog key, only a bootstrap-only sentinel — see store.js).
  const allPermissionKeys = permissionsCatalog.flatMap(m => m.items.map(i => i.key))
  const defaultPermissionKeys = permissionsCatalog.flatMap(m => m.defaults || [])

  // ── discovery (RFC 8414) ──────────────────────────────────────────────
  //
  // Served at TWO paths, because the obvious one is not the one the spec defines.
  //
  // Mounting this on the router puts it at `${basePath}/.well-known/…` — appending
  // .well-known to the issuer path. RFC 8414 §3 does the opposite: it INSERTS .well-known
  // between the host and the issuer's path, so an issuer of `https://host/oauth` publishes
  // at `https://host/.well-known/oauth-authorization-server/oauth`.
  //
  // Only having the router path cost a real deployment an afternoon. A client looked for the
  // spec path, got 404, and fell back to guessing endpoints from the origin — `/authorize`,
  // `/token`, `/callback` — instead of reading ours. Those guesses happened to hit live
  // routes, so it looked like it nearly worked, while the guessed callback path did not
  // match the client's registered redirect_uri and login failed with something that looked
  // unrelated. A stricter client would simply have refused.
  //
  // Both are kept: the spec path so compliant clients find it, and the router path because
  // it is already advertised in the wild and costs one extra route.
  const metadata = (req, res) => {
    res.json({
      issuer,
      // `issuer` is already the full canonical base (e.g. http://host/oauth) —
      // basePath is purely where Express mounts this router internally, not
      // something to layer onto issuer a second time.
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],   // public clients only
      // Only advertised when registration is actually enabled: a client that finds this key
      // and then gets a 404 has no way to tell "disabled" from "broken".
      ...(dcr ? { registration_endpoint: `${issuer}/register` } : {}),
    })
  }

  router.get('/.well-known/oauth-authorization-server', metadata)

  // The spec path. Registered on `app`, not the router — it lives ABOVE basePath, so the
  // router could never serve it. Derived from the issuer rather than basePath: the issuer is
  // the canonical public identity a client actually resolves against, and behind a proxy it
  // is what differs from where Express happens to mount.
  try {
    const issuerPath = new URL(issuer).pathname.replace(/\/+$/, '')
    app.get(`/.well-known/oauth-authorization-server${issuerPath}`, metadata)
    // An issuer at the root already matches the line above; anything else would double up.
    if (issuerPath) logger?.debug?.('oauth: RFC 8414 metadata at /.well-known/oauth-authorization-server%s', issuerPath)
  } catch {
    logger?.warn?.('oauth: issuer %j is not an absolute URL — RFC 8414 discovery path not mounted, ' +
      'so clients that require it will guess endpoints from the origin instead', issuer)
  }

  // ── Dynamic Client Registration (RFC 7591) ─────────────────────────────
  //
  // For the one client that cannot be handed a client_id: the claude.ai / Claude Desktop
  // Connectors UI takes a URL and nothing else, so it registers itself or it cannot connect.
  // Claude Code does not need this — it accepts a pre-registered id (CLI_CLIENT_ID).
  //
  // Unauthenticated by necessity: you need a client_id BEFORE you can authenticate, so a
  // token requirement here would make the endpoint useless to the only caller that needs it.
  // That is safe because a registered client can do NOTHING on its own — it holds no tokens
  // and represents no user, and cannot act until a real person signs in on the consent page,
  // where the scopes come from that person's grants rather than from anything the client
  // asked for. What is at risk is table volume, not access, so the limits below bound rows.
  //
  // The limiter counts every REQUEST, not every successful registration — a rejected attempt
  // still consumes budget. That is the fail-closed choice for an unauthenticated endpoint:
  // otherwise an invalid payload is free to repeat forever. The cost is that a client getting
  // its metadata wrong repeatedly locks itself out until the window rolls, which is recoverable
  // and visible in the log.
  //
  // The per-IP limiter is intentionally in-process: it needs no store, and the durable bound
  // is the maxClients row count in store.registerDynamicClient. Behind a proxy it depends on
  // Express `trust proxy` being set (core sets it for private peers) — without that every
  // request appears to come from the proxy and the limiter degrades to a global one, which
  // fails closed rather than open.
  if (dcr) {
    const { windowMs = 60 * 60 * 1000, maxPerIp = 5, maxClients = 1000 } = dcr
    const recent = new Map()   // ip -> timestamps[]

    router.post('/register', express.json({ limit: '4kb' }), async (req, res) => {
      const now = Date.now()
      const ip = req.ip || 'unknown'
      const hits = (recent.get(ip) || []).filter(t => now - t < windowMs)
      if (hits.length >= maxPerIp) {
        logger?.warn?.({ ip }, 'oauth: registration rate-limited')
        return res.status(429).json({
          error: 'invalid_client_metadata',
          error_description: 'too many registrations from this address — try again later',
        })
      }
      hits.push(now)
      recent.set(ip, hits)
      // Bounded cleanup so the map cannot grow forever on a long-lived process.
      if (recent.size > 10_000) {
        for (const [k, v] of recent) if (!v.some(t => now - t < windowMs)) recent.delete(k)
      }

      try {
        const row = await store.registerDynamicClient({
          name: req.body?.client_name,
          redirectUris: req.body?.redirect_uris,
          maxClients,
        })
        logger?.info?.({ clientId: row.client_id, name: row.name, ip }, 'oauth: client self-registered')
        const uris = typeof row.redirect_uris === 'string' ? JSON.parse(row.redirect_uris) : row.redirect_uris
        // RFC 7591 §3.2.1: 201, and echo back the metadata as REGISTERED — which may differ
        // from what was sent (a missing name became a placeholder), so a client can see what
        // it actually got rather than assume its request was taken verbatim.
        res.status(201).json({
          client_id: row.client_id,
          client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
          client_name: row.name,
          redirect_uris: uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          // No client_secret, and this states why in the response itself: every client here is
          // public and PKCE is what proves possession of the original request.
          token_endpoint_auth_method: 'none',
        })
      } catch (err) {
        if (err instanceof store.RegistrationError) {
          return res.status(400).json({ error: err.code, error_description: err.message })
        }
        logger?.error?.({ err }, 'oauth: registration failed')
        res.status(500).json({ error: 'invalid_client_metadata', error_description: 'registration failed' })
      }
    })

    logger?.info?.('oauth: dynamic client registration at %s/register (max %d/ip per %dmin, %d total)',
      basePath, maxPerIp, Math.round(windowMs / 60000), maxClients)
  }

  router.get('/.well-known/jwks.json', async (req, res) => {
    res.json(await keys.jwks())
  })

  // Ready-to-use MCP client config, so connecting is a one-liner with nothing to paste:
  //
  //   claude mcp add-json wb -s user "$(curl -fsSL https://host/oauth/mcp-setup.json)"
  //
  // The alternative is telling a user to copy a client_id out of a screen and assemble JSON
  // around it by hand, which is both tedious and a thing they can get subtly wrong. Serving
  // it means the values cannot drift from the server that issued them.
  //
  // Public, deliberately. It carries no secret: the client is public by design (PKCE, not a
  // client_secret) and the endpoint it names is already discoverable via
  // /.well-known/oauth-protected-resource. Requiring a token here would be theatre, and it
  // would defeat the point — you need this BEFORE you can authenticate.
  //
  // Note there is no callbackPort. That is not an omission: with RFC 8252 §7.3 port matching
  // (see store.redirectUriAllowed) the client picks whatever port is free and it still
  // matches, so pinning one here would only create a way for it to be wrong.
  if (mcpPath) {
    router.get('/mcp-setup.json', (req, res) => {
      const origin = `${req.protocol}://${req.get('host')}`
      res.json({
        type: 'http',
        url: `${origin}${mcpPath}`,
        oauth: { clientId: store.CLI_CLIENT_ID },
      })
    })
  }

  // ── /authorize ───────────────────────────────────────────────────────
  router.get('/authorize', async (req, res) => {
    const params = authParams(req.query)
    const client = await resolveClientAndRedirect(params, res)
    if (!client) return   // error already sent

    if (params.response_type !== 'code') {
      return redirectWithError(res, params.redirect_uri, params.state, 'unsupported_response_type')
    }
    if (params.code_challenge_method !== 'S256' || !params.code_challenge) {
      return redirectWithError(res, params.redirect_uri, params.state, 'invalid_request', 'PKCE (S256) is required')
    }

    res.set('Content-Type', 'text/html').send(loginPage({ params, client, appName }))
  })

  router.post('/authorize', async (req, res) => {
    const params = authParams(req.body)
    const client = await resolveClientAndRedirect(params, res)
    if (!client) return

    if (params.response_type !== 'code') {
      return redirectWithError(res, params.redirect_uri, params.state, 'unsupported_response_type')
    }
    if (params.code_challenge_method !== 'S256' || !params.code_challenge) {
      return redirectWithError(res, params.redirect_uri, params.state, 'invalid_request', 'PKCE (S256) is required')
    }

    const user = await users.verifyCredentials(req.body.email, req.body.password)
    if (!user) {
      // redirect_uri is already validated at this point (resolveClientAndRedirect
      // above), so redirecting the error back to the client is exactly as safe as
      // every other redirectWithError call — and it's what lets a caller with its
      // own branded login form (the SPA) show the error on ITS page instead of
      // bouncing to this bare one.
      return redirectWithError(res, params.redirect_uri, params.state, 'access_denied', 'Incorrect email or password')
    }

    // params.scope is whatever the CLIENT asked for — stored only for audit/
    // debugging. It is never trusted for authorization: issueTokens() below
    // always recomputes the real scope from the user's actual DB-stored
    // permission grants, so a client can't mint itself elevated access by
    // simply requesting a scope it isn't entitled to.
    const code = await store.createCode({
      clientId: client.client_id, userId: user.id, redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge, scope: params.scope, ttlSec: CODE_TTL_SEC,
    })
    logger?.info?.({ clientId: client.client_id, userId: user.id }, 'oauth: authorization granted')

    const url = new URL(params.redirect_uri)
    url.searchParams.set('code', code)
    if (params.state != null) url.searchParams.set('state', params.state)
    res.redirect(302, url.toString())
  })

  // ── /token ───────────────────────────────────────────────────────────
  router.post('/token', async (req, res) => {
    const { grant_type: grantType } = req.body

    if (grantType === 'authorization_code') return handleAuthCodeGrant(req, res)
    if (grantType === 'refresh_token') return handleRefreshGrant(req, res)
    return res.status(400).json({ error: 'unsupported_grant_type' })
  })

  async function handleAuthCodeGrant(req, res) {
    const { code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: clientId } = req.body
    const row = code && await store.getCode(code)
    if (!row) return res.status(400).json({ error: 'invalid_grant' })
    if (row.used_at || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' })
    // Both must match exactly what /authorize was called with (RFC 6749 §4.1.3) —
    // a code minted for one client/redirect can't be redeemed against another.
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return res.status(400).json({ error: 'invalid_grant' })
    }
    if (!verifyPkce(codeVerifier, row.code_challenge)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
    }

    const won = await store.redeemCode(code)
    if (!won) return res.status(400).json({ error: 'invalid_grant' })   // already used — possible replay

    // A real login — recorded here, not in handleRefreshGrant, so silent
    // token renewals never inflate the login-history list. req.ip already
    // respects the app's trustProxy config (createApp({ trustProxy })).
    await store.recordLogin({
      userId: row.user_id, clientId: row.client_id,
      ip: req.ip, userAgent: req.get('user-agent'),
    })

    return issueTokens(res, { clientId: row.client_id, userId: row.user_id })
  }

  async function handleRefreshGrant(req, res) {
    const { refresh_token: token, client_id: clientId } = req.body
    const row = token && await store.getRefreshToken(token)
    if (!row) return res.status(400).json({ error: 'invalid_grant' })
    if (row.revoked_at || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' })
    if (row.client_id !== clientId) return res.status(400).json({ error: 'invalid_grant' })

    // Revoke BEFORE minting the replacement — if this loses a race (someone
    // else already rotated/revoked it), bail out having created nothing, so
    // a lost race can never leave an orphaned valid token nobody holds.
    const won = await store.revokeRefreshToken(token)
    if (!won) return res.status(400).json({ error: 'invalid_grant' })

    // Recomputed fresh from DB (not copied from the refresh token row) —
    // this is what makes a granted/revoked permission actually take effect
    // on the user's next refresh instead of only at their next full login.
    return issueTokens(res, { clientId: row.client_id, userId: row.user_id })
  }

  // The one place a token's `scope` claim is ever decided. Always computed
  // from the user's CURRENT DB-stored permissions — never from anything the
  // client requested — because with no other check left anywhere (every
  // plugin's gate is JWT-scope-only, and there's no separate is_admin
  // recheck), this is the only thing standing between a logged-in user and
  // whatever scope a forged /authorize request might have asked for.
  async function issueTokens(res, { clientId, userId }) {
    const user = await store.getUser(userId)
    const scope = store.expandPermissions(user?.permissions || [], allPermissionKeys).join(' ')
    const accessToken = await keys.signJwt({
      issuer, audience, subject: userId, scope, expiresIn: ACCESS_TOKEN_TTL,
    })
    const refreshToken = await store.createRefreshToken({ clientId, userId, scope, ttlSec: REFRESH_TOKEN_TTL_SEC })
    res.json({
      access_token: accessToken, token_type: 'Bearer', expires_in: 3600,
      refresh_token: refreshToken, scope: scope || undefined,
    })
  }

  // ── /users (gated by the users:manage permission, same as every other
  // module's gate) ───────────────────────────────────────────────────────
  // Verifies the SAME kind of token this server itself issues, via the
  // identical generic jwt() verifier every other plugin uses — the oauth
  // server is a resource server for its own tokens here. No DB re-check:
  // trusting the JWT's scope claim is safe because issueTokens() (above)
  // is the only place that claim is ever set, and it's always computed
  // fresh from the DB, never from what a client requests.
  router.use(express.json())

  const anyAuth = jwt({ issuer, audience })
  const manageUsers = jwt({ issuer, audience, scope: 'users:manage' })

  // Any authenticated user (not permission-gated) — "who am I", for the SPA
  // to know its own identity/granted modules without fetching the user list.
  router.get('/me', anyAuth.middleware, async (req, res) => {
    const user = await store.getUser(req.auth.sub)
    if (!user) return res.status(404).json({ error: 'not found' })
    await store.touchLastAccess(user.id)
    res.json({ ...user, permissions: store.expandPermissions(user.permissions, allPermissionKeys) })
  })

  // The aggregated permission catalog every plugin declared at boot — what
  // the Users admin panel renders as checkboxes, grouped by module.
  router.get('/permissions/catalog', manageUsers.middleware, (req, res) => {
    res.json(permissionsCatalog)
  })

  // Replaces a user's grant set wholesale. Rejecting anything not a real
  // catalog key also rejects '*' for free — it's a bootstrap-only sentinel,
  // never settable through this (or any) API.
  router.put('/users/:id/permissions', manageUsers.middleware, async (req, res) => {
    const permissions = req.body?.permissions
    if (!Array.isArray(permissions) || permissions.some(p => typeof p !== 'string')) {
      return res.status(400).json({ error: 'permissions must be an array of strings' })
    }
    const unknown = permissions.filter(p => !allPermissionKeys.includes(p))
    if (unknown.length) return res.status(400).json({ error: `unknown permission key(s): ${unknown.join(', ')}` })

    // Never let a save strip users:manage from the last active holder — see
    // hasOtherActiveManager's comment on why that lockout can't be undone.
    if (!permissions.includes('users:manage')) {
      const current = await store.getUser(req.params.id)
      const currentlyManages = current?.permissions?.includes('*') || current?.permissions?.includes('users:manage')
      if (currentlyManages && !(await store.hasOtherActiveManager(req.params.id))) {
        return res.status(400).json({ error: 'cannot remove users:manage from the only active user who holds it' })
      }
    }

    // Raw (not expanded) — consistent with what GET /users already showed;
    // the submitted list is already concrete anyway (validation above
    // rejects '*'), so there's nothing for expandPermissions to do here.
    const ok = await store.setPermissions(req.params.id, permissions)
    if (!ok) return res.status(404).json({ error: 'not found' })
    res.json(await store.getUser(req.params.id))
  })

  // Admin-editable profile — any subset of { first_name, last_name, phone, email }.
  // Raw (not expanded) permissions in the response — same reasoning as above;
  // this route never touches permissions, so echoing the expanded form would
  // silently overwrite the client's view of a '*' grant with a concrete list.
  router.patch('/users/:id', manageUsers.middleware, async (req, res) => {
    const { first_name: firstName, last_name: lastName, phone, email } = req.body || {}
    try {
      const user = await store.updateProfile(req.params.id, { firstName, lastName, phone, email })
      if (!user) return res.status(404).json({ error: 'not found' })
      res.json(user)
    } catch (err) {
      // Postgres unique_violation on the email column — a clean 409, not a raw 500.
      if (err.code === '23505') return res.status(409).json({ error: 'email already in use' })
      res.status(400).json({ error: err.message })
    }
  })

  // Self-service password change — gated by anyAuth (any valid token, not
  // users:manage) since this is a "manage MYSELF" action, unrelated to
  // whatever other permissions the caller holds. Still hard-restricted to
  // your OWN account regardless: :id must match the token's own subject, so
  // there's no way for this route to become an admin-resets-anyone's-
  // password path even by URL manipulation.
  router.patch('/users/:id/password', anyAuth.middleware, async (req, res) => {
    if (req.params.id !== req.auth.sub) return res.status(403).json({ error: 'can only change your own password' })
    try {
      const { currentPassword, newPassword } = req.body || {}
      await users.changePassword({ id: req.params.id, currentPassword, newPassword })
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // Login history — real logins only (see recordLogin's call site), newest first.
  router.get('/users/:id/logins', manageUsers.middleware, async (req, res) => {
    res.json(await store.listLogins(req.params.id))
  })

  // Which agents this user has connected, and the means to cut one off.
  //
  // The pair (user, client) is the unit on purpose. Revoking a CLIENT wholesale would sign out
  // every other user of it — including everyone using the shared CLI client — and revoking a
  // USER wholesale would take their console session with it. Neither is what "disconnect this
  // agent" means.
  router.get('/users/:id/agents', manageUsers.middleware, async (req, res) => {
    res.json(await store.listUserAgents(req.params.id))
  })

  router.delete('/users/:id/agents/:clientId', manageUsers.middleware, async (req, res) => {
    const revoked = await store.revokeUserAgent(req.params.id, req.params.clientId)
    logger?.info?.({ userId: req.params.id, clientId: req.params.clientId, revoked },
      'oauth: agent access revoked')
    // 200 with the count even when it is 0: "there was nothing live to revoke" is a success,
    // not a missing resource, and the console renders the same result either way.
    res.json({ revoked })
  })

  function inviteUrl(token) {
    return `${appUrl.replace(/\/$/, '')}/accept-invite?token=${token}`
  }

  async function sendInviteEmail(to, url) {
    const send = getMail?.()?.send
    if (!send) { logger?.warn?.('oauth: invite created but no mail service is configured — share the link manually'); return }
    try {
      await send({
        from: fromEmail, to, subject: "You've been invited to WhiteBox",
        text: `You've been invited. Set your password to get started: ${url}`,
        html: `<p>You've been invited. <a href="${escapeHtml(url)}">Set your password</a> to get started.</p>`,
      })
    } catch (err) {
      logger?.warn?.({ err, to }, 'oauth: invite email failed to send — share the link manually')
    }
  }

  router.post('/users/invite', manageUsers.middleware, async (req, res) => {
    if (!appUrl) return res.status(500).json({ error: 'oauth(): appUrl is not configured — cannot issue invites' })
    const email = req.body?.email
    if (!email) return res.status(400).json({ error: 'email is required' })
    const invited = await store.createInvite({ email })
    const url = inviteUrl(invited.invite_token)
    await sendInviteEmail(invited.email, url)
    const { invite_token, ...user } = invited
    res.status(201).json({ ...user, inviteUrl: url })
  })

  router.get('/users', manageUsers.middleware, async (req, res) => {
    res.json(await store.searchUsers(req.query))
  })

  router.post('/users/:id/resend-invite', manageUsers.middleware, async (req, res) => {
    if (!appUrl) return res.status(500).json({ error: 'oauth(): appUrl is not configured — cannot issue invites' })
    const invited = await store.regenerateInvite(req.params.id)
    if (!invited) return res.status(409).json({ error: 'user is not pending an invite' })
    const url = inviteUrl(invited.invite_token)
    await sendInviteEmail(invited.email, url)
    const { invite_token, ...user } = invited
    res.json({ ...user, inviteUrl: url })
  })

  router.delete('/users/:id', manageUsers.middleware, async (req, res) => {
    if (req.params.id === req.auth.sub) return res.status(400).json({ error: 'cannot remove your own account' })
    const removed = await store.deleteUser(req.params.id)
    if (!removed) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  })

  // ── /invite/:token (public — the accept-invite page itself is unauthenticated) ──
  router.get('/invite/:token', async (req, res) => {
    const invite = await users.getByInviteToken(req.params.token)
    if (!invite) return res.status(404).json({ error: 'invalid or expired invite' })
    res.json(invite)
  })

  router.post('/invite/:token/accept', async (req, res) => {
    try {
      const { password, firstName, lastName, phone } = req.body || {}
      const ok = await users.completeInvite({
        token: req.params.token, password, firstName, lastName, phone,
        defaultPermissions: defaultPermissionKeys,
      })
      if (!ok) return res.status(400).json({ error: 'invalid or expired invite' })
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ── /setup (public — a THIRD bootstrap path alongside scripts/create-admin.mjs
  // and index.js's own ADMIN_EMAIL/ADMIN_PASSWORD auto-bootstrap on boot, for
  // when neither of those ran: the UI itself asks for the first admin's email
  // + password instead of requiring shell access. Same gate as the other two —
  // store.hasAnyUser() must be false — so it's a no-op the instant any user
  // exists, admin or not, closing the window the moment either of the other
  // two paths (or a previous /setup submission) has already run. ──
  router.get('/setup-required', async (req, res) => {
    res.json({ required: !(await store.hasAnyUser()) })
  })

  router.post('/setup', async (req, res) => {
    if (await store.hasAnyUser()) return res.status(409).json({ error: 'setup already completed' })
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' })
    if (password.length < 12) return res.status(400).json({ error: 'password must be at least 12 characters' })
    const admin = await users.createUser({ email, password, permissions: ['*'] })
    res.status(201).json({ id: admin.id, email: admin.email })
  })

  // Alias bare /authorize and /token to this basePath's real routes. Some
  // OAuth clients (confirmed: the `claude mcp login` CLI) resolve the
  // issuer's discovery URLs with an absolute-path join — new URL('/token', issuer)
  // — which replaces the issuer's path instead of extending it, so they call
  // bare /authorize and /token instead of e.g. /oauth/authorize and /oauth/token.
  // Must be registered BEFORE the router below: Express only checks a given
  // layer's path against req.url once, when the stack walk reaches that layer,
  // so rewriting req.url here only takes effect on layers still ahead of it.
  // Harmless when basePath is already '/'; only matters for nested basePaths.
  if (basePath !== '/') {
    app.use((req, res, next) => {
      if (req.path === '/authorize' || req.path === '/token') req.url = basePath + req.url
      next()
    })
  }

  app.use(basePath, router)
}
