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

describe('store — users (invites, no role system)', () => {
  it('createInvite makes a pending user (no password) with a live token', async () => {
    const invited = await store.createInvite({ email: 'new@example.com' })
    expect(invited.email).toBe('new@example.com')
    expect(invited.invite_token).toBeTruthy()
    expect(invited.is_admin).toBe(false)
    const row = db._rows('whitebox_oauth_users').find(r => r.id === invited.id)
    expect(row.password_hash).toBeFalsy()
  })

  it('listUsers reports active:false for a pending invite and active:true once a password is set, never the hash', async () => {
    await store.createInvite({ email: 'pending@example.com' })
    db._rows('whitebox_oauth_users').push({
      id: 'u-active', email: 'active@example.com', password_hash: 'h', password_salt: 's',
      is_admin: false, created_at: new Date(),
    })
    const list = await store.listUsers()
    expect(list.find(u => u.email === 'pending@example.com').active).toBe(false)
    expect(list.find(u => u.email === 'active@example.com').active).toBe(true)
    expect(list.every(u => !('password_hash' in u))).toBe(true)
  })

  it('regenerateInvite only succeeds for a still-pending user, and issues a fresh token', async () => {
    const invited = await store.createInvite({ email: 'resend@example.com' })
    const first = invited.invite_token
    const regenerated = await store.regenerateInvite(invited.id)
    expect(regenerated.invite_token).toBeTruthy()
    expect(regenerated.invite_token).not.toBe(first)

    db._rows('whitebox_oauth_users').push({
      id: 'u-active2', email: 'already@example.com', password_hash: 'h', password_salt: 's',
      is_admin: false, created_at: new Date(),
    })
    expect(await store.regenerateInvite('u-active2')).toBeNull()   // not pending — nothing to resend
  })

  it('deleteUser removes exactly the targeted row', async () => {
    const invited = await store.createInvite({ email: 'gone@example.com' })
    expect(await store.deleteUser(invited.id)).toBe(true)
    expect(await store.getUser(invited.id)).toBeFalsy()
    expect(await store.deleteUser(invited.id)).toBe(false)   // already gone
  })
})
