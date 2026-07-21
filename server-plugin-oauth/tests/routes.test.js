import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { makeFakeDb } from './fakeDb.js'
import * as store from '../src/store.js'
import * as users from '../src/users.js'
import * as keys from '../src/keys.js'
import { mountRoutes } from '../src/routes.js'
import { challengeFromVerifier } from '../src/pkce.js'

const ISSUER_PATH = '/oauth'
const AUDIENCE = 'https://whitebox/api'
const APP_URL = 'https://app.example.com'
// A minimal two-module catalog — enough to exercise "each module declares its
// own permissions + defaults" without pulling in the real analytics plugin.
const PERMISSIONS_CATALOG = [
  { module: 'analytics', items: [{ key: 'analytics:use', label: 'Use Analytics', description: 'Ask questions and view reports' }], defaults: ['analytics:use'] },
  { module: 'oauth', items: [{ key: 'users:manage', label: 'Manage users & permissions', description: 'Invite, remove, and set permissions for teammates' }], defaults: [] },
]
let server, base, issuer, db, client, verifier, challenge, sentEmails

beforeEach(async () => {
  db = makeFakeDb()
  store.init({ db })
  users.init({ db })
  keys.init({ db })

  sentEmails = []
  const app = express()
  const logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {} }

  // The port must be known BEFORE issuer is set, and issuer must be REAL and
  // reachable (not a placeholder) — the admin routes use the actual jwt()
  // verifier from whitebox-pro-auth-auth0, which fetches JWKS over HTTP from
  // `${issuer}/.well-known/jwks.json`. Express allows mounting routes after
  // listen() starts, so: listen first, then mount with the now-known address.
  server = http.createServer(app)
  await new Promise(r => server.listen(0, r))
  base = `http://localhost:${server.address().port}`
  issuer = `${base}${ISSUER_PATH}`

  mountRoutes(app, {
    basePath: ISSUER_PATH, issuer, audience: AUDIENCE, logger,
    appUrl: APP_URL, fromEmail: 'noreply@example.com',
    getMail: () => ({ send: async (msg) => { sentEmails.push(msg) } }),
    permissionsCatalog: PERMISSIONS_CATALOG,
  })

  // jane: a plain member with no permissions granted. admin: the '*' bootstrap
  // sentinel, which expandPermissions() turns into every key in the catalog above.
  await users.createUser({ email: 'jane@example.com', password: 'correct horse battery staple' })
  await users.createUser({ email: 'admin@example.com', password: 'correct horse battery staple', permissions: ['*'] })
  client = await store.createClient({ name: 'Test Client', redirectUris: ['https://app.example.com/callback'] })

  verifier = 'a-random-code-verifier-at-least-43-characters-long-per-spec'
  challenge = challengeFromVerifier(verifier)
})

afterEach(() => server.close())

function authorizeUrl(overrides = {}) {
  const params = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://app.example.com/callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp:use',
    ...overrides,
  })
  return `${base}${ISSUER_PATH}/authorize?${params}`
}

