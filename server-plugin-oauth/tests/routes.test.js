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
let server, base, db, client, verifier, challenge

beforeEach(async () => {
  db = makeFakeDb()
  store.init({ db })
  users.init({ db })
  keys.init({ db })

  const app = express()
  const logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {} }
  mountRoutes(app, { basePath: ISSUER_PATH, issuer: `http://placeholder${ISSUER_PATH}`, audience: AUDIENCE, logger })
  server = http.createServer(app)
  await new Promise(r => server.listen(0, r))
  base = `http://localhost:${server.address().port}`

  await users.createUser({ email: 'jane@example.com', password: 'correct horse battery staple' })
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

describe('discovery + JWKS', () => {
  it('serves RFC 8414 discovery metadata', async () => {
    const res = await fetch(`${base}${ISSUER_PATH}/.well-known/oauth-authorization-server`)
    const body = await res.json()
    expect(body).toMatchObject({
      issuer: `http://placeholder${ISSUER_PATH}`,
      authorization_endpoint: `http://placeholder${ISSUER_PATH}/authorize`,
      token_endpoint: `http://placeholder${ISSUER_PATH}/token`,
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
  it('wrong password re-renders the form with an error, does not redirect', async () => {
    const res = await login({ password: 'wrong' })
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('Incorrect email or password')
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
      issuer: `http://placeholder${ISSUER_PATH}`, audience: AUDIENCE,
    })
    expect(payload.scope).toBe('mcp:use')
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
