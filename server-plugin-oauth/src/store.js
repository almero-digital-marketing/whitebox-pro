import { randomBytes, randomUUID } from 'node:crypto'

let db

export function init(deps) {
  db = deps.db
}

const opaqueToken = () => randomBytes(32).toString('base64url')   // 256 bits — code and refresh tokens alike

// ── clients ──────────────────────────────────────────────────────────────

export async function getClient(clientId) {
  return db('whitebox_oauth_clients').where({ client_id: clientId }).first()
}

export async function createClient({ name, redirectUris }) {
  if (!name || !Array.isArray(redirectUris) || !redirectUris.length) {
    throw new Error('createClient: name and a non-empty redirectUris array are required')
  }
  const clientId = randomUUID()
  const [row] = await db('whitebox_oauth_clients')
    .insert({ client_id: clientId, name, redirect_uris: JSON.stringify(redirectUris) })
    .returning(['client_id', 'name', 'redirect_uris'])
  return row
}

// redirect_uri must match one of the client's registered URIs EXACTLY — no
// prefix/wildcard matching (RFC 6749 §3.1.2, and a classic real-world
// bypass when implementations get this loose).
export function redirectUriAllowed(client, redirectUri) {
  const uris = typeof client.redirect_uris === 'string' ? JSON.parse(client.redirect_uris) : client.redirect_uris
  return Array.isArray(uris) && uris.includes(redirectUri)
}

// ── authorization codes ─────────────────────────────────────────────────

export async function createCode({ clientId, userId, redirectUri, codeChallenge, scope, ttlSec = 60 }) {
  const code = opaqueToken()
  await db('whitebox_oauth_codes').insert({
    code, client_id: clientId, user_id: userId, redirect_uri: redirectUri,
    code_challenge: codeChallenge, scope: scope || '',
    expires_at: new Date(Date.now() + ttlSec * 1000),
  })
  return code
}

export async function getCode(code) {
  return db('whitebox_oauth_codes').where({ code }).first()
}

// Single-use redemption: only succeeds (returns true) if this code was still
// unused — an UPDATE ... WHERE used_at IS NULL is atomic under Postgres, so
// two concurrent redemption attempts can't both win.
export async function redeemCode(code) {
  const n = await db('whitebox_oauth_codes').where({ code, used_at: null }).update({ used_at: new Date() })
  return n === 1
}

// ── refresh tokens ───────────────────────────────────────────────────────

export async function createRefreshToken({ clientId, userId, scope, ttlSec, token } = {}) {
  const tok = token || opaqueToken()
  await db('whitebox_oauth_refresh_tokens').insert({
    token: tok, client_id: clientId, user_id: userId, scope: scope || '',
    expires_at: new Date(Date.now() + ttlSec * 1000),
  })
  return tok
}

export async function getRefreshToken(token) {
  return db('whitebox_oauth_refresh_tokens').where({ token }).first()
}

// Rotation: atomically claim this token (same used-once guard as codes,
// via revoked_at IS NULL) before minting its replacement, so a replayed
// refresh token can never win a race against the legitimate holder.
export async function revokeRefreshToken(token, replacedBy = null) {
  const n = await db('whitebox_oauth_refresh_tokens')
    .where({ token, revoked_at: null })
    .update({ revoked_at: new Date(), replaced_by: replacedBy })
  return n === 1
}

// ── users (invite-only registration + admin flag, no role system) ────────

const INVITE_TTL_SEC = 7 * 24 * 60 * 60   // 7 days
const USER_COLUMNS = ['id', 'email', 'is_admin', 'invited_at', 'created_at']

export async function createInvite({ email }) {
  if (!email) throw new Error('createInvite: email is required')
  const [row] = await db('whitebox_oauth_users')
    .insert({
      id: randomUUID(), email: email.toLowerCase().trim(), is_admin: false,
      invite_token: opaqueToken(), invite_expires_at: new Date(Date.now() + INVITE_TTL_SEC * 1000),
      invited_at: new Date(),
    })
    .returning([...USER_COLUMNS, 'invite_token'])
  return row
}

export async function listUsers() {
  const rows = await db('whitebox_oauth_users').select([...USER_COLUMNS, 'password_hash']).orderBy('created_at', 'asc')
  return rows.map(({ password_hash, ...rest }) => ({ ...rest, active: password_hash != null }))
}

export async function getUser(id) {
  return db('whitebox_oauth_users').select(USER_COLUMNS).where({ id }).first()
}

export async function deleteUser(id) {
  const n = await db('whitebox_oauth_users').where({ id }).del()
  return n === 1
}

// Only meaningful for a still-pending (no password) user — refreshes the
// token/expiry so an old, possibly-expired invite link doesn't linger as the
// only way in.
export async function regenerateInvite(id) {
  const n = await db('whitebox_oauth_users')
    .where({ id, password_hash: null })
    .update({ invite_token: opaqueToken(), invite_expires_at: new Date(Date.now() + INVITE_TTL_SEC * 1000) })
  if (n !== 1) return null
  return db('whitebox_oauth_users').select([...USER_COLUMNS, 'invite_token']).where({ id }).first()
}