async function login({ email = 'jane@example.com', password = 'correct horse battery staple', overrides = {} } = {}) {
  const params = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://app.example.com/callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp:use',
    email, password, ...overrides,
  })
  return fetch(`${base}${ISSUER_PATH}/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  })
}

async function getAuthCode() {
  const res = await login()
  const location = new URL(res.headers.get('location'))
  return location.searchParams.get('code')
}

// Full authorize+token round trip for arbitrary credentials/scope — used to
// get a REAL, signature-verified access token for the admin-route tests,
// exactly as a client would, rather than hand-crafting a JWT.
async function tokenFor({ email, password, scope }) {
  const v = 'another-random-code-verifier-at-least-43-characters-long-per-spec'
  const c = challengeFromVerifier(v)
  const params = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://app.example.com/callback',
    code_challenge: c, code_challenge_method: 'S256', state: 'xyz', scope, email, password,
  })
  const authRes = await fetch(`${base}${ISSUER_PATH}/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const code = new URL(authRes.headers.get('location')).searchParams.get('code')
  const tokenRes = await fetch(`${base}${ISSUER_PATH}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
      code_verifier: v, client_id: client.client_id,
    }),
  })
  return (await tokenRes.json()).access_token
}

describe('discovery + JWKS', () => {
  it('serves RFC 8414 discovery metadata', async () => {
    const res = await fetch(`${base}${ISSUER_PATH}/.well-known/oauth-authorization-server`)
    const body = await res.json()
    expect(body).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('serves a JWKS with the public key only', async () => {
    const res = await fetch(`${base}${ISSUER_PATH}/.well-known/jwks.json`)
    const body = await res.json()
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).not.toHaveProperty('d')
  })
})

describe('GET /authorize — validation before anything else', () => {
  it('rejects an unknown client_id without redirecting anywhere', async () => {
    const res = await fetch(authorizeUrl({ client_id: 'not-a-real-client' }))
    expect(res.status).toBe(400)
  })

  it('rejects an unregistered redirect_uri without redirecting anywhere (open-redirect protection)', async () => {
    const res = await fetch(authorizeUrl({ redirect_uri: 'https://evil.example.com/steal' }))
    expect(res.status).toBe(400)
  })

  it('redirects back with an error when PKCE is missing, once client/redirect_uri are valid', async () => {
    const res = await fetch(authorizeUrl({ code_challenge: '', code_challenge_method: '' }), { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location'))
    expect(loc.origin + loc.pathname).toBe('https://app.example.com/callback')
    expect(loc.searchParams.get('error')).toBe('invalid_request')
  })

  it('renders a login form on a valid request', async () => {
    const res = await fetch(authorizeUrl())
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('name="email"')
    expect(html).toContain(`name="client_id" value="${client.client_id}"`)
  })
})

describe('POST /authorize — login', () => {
  it('wrong password redirects back to redirect_uri with an error (so a caller with its own login page can show it there)', async () => {
    const res = await login({ password: 'wrong' })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location'))
    expect(loc.origin + loc.pathname).toBe('https://app.example.com/callback')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('xyz')
  })

  it('correct credentials redirect to redirect_uri with a code + the original state', async () => {
    const res = await login()
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location'))
    expect(loc.origin + loc.pathname).toBe('https://app.example.com/callback')
    expect(loc.searchParams.get('code')).toBeTruthy()
    expect(loc.searchParams.get('state')).toBe('xyz')
  })
})

describe('POST /token — authorization_code grant', () => {
  it('exchanges a valid code + verifier for a JWT that verifies against the published JWKS', async () => {
    const code = await getAuthCode()
    const res = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
        code_verifier: verifier, client_id: client.client_id,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.refresh_token).toBeTruthy()

    const { keys: jwkList } = await keys.jwks()
    const JWKS = createLocalJWKSet({ keys: jwkList })
    const { payload } = await jwtVerify(body.access_token, JWKS, {
      issuer, audience: AUDIENCE,
    })
    // jane's /authorize request asked for scope 'mcp:use' (this suite's default,
    // set in login()'s params below), but the server computes the real scope
    // from her actual stored permissions — which are empty — never from what
    // was requested. This IS the mandatory fix: see the dedicated describe
    // block further down for the adversarial version of this same assertion.
    expect(payload.scope).toBe('')
  })

  it('rejects a wrong PKCE verifier', async () => {
    const code = await getAuthCode()
    const res = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
        code_verifier: 'the-wrong-verifier-entirely-not-matching', client_id: client.client_id,
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a redirect_uri that does not match what /authorize used', async () => {
    const code = await getAuthCode()
    const res = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/DIFFERENT',
        code_verifier: verifier, client_id: client.client_id,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects reusing an already-redeemed code', async () => {
    const code = await getAuthCode()
    const exchange = () => fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
        code_verifier: verifier, client_id: client.client_id,
      }),
    })
    expect((await exchange()).status).toBe(200)
    expect((await exchange()).status).toBe(400)   // replay
  })
})

describe('POST /token — refresh_token grant (rotation)', () => {
  async function exchangeCode() {
    const code = await getAuthCode()
    const res = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
        code_verifier: verifier, client_id: client.client_id,
      }),
    })
    return res.json()
  }

  it('rotates: the old refresh token stops working after use', async () => {
    const first = await exchangeCode()
    const refresh = () => fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: client.client_id }),
    })
    const second = await refresh()
    expect(second.status).toBe(200)
    const secondBody = await second.json()
    expect(secondBody.refresh_token).not.toBe(first.refresh_token)

    // Replaying the ORIGINAL refresh token again must fail — it was consumed.
    const replay = await refresh()
    expect(replay.status).toBe(400)
  })

  it('rejects an unknown refresh token', async () => {
    const res = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'not-a-real-token', client_id: client.client_id }),
    })
    expect(res.status).toBe(400)
  })
})

describe('/users — gated by the users:manage permission (per-module grants, no role system)', () => {
  // The requested scope here is deliberately whatever — it's never trusted;
  // the server always computes the real scope from each user's actual
  // stored permissions (admin: '*' → every catalog key; jane: none).
  async function adminToken() {
    return tokenFor({ email: 'admin@example.com', password: 'correct horse battery staple', scope: 'irrelevant' })
  }
  async function memberToken() {
    return tokenFor({ email: 'jane@example.com', password: 'correct horse battery staple', scope: 'irrelevant' })
  }

  it('rejects with no token, and with a token that lacks users:manage', async () => {
    const noAuth = await fetch(`${base}${ISSUER_PATH}/users`)
    expect(noAuth.status).toBe(401)

    const memberAuth = await fetch(`${base}${ISSUER_PATH}/users`, { headers: { authorization: `Bearer ${await memberToken()}` } })
    expect(memberAuth.status).toBe(403)
  })

  it('GET /me works for any authenticated user regardless of scope, and reports their expanded permissions', async () => {
    const memberMe = await fetch(`${base}${ISSUER_PATH}/me`, { headers: { authorization: `Bearer ${await memberToken()}` } })
    expect(memberMe.status).toBe(200)
    expect((await memberMe.json())).toMatchObject({ email: 'jane@example.com', permissions: [] })

    const adminMe = await fetch(`${base}${ISSUER_PATH}/me`, { headers: { authorization: `Bearer ${await adminToken()}` } })
    // admin holds the raw '*' sentinel — /me expands it to every real catalog key.
    expect((await adminMe.json())).toMatchObject({ email: 'admin@example.com', permissions: ['analytics:use', 'users:manage'] })
  })

  it('admin can invite, list, resend, and remove a user — non-admin rejected on the same routes', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }

    const invite = await fetch(`${base}${ISSUER_PATH}/users/invite`, {
      method: 'POST', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@example.com' }),
    })
    expect(invite.status).toBe(201)
    const invited = await invite.json()
    expect(invited.email).toBe('newbie@example.com')
    expect(invited.inviteUrl).toContain(APP_URL)
    expect(invited).not.toHaveProperty('invite_token')   // never leaks the raw token in the response body's own field name
    expect(invited.permissions).toEqual([])   // defaults are only materialized at accept-invite time, not invite time
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0].to).toBe('newbie@example.com')

    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    expect(list.map(u => u.email)).toEqual(expect.arrayContaining(['jane@example.com', 'admin@example.com', 'newbie@example.com']))
    expect(list.find(u => u.email === 'newbie@example.com').active).toBe(false)
    expect(list.every(u => !('password_hash' in u))).toBe(true)

    const resend = await fetch(`${base}${ISSUER_PATH}/users/${invited.id}/resend-invite`, { method: 'POST', headers: authHeader })
    expect(resend.status).toBe(200)
    expect(sentEmails).toHaveLength(2)

    const memberAuth = { authorization: `Bearer ${await memberToken()}` }
    expect((await fetch(`${base}${ISSUER_PATH}/users/${invited.id}`, { method: 'DELETE', headers: memberAuth })).status).toBe(403)

    const del = await fetch(`${base}${ISSUER_PATH}/users/${invited.id}`, { method: 'DELETE', headers: authHeader })
    expect(del.status).toBe(204)
  })

  it('an admin cannot remove their own account', async () => {
    const admin = await adminToken()
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: { authorization: `Bearer ${admin}` } })).json()
    const self = list.find(u => u.email === 'admin@example.com')
    const res = await fetch(`${base}${ISSUER_PATH}/users/${self.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } })
    expect(res.status).toBe(400)
  })

  it('resend-invite 409s for a user who already has a password', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const active = list.find(u => u.email === 'jane@example.com')
    const res = await fetch(`${base}${ISSUER_PATH}/users/${active.id}/resend-invite`, { method: 'POST', headers: authHeader })
    expect(res.status).toBe(409)
  })

  it('GET /permissions/catalog returns the full aggregated catalog', async () => {
    const admin = await adminToken()
    const res = await fetch(`${base}${ISSUER_PATH}/permissions/catalog`, { headers: { authorization: `Bearer ${admin}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(PERMISSIONS_CATALOG)
  })

  it('PUT /users/:id/permissions replaces a user\'s grants wholesale', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    const res = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['analytics:use'] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).permissions).toEqual(['analytics:use'])
  })

  it('PUT /users/:id/permissions rejects unknown keys, including the "*" bootstrap sentinel itself', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    const bogus = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['not-a-real-key'] }),
    })
    expect(bogus.status).toBe(400)

    // '*' is bootstrap-only (scripts/create-admin.mjs) — never settable through
    // this or any other API, so a non-catalog-key check rejects it for free.
    const wildcard = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['*'] }),
    })
    expect(wildcard.status).toBe(400)
  })

  it('cannot strip users:manage from the only active user who holds it, but can once someone else has it', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const adminRow = list.find(u => u.email === 'admin@example.com')
    const jane = list.find(u => u.email === 'jane@example.com')

    // admin holds '*' and is the only active user with users:manage — removing
    // it from themselves (down to a concrete list without it) must fail.
    const blocked = await fetch(`${base}${ISSUER_PATH}/users/${adminRow.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['analytics:use'] }),
    })
    expect(blocked.status).toBe(400)

    // grant jane users:manage too — now admin is no longer the only holder
    await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['users:manage'] }),
    })

    const allowed = await fetch(`${base}${ISSUER_PATH}/users/${adminRow.id}/permissions`, {
      method: 'PUT', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['analytics:use'] }),
    })
    expect(allowed.status).toBe(200)
  })

  it('non-admin is rejected on both permissions routes', async () => {
    const memberAuth = { authorization: `Bearer ${await memberToken()}` }
    expect((await fetch(`${base}${ISSUER_PATH}/permissions/catalog`, { headers: memberAuth })).status).toBe(403)
    expect((await fetch(`${base}${ISSUER_PATH}/users/some-id/permissions`, {
      method: 'PUT', headers: { ...memberAuth, 'content-type': 'application/json' }, body: JSON.stringify({ permissions: [] }),
    })).status).toBe(403)
  })

  it('PATCH /users/:id updates profile fields (any subset)', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    const res = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}`, {
      method: 'PATCH', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Jane', last_name: 'Doe' }),
    })
    expect(res.status).toBe(200)
    const updated = await res.json()
    expect(updated).toMatchObject({ first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' })

    // a subsequent partial patch (phone only) doesn't clobber the fields set above
    const res2 = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}`, {
      method: 'PATCH', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+1 555 0100' }),
    })
    expect((await res2.json())).toMatchObject({ first_name: 'Jane', last_name: 'Doe', phone: '+1 555 0100' })
  })

  it('PATCH /users/:id rejects a duplicate email with 409, not a raw 500', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    const res = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}`, {
      method: 'PATCH', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com' }),   // already taken
    })
    expect(res.status).toBe(409)
  })

  it('PATCH /users/:id 404s for an unknown user, and non-admin is rejected', async () => {
    const admin = await adminToken()
    const missing = await fetch(`${base}${ISSUER_PATH}/users/does-not-exist`, {
      method: 'PATCH', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'X' }),
    })
    expect(missing.status).toBe(404)

    const memberAuth = { authorization: `Bearer ${await memberToken()}` }
    const rejected = await fetch(`${base}${ISSUER_PATH}/users/some-id`, {
      method: 'PATCH', headers: { ...memberAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'X' }),
    })
    expect(rejected.status).toBe(403)
  })

  it('GET /users/:id/logins records a real login (authorization_code grant) but never a silent refresh', async () => {
    const admin = await adminToken()
    const authHeader = { authorization: `Bearer ${admin}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: authHeader })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    // one login so far, from memberToken() in the beforeEach of earlier tests in this
    // suite — establish a clean baseline by logging in fresh here instead of assuming one.
    const before = await (await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/logins`, { headers: authHeader })).json()
    const baseline = before.length

    const v = 'yet-another-random-code-verifier-at-least-43-characters-long'
    const c = challengeFromVerifier(v)
    const params = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://app.example.com/callback',
      code_challenge: c, code_challenge_method: 'S256', state: 'xyz', scope: 'irrelevant',
      email: 'jane@example.com', password: 'correct horse battery staple',
    })
    const authRes = await fetch(`${base}${ISSUER_PATH}/authorize`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
    })
    const code = new URL(authRes.headers.get('location')).searchParams.get('code')
    // recordLogin (called from handleAuthCodeGrant, triggered by THIS request)
    // reads req.ip/req.get('user-agent') — the header belongs on the /token
    // exchange, not the earlier /authorize request.
    const tokenRes = await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/callback',
        code_verifier: v, client_id: client.client_id,
      }),
    })
    const { refresh_token } = await tokenRes.json()

    const afterLogin = await (await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/logins`, { headers: authHeader })).json()
    expect(afterLogin.length).toBe(baseline + 1)
    expect(afterLogin[0]).toMatchObject({ client_name: 'Test Client', browser: 'Chrome', os: 'macOS' })
    expect(typeof afterLogin[0].ip).toBe('string')
    expect(afterLogin[0].ip.length).toBeGreaterThan(0)

    // a silent refresh must NOT add another row
    await fetch(`${base}${ISSUER_PATH}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: client.client_id }),
    })
    const afterRefresh = await (await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/logins`, { headers: authHeader })).json()
    expect(afterRefresh.length).toBe(baseline + 1)
  })

  it('non-admin is rejected on GET /users/:id/logins', async () => {
    const memberAuth = { authorization: `Bearer ${await memberToken()}` }
    expect((await fetch(`${base}${ISSUER_PATH}/users/some-id/logins`, { headers: memberAuth })).status).toBe(403)
  })
})

