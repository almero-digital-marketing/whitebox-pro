import { randomBytes, randomUUID } from 'node:crypto'
import { pagedList } from 'whitebox-pro-server/pagination'

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

// The first-party console's client, with a WELL-KNOWN id rather than a generated one.
//
// The console is shipped as a published package (whitebox-pro-ui), so its client_id cannot
// be a per-install UUID: it would have to be baked in at build time, and the build happens
// once, for everyone. A stable id is safe here — clients are public (no secret), PKCE proves
// possession of the original request, and redirect_uri is still matched exactly against the
// list below, so a predictable id grants nothing on its own.
//
// Idempotent, and it MERGES redirect URIs rather than replacing them: a deployment that
// moves its appUrl should keep working on the old one until DNS and links catch up, and an
// operator who added a URI by hand must not silently lose it on the next boot.
export const CONSOLE_CLIENT_ID = 'whitebox-console'

// `name` comes from config (see index.js) rather than being hardcoded, because it is what a
// deployment calls itself — "GPoint WhiteBox", not "WhiteBox console". Unlike the redirect
// URIs it is REPLACED, not merged: there is one right answer at any moment and config is it,
// so renaming in config takes effect on the next boot instead of needing a script.
export async function ensureConsoleClient({ redirectUris, name = 'WhiteBox console' }) {
  const existing = await getClient(CONSOLE_CLIENT_ID)
  if (!existing) {
    const [row] = await db('whitebox_oauth_clients')
      .insert({ client_id: CONSOLE_CLIENT_ID, name, redirect_uris: JSON.stringify(redirectUris) })
      .returning(['client_id', 'name', 'redirect_uris'])
    return { row, created: true }
  }
  const current = typeof existing.redirect_uris === 'string' ? JSON.parse(existing.redirect_uris) : existing.redirect_uris
  const merged = [...new Set([...(current || []), ...redirectUris])]
  const renamed = existing.name !== name
  if (merged.length === (current || []).length && !renamed) return { row: existing, created: false }
  await db('whitebox_oauth_clients')
    .where({ client_id: CONSOLE_CLIENT_ID })
    .update({ redirect_uris: JSON.stringify(merged), name })
  // Re-read rather than RETURNING: an update's returning clause is Postgres-specific, and
  // reading back is both portable and obviously correct.
  return {
    row: await getClient(CONSOLE_CLIENT_ID),
    created: false,
    added: merged.length - (current || []).length,
    renamed,
  }
}

// Loopback, for both the RFC 8252 §7.3 port relaxation below and RFC 7591 redirect_uri
// validation above. Declared here, ahead of both, so neither depends on a const further down
// the file staying un-evaluated until request time.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function isLoopback(url) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────────────────
//
// Needed for one specific caller: a client with nowhere to put a client_id. The claude.ai /
// Claude Desktop Connectors UI takes a URL and nothing else, so it must register itself or it
// cannot connect at all. Claude Code does not need this — it accepts a pre-registered id, and
// CLI_CLIENT_ID already covers it.
//
// What a newly registered client can do: nothing. It holds no tokens and represents no user.
// It cannot act until a real person signs in on the consent page, and the scopes come from
// that person's own grants — never from what the client requested (see routes.js). So open
// registration does not leak ACCESS; it leaks ROWS, which is why the limits below are about
// volume rather than authorization.
const MAX_REDIRECT_URIS = 10
const MAX_CLIENT_NAME = 255

