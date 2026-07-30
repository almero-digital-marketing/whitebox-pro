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

describe('store — users (invites, per-module permission grants)', () => {
  it('createInvite makes a pending user (no password) with a live token and no permissions yet', async () => {
    const invited = await store.createInvite({ email: 'new@example.com' })
    expect(invited.email).toBe('new@example.com')
    expect(invited.invite_token).toBeTruthy()
    expect(invited.permissions).toEqual([])
    const row = db._rows('whitebox_oauth_users').find(r => r.id === invited.id)
    expect(row.password_hash).toBeFalsy()
  })

  it('listUsers reports active:false for a pending invite and active:true once a password is set, never the hash', async () => {
    await store.createInvite({ email: 'pending@example.com' })
    db._rows('whitebox_oauth_users').push({
      id: 'u-active', email: 'active@example.com', password_hash: 'h', password_salt: 's',
      permissions: JSON.stringify([]), created_at: new Date(),
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
      permissions: JSON.stringify([]), created_at: new Date(),
    })
    expect(await store.regenerateInvite('u-active2')).toBeNull()   // not pending — nothing to resend
  })

  it('deleteUser removes exactly the targeted row', async () => {
    const invited = await store.createInvite({ email: 'gone@example.com' })
    expect(await store.deleteUser(invited.id)).toBe(true)
    expect(await store.getUser(invited.id)).toBeFalsy()
    expect(await store.deleteUser(invited.id)).toBe(false)   // already gone
  })

  it('setPermissions replaces a user\'s grant set wholesale', async () => {
    const invited = await store.createInvite({ email: 'grantee@example.com' })
    expect(await store.setPermissions(invited.id, ['analytics:use', 'audiences:use'])).toBe(true)
    expect((await store.getUser(invited.id)).permissions).toEqual(['analytics:use', 'audiences:use'])
    expect(await store.setPermissions(invited.id, ['analytics:use'])).toBe(true)   // overwrites, doesn't merge
    expect((await store.getUser(invited.id)).permissions).toEqual(['analytics:use'])
  })

  it('setPermissions on an unknown id reports failure', async () => {
    expect(await store.setPermissions('does-not-exist', ['analytics:use'])).toBe(false)
  })

  it('hasOtherActiveManager only counts ACTIVE users:manage/"*" holders, excluding the given id', async () => {
    db._rows('whitebox_oauth_users').push(
      { id: 'u-solo', email: 'solo@example.com', password_hash: 'h', password_salt: 's', permissions: JSON.stringify(['users:manage']), created_at: new Date() },
      // a pending invite holding users:manage doesn't count — they can't log in yet
      { id: 'u-pending', email: 'pending-mgr@example.com', password_hash: null, permissions: JSON.stringify(['users:manage']), created_at: new Date() },
      // an active user with no relevant permission doesn't count either
      { id: 'u-other', email: 'other@example.com', password_hash: 'h', password_salt: 's', permissions: JSON.stringify(['analytics:use']), created_at: new Date() },
    )
    expect(await store.hasOtherActiveManager('u-solo')).toBe(false)

    db._rows('whitebox_oauth_users').push(
      { id: 'u-wildcard', email: 'wildcard@example.com', password_hash: 'h', password_salt: 's', permissions: JSON.stringify(['*']), created_at: new Date() },
    )
    expect(await store.hasOtherActiveManager('u-solo')).toBe(true)   // '*' counts too
    expect(await store.hasOtherActiveManager('u-wildcard')).toBe(true)   // u-solo still counts
  })
})

describe('store — expandPermissions (the "*" bootstrap sentinel)', () => {
  it('a concrete grant list passes through unchanged', () => {
    expect(store.expandPermissions(['analytics:use'], ['analytics:use', 'audiences:use', 'users:manage'])).toEqual(['analytics:use'])
  })

  it('"*" expands to every key in the current catalog', () => {
    const allKeys = ['analytics:use', 'audiences:use', 'campaigns:use', 'users:manage']
    expect(store.expandPermissions(['*'], allKeys)).toEqual(allKeys)
  })

  // The catalog only contains what REGISTERED plugins declared, so filtering
  // through it is what makes "this deployment doesn't have that plugin" and
  // "you may not use it" the same answer — which is what the UI's module gate
  // reads. Without this a stale grant survives and the module's icon shows
  // while every one of its calls 404s.
  it('drops a grant whose plugin is not in the catalog', () => {
    const allKeys = ['analytics:read', 'users:manage']   // audiences plugin not registered
    expect(store.expandPermissions(['analytics:read', 'audiences:read'], allKeys)).toEqual(['analytics:read'])
  })

  it('drops it for a wildcard holder too, not just an explicit one', () => {
    const allKeys = ['analytics:read', 'users:manage']
    expect(store.expandPermissions(['*'], allKeys)).not.toContain('audiences:read')
  })

  it('leaves nothing when the catalog is empty', () => {
    expect(store.expandPermissions(['analytics:read'], [])).toEqual([])
    expect(store.expandPermissions(['*'], [])).toEqual([])
  })
})

