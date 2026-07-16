// OAuth 2.1 authorization server surface: authorization_code + PKCE (S256
// only) + refresh_token, mounted at whatever `basePath` config picks
// (default /oauth). No client_secret anywhere — every client is public,
// PKCE is what proves possession of the original request.

import express from 'express'
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
// surface, not a product login page.
function loginPage({ params, error }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:14px system-ui,sans-serif;max-width:320px;margin:80px auto;color:#222}
input[type=email],input[type=password]{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{width:100%;padding:8px;margin-top:8px}.err{color:#b00;font-size:13px}</style>
</head><body>
<h3>Sign in</h3>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
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

export function mountRoutes(app, { basePath, issuer, audience, logger }) {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))

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
      return res.status(401).set('Content-Type', 'text/html')
        .send(loginPage({ params, error: 'Incorrect email or password' }))
    }

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

    return issueTokens(res, { clientId: row.client_id, userId: row.user_id, scope: row.scope })
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

    return issueTokens(res, { clientId: row.client_id, userId: row.user_id, scope: row.scope })
  }

  async function issueTokens(res, { clientId, userId, scope }) {
    const accessToken = await keys.signJwt({
      issuer, audience, subject: userId, scope, expiresIn: ACCESS_TOKEN_TTL,
    })
    const refreshToken = await store.createRefreshToken({ clientId, userId, scope, ttlSec: REFRESH_TOKEN_TTL_SEC })
    res.json({
      access_token: accessToken, token_type: 'Bearer', expires_in: 3600,
      refresh_token: refreshToken, scope: scope || undefined,
    })
  }

  app.use(basePath, router)
}
