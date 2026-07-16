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
})
