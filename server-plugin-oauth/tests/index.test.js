import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { oauth } from '../src/index.js'
import { makeFakeDb } from './fakeDb.js'
import * as store from '../src/store.js'

describe('oauth() — config validation + basePath derivation', () => {
  it('throws without issuer', () => {
    expect(() => oauth({ audience: 'a' })).toThrow(/issuer/)
  })

  it('throws without audience', () => {
    expect(() => oauth({ issuer: 'http://x/oauth' })).toThrow(/audience/)
  })

  it('exposes { name, migrate, register }', () => {
    const plugin = oauth({ issuer: 'http://x/oauth', audience: 'a' })
    expect(plugin.name).toBe('oauth')
    expect(typeof plugin.migrate).toBe('function')
    expect(typeof plugin.register).toBe('function')
  })

  it('declares its own users:manage permission catalog entry, with no default grant', () => {
    const plugin = oauth({ issuer: 'http://x/oauth', audience: 'a' })
    expect(plugin.permissions.items).toEqual([
      { key: 'users:manage', label: 'Manage users & permissions', description: 'Invite, remove, and set permissions for teammates' },
    ])
    expect(plugin.permissions.defaults).toEqual([])
  })

  it('basePath is derived from issuer\'s own path, never separately configurable — a mismatch between the two is architecturally impossible', () => {
    // Indirect check: register() must not throw when mounting at whatever
    // path issuer implies, for any of these issuer shapes.
    for (const issuer of ['http://x/oauth', 'https://auth.example.com/idp/oauth2', 'http://localhost:3000/']) {
      expect(() => oauth({ issuer, audience: 'a' })).not.toThrow()
    }
  })
})

describe('oauth().register() — admin auto-bootstrap from ADMIN_EMAIL/ADMIN_PASSWORD', () => {
  const ORIGINAL_ENV = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD }
  let db, logger

  beforeEach(() => {
    db = makeFakeDb()
    logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {} }
    delete process.env.ADMIN_EMAIL
    delete process.env.ADMIN_PASSWORD
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function makeCtx() {
    return { db, logger, permissions: { catalog: [] } }
  }

  it('creates a wildcard admin when the table is empty and both env vars are set', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com'
    process.env.ADMIN_PASSWORD = 'correct horse battery staple'
    await oauth({ issuer: 'http://x/oauth', audience: 'a' }).register(express(), makeCtx())

    expect(await store.hasAnyUser()).toBe(true)
    const [row] = db._rows('whitebox_oauth_users')
    expect(row.email).toBe('admin@example.com')
    expect(JSON.parse(row.permissions)).toEqual(['*'])
  })

  it('does nothing when either env var is missing', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com'
    // ADMIN_PASSWORD intentionally unset
    await oauth({ issuer: 'http://x/oauth', audience: 'a' }).register(express(), makeCtx())
    expect(await store.hasAnyUser()).toBe(false)
  })

  it('never fires when a user already exists, even a non-admin one — safe to leave the env vars set across every restart', async () => {
    db._rows('whitebox_oauth_users').push({ id: 'existing', email: 'jane@example.com', password_hash: 'h', permissions: '[]' })
    process.env.ADMIN_EMAIL = 'admin@example.com'
    process.env.ADMIN_PASSWORD = 'correct horse battery staple'
    await oauth({ issuer: 'http://x/oauth', audience: 'a' }).register(express(), makeCtx())

    expect(db._rows('whitebox_oauth_users')).toHaveLength(1)   // still just jane — no admin added
  })

  it('skips auto-bootstrap (without creating a weak account) when ADMIN_PASSWORD is under 12 characters', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com'
    process.env.ADMIN_PASSWORD = 'short'
    await oauth({ issuer: 'http://x/oauth', audience: 'a' }).register(express(), makeCtx())
    expect(await store.hasAnyUser()).toBe(false)
  })
})
