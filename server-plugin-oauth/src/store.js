import { randomBytes, randomUUID } from 'node:crypto'
import { parseUserAgent } from './userAgent.js'

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

// ── login history ────────────────────────────────────────────────────────
// One row per successful authorization_code redemption (a real login) — see
// routes.js's handleAuthCodeGrant, the only caller. A refresh_token grant
// (silent renewal) never adds a row here.

export async function recordLogin({ userId, clientId, ip, userAgent }) {
  await db('whitebox_oauth_logins').insert({
    id: randomUUID(), user_id: userId, client_id: clientId,
    ip: ip || null, user_agent: userAgent || null,
  })
}

export async function listLogins(userId, { limit = 20 } = {}) {
  const rows = await db('whitebox_oauth_logins')
    .select(['id', 'client_id', 'created_at', 'ip', 'user_agent'])
    .where({ user_id: userId })
    .orderBy('created_at', 'desc')
  const clients = await db('whitebox_oauth_clients').select(['client_id', 'name'])
  const nameById = new Map(clients.map(c => [c.client_id, c.name]))
  return rows.slice(0, limit).map(r => ({
    id: r.id, created_at: r.created_at, client_name: nameById.get(r.client_id) || r.client_id,
    ip: r.ip || null, ...parseUserAgent(r.user_agent),
  }))
}

// ── users (invite-only registration + per-module permission grants) ──────
//
// `permissions` is a flat array of catalog keys (e.g. ["analytics:use"]),
// or the single reserved sentinel "*" ("every permission that exists,
// including ones added later") — bootstrap-only, never a UI-selectable
// value (see scripts/create-admin.mjs and expandPermissions() below).

const INVITE_TTL_SEC = 7 * 24 * 60 * 60   // 7 days
const USER_COLUMNS = ['id', 'email', 'first_name', 'last_name', 'phone', 'permissions', 'invited_at', 'created_at', 'last_access_at']

// jsonb comes back already-parsed from real Postgres, but the fake test DB
// stores whatever was handed to insert() verbatim — normalize both here
// rather than at every call site (mirrors redirectUriAllowed's same guard).
function readPermissions(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') { try { return JSON.parse(value) || [] } catch { return [] } }
  return []
}
const normalizeUser = (row) => row && { ...row, permissions: readPermissions(row.permissions) }

// Expands the reserved "*" sentinel into every key the current catalog
// declares; a concrete grant list passes through unchanged.
export function expandPermissions(permissions, allKeys) {
  return permissions.includes('*') ? allKeys : permissions
}

export async function createInvite({ email }) {
  if (!email) throw new Error('createInvite: email is required')
  const [row] = await db('whitebox_oauth_users')
    .insert({
      id: randomUUID(), email: email.toLowerCase().trim(), permissions: JSON.stringify([]),
      invite_token: opaqueToken(), invite_expires_at: new Date(Date.now() + INVITE_TTL_SEC * 1000),
      invited_at: new Date(),
    })
    .returning([...USER_COLUMNS, 'invite_token'])
  return normalizeUser(row)
}

// Whether the table has any row at all (admin, pending invite, anyone) —
// the signal oauth's register() uses to decide whether it's safe to
// auto-bootstrap an admin from ADMIN_EMAIL/ADMIN_PASSWORD: only a truly
// fresh install has zero rows, so this fires at most once ever, regardless
// of how many times the server restarts with those env vars still set.
export async function hasAnyUser() {
  const row = await db('whitebox_oauth_users').select(['id']).first()
  return !!row
}

export async function listUsers() {
  const rows = await db('whitebox_oauth_users').select([...USER_COLUMNS, 'password_hash']).orderBy('created_at', 'asc')
  return rows.map(({ password_hash, ...rest }) => ({ ...normalizeUser(rest), active: password_hash != null }))
}

// Shape-consistent with one row of listUsers() (active + never the hash) —
// so any route echoing getUser()'s result back to the client (permissions,
// profile edits, …) is a drop-in match for what GET /users already showed,
// not a narrower shape that silently blanks fields out on merge.
export async function getUser(id) {
  const row = await db('whitebox_oauth_users').select([...USER_COLUMNS, 'password_hash']).where({ id }).first()
  if (!row) return null
  const { password_hash, ...rest } = row
  return { ...normalizeUser(rest), active: password_hash != null }
}

export async function deleteUser(id) {
  const n = await db('whitebox_oauth_users').where({ id }).del()
  return n === 1
}

export async function touchLastAccess(id) {
  await db('whitebox_oauth_users').where({ id }).update({ last_access_at: new Date() })
}

// Replaces the user's grant set wholesale — matches the admin UI's "set
// these permissions" mental model, no diffing.
export async function setPermissions(id, permissions) {
  const n = await db('whitebox_oauth_users').where({ id }).update({ permissions: JSON.stringify(permissions) })
  return n === 1
}

// Whether some OTHER active (password-set) user holds users:manage. Guards
// against ever reaching zero holders of it — unlike every other permission,
// losing the last users:manage grant can't be undone from within the running
// product (nobody left could grant it back); only re-running
// scripts/create-admin.mjs against the database directly could recover it.
export async function hasOtherActiveManager(excludeUserId) {
  const rows = await db('whitebox_oauth_users').select(['id', 'permissions', 'password_hash'])
  return rows.some(r => {
    if (r.id === excludeUserId || r.password_hash == null) return false
    const perms = readPermissions(r.permissions)
    return perms.includes('*') || perms.includes('users:manage')
  })
}

// Admin-editable profile fields (any subset). email is normalized the same
// way as everywhere else (lowercase/trim) — a duplicate throws the DB's own
// unique-violation, which the route maps to 409 rather than a raw 500.
export async function updateProfile(id, { firstName, lastName, phone, email } = {}) {
  const patch = {}
  if (firstName !== undefined) patch.first_name = firstName?.trim() || null
  if (lastName !== undefined) patch.last_name = lastName?.trim() || null
  if (phone !== undefined) patch.phone = phone?.trim() || null
  if (email !== undefined) {
    if (!email?.trim()) throw new Error('updateProfile: email cannot be empty')
    patch.email = email.toLowerCase().trim()
  }
  if (!Object.keys(patch).length) return getUser(id)
  const n = await db('whitebox_oauth_users').where({ id }).update(patch)
  if (n === 0) return null
  return getUser(id)
}

// Only meaningful for a still-pending (no password) user — refreshes the
// token/expiry so an old, possibly-expired invite link doesn't linger as the
// only way in.
export async function regenerateInvite(id) {
  const n = await db('whitebox_oauth_users')
    .where({ id, password_hash: null })
    .update({ invite_token: opaqueToken(), invite_expires_at: new Date(Date.now() + INVITE_TTL_SEC * 1000) })
  if (n !== 1) return null
  return normalizeUser(await db('whitebox_oauth_users').select([...USER_COLUMNS, 'invite_token']).where({ id }).first())
}
