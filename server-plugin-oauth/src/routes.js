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

// A bare, dependency-free login form — every OAuth param rides as a hidden
// field so the POST can re-submit them alongside credentials with no server-
// side session at all. Deliberately plain: this is an admin/operator login
// surface, not a product login page. (A real product login lives in the SPA
// and POSTs here directly — see the wrong-password handling below, which
// redirects back to the client on failure rather than re-rendering this page,
// so a caller with its own branded form never bounces through this one.)
function loginPage({ params }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:14px system-ui,sans-serif;max-width:320px;margin:80px auto;color:#222}
input[type=email],input[type=password]{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{width:100%;padding:8px;margin-top:8px}</style>
</head><body>
<h3>Sign in</h3>
<form method="post">
${hidden}
<input type="email" name="email" placeholder="Email" required autofocus>
<input type="password" name="password" placeholder="Password" required>
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

export function mountRoutes(app, { basePath, issuer, audience, logger, appUrl, fromEmail, getMail, permissionsCatalog = [] }) {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))

  // Every module-declared permission key, flattened once — the universe '*'
  // expands into, and what a PUT /users/:id/permissions body is validated
  // against (which also means submitting '*' itself is rejected: it's not a
  // real catalog key, only a bootstrap-only sentinel — see store.js).
  const allPermissionKeys = permissionsCatalog.flatMap(m => m.items.map(i => i.key))
  const defaultPermissionKeys = permissionsCatalog.flatMap(m => m.defaults || [])

  // ── discovery (RFC 8414) ──────────────────────────────────────────────
  router.get('/.well-known/oauth-authorization-server', (req, res) => {
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
    })
  })

  router.get('/.well-known/jwks.json', async (req, res) => {
    res.json(await keys.jwks())
  })

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

    res.set('Content-Type', 'text/html').send(loginPage({ params }))
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

  // Login history — real logins only (see recordLogin's call site), newest first.
  router.get('/users/:id/logins', manageUsers.middleware, async (req, res) => {
    res.json(await store.listLogins(req.params.id))
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
    res.json(await store.listUsers())
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

  app.use(basePath, router)
}