// Which redirect URIs a self-registering client may claim. Stricter than what an operator can
// enter by hand, deliberately: an operator typing a URI has made a judgement, an anonymous
// POST has not.
//
//   · https  — anywhere. This is the Connectors-UI case (https://claude.ai/...).
//   · http   — LOOPBACK ONLY. A native client cannot present a TLS cert on 127.0.0.1, which
//              is exactly why RFC 8252 allows plain http there and nowhere else.
//
// Everything else is refused, including http on a routable host (a code in cleartext to a
// third party) and private-use schemes like com.example.app:/cb — those are legitimate under
// RFC 8252 §7.1 but they are also unverifiable claims on a namespace, so they stay out until
// something actually needs them.
//
// A fragment is refused outright: RFC 6749 §3.1.2 forbids one in a redirect URI, and it would
// be silently dropped by the browser anyway.
export function validateRedirectUri(value) {
  if (typeof value !== 'string' || !value) return 'must be a string'
  let url
  try { url = new URL(value) } catch { return 'is not an absolute URI' }
  if (url.hash) return 'must not contain a fragment'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname) ? null : 'must use https, except on loopback'
  }
  return `scheme ${url.protocol} is not allowed — use https, or http on loopback`
}

// Throws with an RFC 7591 error code, which routes.js maps straight onto the response body.
class RegistrationError extends Error {
  constructor(code, description) {
    super(description)
    this.code = code
  }
}
export { RegistrationError }