describe('store — searchUsers (the paged rail read)', () => {
  // createInvite is how a user row comes into existence — an invite with no
  // password yet, which is also the `active: false` case worth covering.
  const seed = async (n) => {
    for (let i = 0; i < n; i++) await store.createInvite({ email: `u${String(i).padStart(2, '0')}@example.com` })
  }

  it('returns one page plus the REAL total, not the page length', async () => {
    await seed(7)
    const { total, rows } = await store.searchUsers({ limit: 3 })
    expect(total).toBe(7)          // what the pager needs to say "1 of 3"
    expect(rows).toHaveLength(3)
  })

  it('offset walks the pages without repeating or skipping a row', async () => {
    await seed(7)
    const seen = []
    for (let off = 0; off < 7; off += 3) {
      seen.push(...(await store.searchUsers({ limit: 3, offset: off })).rows.map(u => u.email))
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('narrows on email, case-insensitively, and the total narrows with it', async () => {
    await store.createInvite({ email: 'Ada@Example.com' })
    await store.createInvite({ email: 'grace@example.com' })
    const { total, rows } = await store.searchUsers({ q: 'ADA' })
    expect(total).toBe(1)
    expect(rows[0].email).toBe('ada@example.com')
  })

  // the whole reason listUsers() selects the hash and then drops it
  it('never leaks password_hash, and still derives active from it', async () => {
    const invited = await store.createInvite({ email: 'pending@example.com' })
    const { rows } = await store.searchUsers({})
    expect(rows.every(u => !('password_hash' in u))).toBe(true)
    // no password yet → pending, which is only knowable from the hash the
    // projection selects and then drops
    expect(rows.find(u => u.email === 'pending@example.com').active).toBe(false)
    // setting a password lives in users.js; at the STORE layer "has a password"
    // is just the column being non-null, which is exactly what active reads
    await db('whitebox_oauth_users').where({ id: invited.id }).update({ password_hash: 'hashed' })
    const after = await store.searchUsers({ q: 'pending' })
    expect(after.rows[0].active).toBe(true)
  })
})

// Shape assertions here stay EXACT — two of them assert the ABSENCE of a key
// ("never flags it" means no `severity`), which toMatchObject would stop checking.
// So the prose is dropped, not the strictness; that every metric HAS prose is its
// own test below.
const shape = (m) => { const { description, ...rest } = m || {}; return rest }

describe('store — status (self-describing health)', () => {
  const HOUR = 60 * 60 * 1000
  const since = new Date(Date.now() - 24 * HOUR)

  // recordLogin() leaves created_at to the DB default, which the fake db can't
  // supply — seed the column explicitly, since the window IS what's under test.
  const seedLogin = (createdAt) =>
    db._rows('whitebox_oauth_logins').push({ id: `l-${Math.random()}`, user_id: 'u1', client_id: 'c1', created_at: createdAt })

  it('windows logins by created_at', async () => {
    seedLogin(new Date(Date.now() - HOUR))
    seedLogin(new Date(Date.now() - 2 * HOUR))
    seedLogin(new Date(Date.now() - 40 * 24 * HOUR))   // before the window
    const s = await store.status({ since })
    expect(s.label).toBe('oauth')
    expect(shape(s.metrics.find(m => m.key === 'logins'))).toEqual({ key: 'logins', value: 2 })
  })

  it('counts a live invite as pending and never flags it', async () => {
    await store.createInvite({ email: 'pending@example.com' })
    const s = await store.status({ since })
    // `live` because "who is locked out right now" has no window — password_hash
    // IS NULL is a state, not an event with a timestamp.
    expect(shape(s.metrics.find(m => m.key === 'invites pending')))
      .toEqual({ key: 'invites pending', value: 1, live: true })
    expect(s.metrics.find(m => m.key === 'invites expired').value).toBe(0)
    expect(s.note).toBeNull()
  })

  // the one thing here that is actually broken: they can't accept any more
  // (users.completeInvite requires invite_expires_at > now), and can't fix it
  it('flags a lapsed invite as bad, with an actionable note', async () => {
    const stale = await store.createInvite({ email: 'stale@example.com' })
    await store.createInvite({ email: 'fresh@example.com' })
    await db('whitebox_oauth_users').where({ id: stale.id }).update({ invite_expires_at: new Date(Date.now() - HOUR) })

    const s = await store.status({ since })
    expect(shape(s.metrics.find(m => m.key === 'invites expired')))
      .toEqual({ key: 'invites expired', value: 1, severity: 'bad', live: true })
    expect(s.metrics.find(m => m.key === 'invites pending').value).toBe(1)   // the expired one isn't double-counted
    expect(s.note).toMatch(/1 invite expired/)
  })

  it('ignores users who already accepted — an active account is not an outstanding invite', async () => {
    const invited = await store.createInvite({ email: 'done@example.com' })
    await db('whitebox_oauth_users').where({ id: invited.id })
      .update({ password_hash: 'hashed', invite_token: null, invite_expires_at: null })
    const s = await store.status({ since })
    expect(s.metrics.find(m => m.key === 'invites pending').value).toBe(0)
    expect(s.metrics.find(m => m.key === 'invites expired').value).toBe(0)
  })

  // logins are activity, not health — a busy day must not read as a problem
  it('marks only expired invites as bad', async () => {
    seedLogin(new Date())
    const s = await store.status({ since })
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['invites expired'])
  })

  it('never throws — a dead db returns a partial answer instead of taking the board down', async () => {
    store.init({ db: () => { throw new Error('connection terminated') } })
    const s = await store.status({ since })
    expect(s).toEqual({ label: 'oauth', metrics: [], note: 'oauth state could not be read' })
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md). The guard that
// stops the next metric shipping as a bare key.
describe('store — status descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    const s = await store.status({ since: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) {
      // Rendered inline in a 340px pane, so length IS the constraint: one line.
      expect(m.description.length).toBeLessThanOrEqual(56)
      // ...and it must still say more than the key already does.
      expect(m.description.toLowerCase()).not.toBe(m.key.toLowerCase())
      expect(m.description.length).toBeGreaterThan(12)
    }
  })
})
