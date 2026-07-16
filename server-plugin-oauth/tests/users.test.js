import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeDb } from './fakeDb.js'
import * as users from '../src/users.js'

let db
beforeEach(() => {
  db = makeFakeDb()
  users.init({ db })
})

describe('users — password hashing (scrypt)', () => {
  it('creates a user and verifies the right password', async () => {
    await users.createUser({ email: 'Jane@Example.com', password: 'correct horse battery staple' })
    const user = await users.verifyCredentials('jane@example.com', 'correct horse battery staple')
    expect(user).toMatchObject({ email: 'jane@example.com' })
    expect(user.id).toBeTruthy()
  })

  it('email is case- and whitespace-normalized', async () => {
    await users.createUser({ email: '  Jane@Example.com  ', password: 'correct horse battery staple' })
    expect(await users.verifyCredentials('jane@example.com', 'correct horse battery staple')).not.toBeNull()
  })

  it('rejects the wrong password', async () => {
    await users.createUser({ email: 'jane@example.com', password: 'correct horse battery staple' })
    expect(await users.verifyCredentials('jane@example.com', 'wrong password')).toBeNull()
  })

  it('rejects an unknown email', async () => {
    expect(await users.verifyCredentials('nobody@example.com', 'anything')).toBeNull()
  })

  it('never stores the password in plain text', async () => {
    await users.createUser({ email: 'jane@example.com', password: 'correct horse battery staple' })
    const row = db._rows('whitebox_oauth_users')[0]
    expect(row.password_hash).not.toContain('correct horse battery staple')
  })

  it('throws without email or password', async () => {
    await expect(users.createUser({ email: 'x@x.com' })).rejects.toThrow()
    await expect(users.createUser({ password: 'x' })).rejects.toThrow()
  })

  it('createUser defaults is_admin to false, and persists true when set', async () => {
    const normal = await users.createUser({ email: 'a@x.com', password: 'correct horse battery staple' })
    expect(normal.is_admin).toBe(false)
    const admin = await users.createUser({ email: 'b@x.com', password: 'correct horse battery staple', isAdmin: true })
    expect(admin.is_admin).toBe(true)
  })
})

describe('users — invite-only registration', () => {
  function seedPendingUser(overrides = {}) {
    const row = {
      id: 'u1', email: 'invitee@example.com', password_hash: null, password_salt: null,
      is_admin: false, invite_token: 'tok123', invite_expires_at: new Date(Date.now() + 60_000),
      invited_at: new Date(), created_at: new Date(), ...overrides,
    }
    db._rows('whitebox_oauth_users').push(row)
    return row
  }

  it('a pending user (no password yet) never verifies, even with any password', async () => {
    seedPendingUser()
    expect(await users.verifyCredentials('invitee@example.com', 'anything at all')).toBeNull()
  })

  it('getByInviteToken returns the email for a live token, null for unknown/expired', async () => {
    seedPendingUser()
    expect(await users.getByInviteToken('tok123')).toEqual({ email: 'invitee@example.com' })
    expect(await users.getByInviteToken('does-not-exist')).toBeNull()

    seedPendingUser({ id: 'u2', email: 'expired@example.com', invite_token: 'tok-expired', invite_expires_at: new Date(Date.now() - 1000) })
    expect(await users.getByInviteToken('tok-expired')).toBeNull()
  })

  it('completeInvite sets a working password and consumes the token — single use', async () => {
    seedPendingUser()
    expect(await users.completeInvite({ token: 'tok123', password: 'correct horse battery staple' })).toBe(true)
    expect(await users.verifyCredentials('invitee@example.com', 'correct horse battery staple')).toMatchObject({ email: 'invitee@example.com' })

    // Replaying the same token must fail — it was consumed, and the account is no longer pending.
    expect(await users.completeInvite({ token: 'tok123', password: 'another password entirely' })).toBe(false)
  })

  it('completeInvite rejects an expired token', async () => {
    seedPendingUser({ invite_expires_at: new Date(Date.now() - 1000) })
    expect(await users.completeInvite({ token: 'tok123', password: 'correct horse battery staple' })).toBe(false)
  })

  it('completeInvite enforces the same minimum password length as CLI-created users', async () => {
    seedPendingUser()
    await expect(users.completeInvite({ token: 'tok123', password: 'short' })).rejects.toThrow()
  })
})