export async function registerDynamicClient({ name, redirectUris, maxClients }) {
  if (!Array.isArray(redirectUris) || !redirectUris.length) {
    throw new RegistrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array')
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw new RegistrationError('invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris`)
  }
  for (const uri of redirectUris) {
    const problem = validateRedirectUri(uri)
    if (problem) throw new RegistrationError('invalid_redirect_uri', `redirect_uri ${JSON.stringify(uri)} ${problem}`)
  }

  // Bounds the table even if the per-IP limit is evaded from many addresses. Counted rather
  // than trusted to a rate limiter because that one lives in process memory and does not
  // survive a restart, while rows do.
  if (maxClients != null) {
    const [{ count }] = await db('whitebox_oauth_clients').where({ dynamic: true }).count({ count: '*' })
    if (Number(count) >= maxClients) {
      throw new RegistrationError('invalid_client_metadata',
        'this server is not accepting new client registrations right now')
    }
  }

  // The name is client-supplied and ends up on the consent page, so it is length-capped here
  // and HTML-escaped at render (routes.js). A client that sends no name gets a neutral one
  // rather than a blank line where the app's identity should be.
  const clientName = (typeof name === 'string' && name.trim())
    ? name.trim().slice(0, MAX_CLIENT_NAME)
    : 'Unnamed client'

  const clientId = randomUUID()
  const [row] = await db('whitebox_oauth_clients')
    .insert({ client_id: clientId, name: clientName, redirect_uris: JSON.stringify(redirectUris), dynamic: true })
    .returning(['client_id', 'name', 'redirect_uris', 'created_at'])
  return row
}

// Deletes self-registered clients that were never used and are past `olderThanDays`.
//
// Only `dynamic: true` rows, and only those with no login recorded against them — an
// operator-registered client that has not been used yet is not garbage, it is a client
// waiting for its user. Codes and refresh tokens cascade on delete (001), so a row with any
// real history is preserved by the login check rather than by luck.
export async function pruneDynamicClients({ olderThanDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  // Two statements rather than one with a subquery: the id list is tiny (one row per client
  // ever used, not per login) and a plain array keeps this working on any driver.
  const used = (await db('whitebox_oauth_logins').distinct('client_id')).map(r => r.client_id)
  return db('whitebox_oauth_clients')
    .where({ dynamic: true })
    .where('created_at', '<', cutoff)
    .whereNotIn('client_id', used)
    .del()
}

// ── which agents a user has connected ───────────────────────────────────────────────────
//
// The association between a client and a user cannot be made at REGISTRATION: that endpoint is
// unauthenticated by necessity (a client needs an id before it can authenticate), so there is
// no identity to attribute. It is made one step later, at the first /authorize — and that is
// the more useful fact anyway. "Who created this row" is uninteresting; "who granted this
// agent their permissions" is the question an operator needs answered.
//
// Both halves are already recorded: whitebox_oauth_logins says a user consented to a client,
// whitebox_oauth_refresh_tokens says that consent is still live. This reads them together so
// the console can show what is connected, and revoke it.
//
// Aggregated in JS rather than with a GROUP BY join: the row counts here are per-user, the
// clients table is small, and it keeps this working on any driver.
export async function listUserAgents(userId) {
  const logins = await db('whitebox_oauth_logins')
    .where({ user_id: userId })
    .select('client_id', 'created_at')
    .orderBy('created_at', 'desc')

  // Live consent, not just history: a token that is revoked or expired no longer grants
  // anything, so counting it as "connected" would overstate what is actually in force.
  const tokens = (await db('whitebox_oauth_refresh_tokens')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .select('client_id', 'expires_at'))
    .filter(t => new Date(t.expires_at) > new Date())

  const byClient = new Map()
  const touch = (id) => {
    if (!byClient.has(id)) byClient.set(id, { client_id: id, logins: 0, last_login: null, active_tokens: 0 })
    return byClient.get(id)
  }
  for (const l of logins) {
    const e = touch(l.client_id)
    e.logins += 1
    // logins arrive newest-first, so the first one seen for a client is its most recent.
    if (!e.last_login) e.last_login = l.created_at
  }
  for (const t of tokens) touch(t.client_id).active_tokens += 1

  const out = []
  for (const entry of byClient.values()) {
    const client = await getClient(entry.client_id)
    out.push({
      ...entry,
      // A client row can be gone (pruned, or deleted by an operator) while its login history
      // remains, so name it rather than rendering a blank.
      name: client?.name ?? '(deleted client)',
      dynamic: !!client?.dynamic,
      connected: entry.active_tokens > 0,
    })
  }
  // Live connections first, then by recency — the ones an operator might want to cut off are
  // the ones still in force.
  return out.sort((a, b) =>
    Number(b.connected) - Number(a.connected) ||
    new Date(b.last_login || 0) - new Date(a.last_login || 0))
}

// Cuts one agent off for one user, and only that pair: revoking a client wholesale would sign
// out every other user of it, and revoking a user wholesale would cut off their console
// session too.
//
// Marks refresh tokens revoked rather than deleting them, matching revokeRefreshToken above —
// the row is the evidence that the consent existed and was withdrawn. Access tokens already
// issued are JWTs and stay valid until they expire (1h); this stops the renewal, which is the
// only thing a resource server can enforce without a revocation check on every request.
export async function revokeUserAgent(userId, clientId) {
  return db('whitebox_oauth_refresh_tokens')
    .where({ user_id: userId, client_id: clientId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() })
}

// The client every command-line/desktop MCP client uses, auto-provisioned like the console's.
//
// This exists so a user's setup is two commands with nothing to paste. Whitebox has no
// Dynamic Client Registration, so without a well-known id an operator has to run
// create-client.mjs and hand each person a UUID — which a customer installing whitebox
// cannot do at all, since it means running a script against someone else's database.
//
// A stable, guessable id is safe for the same reasons CONSOLE_CLIENT_ID is: clients are
// public (no secret), PKCE proves possession of the original request, and redirect_uri is
// still matched — so the id alone grants nothing.
//
// Both loopback spellings are registered because RFC 8252 §8.3 prefers the IP literal while
// many clients still use `localhost`, and redirectUriAllowed() deliberately does NOT treat
// them as interchangeable. The PORT is absent from both, which is the point: with §7.3 port
// matching relaxed, a client that grabs whatever port is free works without anyone
// registering it. Measured, not assumed — with no callbackPort configured, Claude Code took
// :59205.
export const CLI_CLIENT_ID = 'whitebox-cli'
const CLI_REDIRECT_URIS = ['http://localhost/callback', 'http://127.0.0.1/callback']

export async function ensureCliClient({ name = 'Command line (MCP)' } = {}) {
  const existing = await getClient(CLI_CLIENT_ID)
  if (!existing) {
    const [row] = await db('whitebox_oauth_clients')
      .insert({ client_id: CLI_CLIENT_ID, name, redirect_uris: JSON.stringify(CLI_REDIRECT_URIS) })
      .returning(['client_id', 'name', 'redirect_uris'])
    return { row, created: true }
  }
  const current = typeof existing.redirect_uris === 'string' ? JSON.parse(existing.redirect_uris) : existing.redirect_uris
  const merged = [...new Set([...(current || []), ...CLI_REDIRECT_URIS])]
  const renamed = existing.name !== name
  if (merged.length === (current || []).length && !renamed) return { row: existing, created: false }
  await db('whitebox_oauth_clients')
    .where({ client_id: CLI_CLIENT_ID })
    .update({ redirect_uris: JSON.stringify(merged), name })
  return {
    row: await getClient(CLI_CLIENT_ID),
    created: false,
    added: merged.length - (current || []).length,
    renamed,
  }
}

// redirect_uri must match one of the client's registered URIs EXACTLY — no
// prefix/wildcard matching (RFC 6749 §3.1.2, and a classic real-world
// bypass when implementations get this loose).
//
// ONE exception, and it is required rather than a convenience: RFC 8252 §7.3 says the
// authorization server MUST allow any port on a LOOPBACK redirect. A native client — a CLI,
// a desktop app — starts a throwaway HTTP server to catch the code and cannot reserve a port
// in advance; whatever is free at that moment is what it must use. Claude Code's 33418 is
// not an assigned port, just its default, and if something else holds it the client picks
// another.
//
// Without this, a loopback client is only usable if an operator happened to register the
// exact port it happened to get — which is how a real setup ended up with
// `http://localhost:33418/oauth/callback` in a row while the client asked for
// `http://localhost:33418/callback`, failing with a message about registration that said
// nothing about paths or ports.
//
// The relaxation is narrow on purpose. Everything else still has to match exactly, and the
// host must be a literal loopback ADDRESS or `localhost` — never a name that resolves
// somewhere else. Scheme, hostname, path, query and fragment are all still compared; only
// the port is ignored. That is safe because reaching a loopback port means already being on
// the user's machine, and the code is useless there without the PKCE verifier, which never
// left the process that started the flow.
export function redirectUriAllowed(client, redirectUri) {
  const uris = typeof client.redirect_uris === 'string' ? JSON.parse(client.redirect_uris) : client.redirect_uris
  if (!Array.isArray(uris)) return false
  if (uris.includes(redirectUri)) return true

  // Only now, and only for loopback, fall back to a port-insensitive comparison.
  let asked
  try { asked = new URL(redirectUri) } catch { return false }
  if (!isLoopback(asked)) return false

  return uris.some(registered => {
    let reg
    try { reg = new URL(registered) } catch { return false }
    return isLoopback(reg)
      && reg.hostname === asked.hostname
      && reg.pathname === asked.pathname
      && reg.search === asked.search
      && reg.hash === asked.hash
  })
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

// ── health ───────────────────────────────────────────────────────────────
//
// Self-describing health for monitoring surfaces (see docs/10-plugin-status.md).
//
// Deliberately NOT a user count: how many teammates exist is inventory, and a
// login count on its own says nothing is wrong — people signing in is the
// system working. The thing that can actually be WRONG here is somebody who
// should be able to get in and can't:
//
//   pending  — invited, invite still live, hasn't set a password yet. Normal for
//              a day or two, so it's context and never flagged.
//   expired  — invited, the 7-day token lapsed, still no password. That person
//              is locked out and cannot fix it themselves: completeInvite()
//              requires invite_expires_at > now (see users.js), so an admin has
//              to resend (POST /users/:id/resend-invite). Non-zero means someone
//              is stuck right now — the one bad metric.
//
// FAILED logins are deliberately absent. whitebox_oauth_logins holds one row per
// SUCCESSFUL authorization-code redemption and nothing else (migration 005) — a
// wrong password redirects with access_denied and writes no row anywhere, and a
// replayed code/refresh token only returns invalid_grant. There is no failure
// count in this schema to report, and deriving one from the successes would be
// a fabrication.
export async function status({ since } = {}) {
  try {
    // Real logins are history — windowed on created_at.
    let loginsQ = db('whitebox_oauth_logins')
    if (since) loginsQ = loginsQ.where('created_at', '>=', since instanceof Date ? since : new Date(since))
    const [logins] = await loginsQ.count()

    // Invites are CURRENT STATE, not events: "who is locked out right now" has
    // no window, and password_hash IS NULL is itself the pending state
    // (migration 002) rather than something with a timestamp. Fetched as rows
    // and split in JS instead of two more counts — outstanding invites are
    // team-sized, never a scan worth splitting into extra round trips.
    const outstanding = await db('whitebox_oauth_users')
      .select(['invite_expires_at'])
      .where({ password_hash: null })
      .whereNotNull('invite_token')
    const now = Date.now()
    const expired = outstanding.filter(r => r.invite_expires_at && new Date(r.invite_expires_at).getTime() < now).length

    return {
      label: 'oauth',
      metrics: [
        { key: 'logins', value: Number(logins?.count ?? 0),
          description: 'Successful sign-ins to this console' },
        // `live`, matching the query above: "who is locked out right now" has no
        // window, and password_hash IS NULL is a state rather than an event.
        { key: 'invites pending', value: outstanding.length - expired, live: true,
          description: 'Team invites waiting for someone to set a password' },
        { key: 'invites expired', value: expired, severity: 'bad', live: true,
          description: 'Team invites that ran out — resend to let them in' },
      ],
      note: expired
        ? `${expired} invite${expired === 1 ? '' : 's'} expired — those teammates can't set a password until someone resends`
        : null,
    }
  } catch {
    // A broken status() must not take the monitoring board down — a partial
    // answer beats throwing (docs/10-plugin-status.md).
    return { label: 'oauth', metrics: [], note: 'oauth state could not be read' }
  }
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
// `allKeys` is the catalog every REGISTERED plugin declared at boot, so it is
// also the list of what this deployment can actually do. Both branches are
// filtered through it, which makes a grant for an absent plugin unholdable:
// drop the audiences plugin and nobody — wildcard or explicitly granted —
// still carries `audiences:read`, so the UI's permission-gated module icons
// disappear on their own and no second "which plugins exist?" channel is
// needed. It also self-heals grants left behind by a removed or renamed
// plugin, instead of handing out a scope no route will honour.
export function expandPermissions(permissions, allKeys) {
  if (permissions.includes('*')) return allKeys
  return permissions.filter(p => allKeys.includes(p))
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
  return rows.map(hideHash)
}

// One page for the Users rail, with the real total. Ordered created_at ASC like
// listUsers() — a team list reads oldest-first, unlike the campaigns and
// journeys rails where the newest thing is the one you just made.
//
// `password_hash` is selected and then dropped, exactly as above: `active` is
// derived from whether one exists, and there is no other way to know. Losing
// that mapping here would leak the hash into a route that never showed it.
export async function searchUsers(opts = {}) {
  const { total, rows } = await pagedList(
    db('whitebox_oauth_users').select([...USER_COLUMNS, 'password_hash']),
    // The real column names — there is no `name` column, it's split in two.
    // The fake db reads any key off a plain object and shrugs at a missing one,
    // so a wrong column name here is only ever caught against real Postgres.
    { ...opts, fields: ['email', 'first_name', 'last_name'], orderBy: 'created_at', direction: 'asc' },
  )
  return { total, rows: rows.map(hideHash) }
}

const hideHash = ({ password_hash, ...rest }) => ({ ...normalizeUser(rest), active: password_hash != null })

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