describe('token scope is always server-computed, never client-requested (the mandatory security fix)', () => {
  it('requesting an elevated scope at /authorize has zero effect on the issued token', async () => {
    // jane holds no permissions at all, yet asks for 'users:manage' — the one
    // scope that would let her manage every other user's account.
    const forged = await tokenFor({ email: 'jane@example.com', password: 'correct horse battery staple', scope: 'users:manage' })
    const { keys: jwkList } = await keys.jwks()
    const JWKS = createLocalJWKSet({ keys: jwkList })
    const { payload } = await jwtVerify(forged, JWKS, { issuer, audience: AUDIENCE })
    expect(payload.scope).toBe('')   // computed from her actual (empty) grants, not what she asked for

    const res = await fetch(`${base}${ISSUER_PATH}/users`, { headers: { authorization: `Bearer ${forged}` } })
    expect(res.status).toBe(403)
  })

  it('a granted permission takes effect on the NEXT token issuance, not retroactively on an already-issued one', async () => {
    const adminTok = await tokenFor({ email: 'admin@example.com', password: 'correct horse battery staple', scope: 'irrelevant' })
    const adminAuth = { authorization: `Bearer ${adminTok}` }
    const list = await (await fetch(`${base}${ISSUER_PATH}/users`, { headers: adminAuth })).json()
    const jane = list.find(u => u.email === 'jane@example.com')

    // Get jane a token BEFORE the grant — this is the one she'll keep using.
    const beforeGrant = await tokenFor({ email: 'jane@example.com', password: 'correct horse battery staple', scope: 'irrelevant' })

    const grant = await fetch(`${base}${ISSUER_PATH}/users/${jane.id}/permissions`, {
      method: 'PUT', headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['analytics:use'] }),
    })
    expect(grant.status).toBe(200)

    const { keys: jwkList } = await keys.jwks()
    const JWKS = createLocalJWKSet({ keys: jwkList })
    const stale = (await jwtVerify(beforeGrant, JWKS, { issuer, audience: AUDIENCE })).payload
    expect(stale.scope).toBe('')   // the already-issued token is unaffected — matches the accepted ≤1h-lag tradeoff

    // A FRESH token issuance (a new login here — a refresh would work identically,
    // since issueTokens() always recomputes from current DB state either way).
    const afterGrant = await tokenFor({ email: 'jane@example.com', password: 'correct horse battery staple', scope: 'irrelevant' })
    const fresh = (await jwtVerify(afterGrant, JWKS, { issuer, audience: AUDIENCE })).payload
    expect(fresh.scope).toBe('analytics:use')
  })
})

