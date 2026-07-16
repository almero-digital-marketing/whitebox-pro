import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeDb } from './fakeDb.js'
import * as store from '../src/store.js'

let db
beforeEach(() => {
  db = makeFakeDb()
  store.init({ db })
})

describe('store — clients', () => {
  it('redirect_uri must match exactly — no prefix/wildcard matching', async () => {
    const client = await store.createClient({ name: 'App', redirectUris: ['https://app.com/callback'] })
    expect(store.redirectUriAllowed(client, 'https://app.com/callback')).toBe(true)
    expect(store.redirectUriAllowed(client, 'https://app.com/callback/extra')).toBe(false)
    expect(store.redirectUriAllowed(client, 'https://app.com/callbac')).toBe(false)
    expect(store.redirectUriAllowed(client, 'https://evil.com/callback')).toBe(false)
  })

  it('throws without a name or a non-empty redirectUris array', async () => {
    await expect(store.createClient({ redirectUris: ['https://x/y'] })).rejects.toThrow()
    await expect(store.createClient({ name: 'App', redirectUris: [] })).rejects.toThrow()
  })
})

describe('store — authorization codes (single-use)', () => {
  it('a code redeems exactly once — a second redemption fails', async () => {
    const code = await store.createCode({
      clientId: 'c1', userId: 'u1', redirectUri: 'https://x/cb', codeChallenge: 'ch', scope: 's',
    })
    expect(await store.redeemCode(code)).toBe(true)
    expect(await store.redeemCode(code)).toBe(false)   // already used
  })

  it('an unknown code is not found', async () => {
    expect(await store.getCode('does-not-exist')).toBeFalsy()
  })
})

describe('store — refresh tokens (rotation)', () => {
  it('a token revokes exactly once — a second revocation attempt fails (replay detection)', async () => {
    const token = await store.createRefreshToken({ clientId: 'c1', userId: 'u1', scope: 's', ttlSec: 100 })
    expect(await store.revokeRefreshToken(token)).toBe(true)
    expect(await store.revokeRefreshToken(token)).toBe(false)   // replay of an already-rotated token
  })

  it('records the replacement token when provided', async () => {
    const oldToken = await store.createRefreshToken({ clientId: 'c1', userId: 'u1', scope: 's', ttlSec: 100 })
    const newToken = await store.createRefreshToken({ clientId: 'c1', userId: 'u1', scope: 's', ttlSec: 100 })
    await store.revokeRefreshToken(oldToken, newToken)
    const row = await store.getRefreshToken(oldToken)
    expect(row.replaced_by).toBe(newToken)
  })
})