describe('/invite/:token — public accept-invite flow', () => {
  it('a real invitee can look up their email, set a password, and then log in with it', async () => {
    const invited = await store.createInvite({ email: 'setup@example.com' })

    const lookup = await fetch(`${base}${ISSUER_PATH}/invite/${invited.invite_token}`)
    expect(lookup.status).toBe(200)
    expect((await lookup.json()).email).toBe('setup@example.com')

    const accept = await fetch(`${base}${ISSUER_PATH}/invite/${invited.invite_token}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a brand new password here' }),
    })
    expect(accept.status).toBe(204)

    // The token is single-use — a second accept must fail.
    const replay = await fetch(`${base}${ISSUER_PATH}/invite/${invited.invite_token}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a different password entirely' }),
    })
    expect(replay.status).toBe(400)

    // ...and the account can now log in for real, through the normal flow.
    const loginRes = await login({ email: 'setup@example.com', password: 'a brand new password here' })
    expect(loginRes.status).toBe(302)
    expect(new URL(loginRes.headers.get('location')).searchParams.get('code')).toBeTruthy()
  })

  it('accepting an invite seeds permissions from the catalog\'s current defaults', async () => {
    const invited = await store.createInvite({ email: 'defaults@example.com' })
    await fetch(`${base}${ISSUER_PATH}/invite/${invited.invite_token}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a brand new password here' }),
    })
    const user = await store.getUser(invited.id)
    expect(user.permissions).toEqual(['analytics:use'])   // this suite's catalog defaults analytics:use, not users:manage
  })

  it('an unknown or expired token 404s', async () => {
    expect((await fetch(`${base}${ISSUER_PATH}/invite/does-not-exist`)).status).toBe(404)
  })
})
