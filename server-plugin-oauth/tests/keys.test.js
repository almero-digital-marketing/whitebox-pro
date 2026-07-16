import { describe, it, expect, beforeEach } from 'vitest'
import { jwtVerify, createLocalJWKSet } from 'jose'
import { makeFakeDb } from './fakeDb.js'
import * as keys from '../src/keys.js'

let db
beforeEach(() => {
  db = makeFakeDb()
  keys.init({ db })
})

describe('keys — signing key persistence', () => {
  it('generates a key on first use and persists it', async () => {
    await keys.signJwt({ issuer: 'https://x/oauth', audience: 'aud', subject: 'u1', scope: 's', expiresIn: '1h' })
    expect(db._rows('whitebox_oauth_keys')).toHaveLength(1)
  })

  it('reuses the same key across calls — jwks() is stable', async () => {
    const a = await keys.jwks()
    const b = await keys.jwks()
    expect(a).toEqual(b)
    expect(db._rows('whitebox_oauth_keys')).toHaveLength(1)   // only ever generated once
  })

  it('a fresh module instance (simulating a restart) loads the persisted key, not a new one', async () => {
    await keys.jwks()
    const persistedRows = db._rows('whitebox_oauth_keys')
    expect(persistedRows).toHaveLength(1)

    keys.init({ db })   // re-init against the SAME db, as a restart would
    const jwksAfterRestart = await keys.jwks()
    expect(db._rows('whitebox_oauth_keys')).toHaveLength(1)   // did not mint a second key
    expect(jwksAfterRestart.keys[0].kid).toBe(persistedRows[0].kid)
  })

  it('signs a JWT that verifies against the published JWKS (issuer/audience/subject/scope round-trip)', async () => {
    const token = await keys.signJwt({
      issuer: 'https://x/oauth', audience: 'https://whitebox/api', subject: 'user-123', scope: 'mcp:use', expiresIn: '1h',
    })
    const { keys: jwkList } = await keys.jwks()
    const JWKS = createLocalJWKSet({ keys: jwkList })
    const { payload } = await jwtVerify(token, JWKS, { issuer: 'https://x/oauth', audience: 'https://whitebox/api' })
    expect(payload.sub).toBe('user-123')
    expect(payload.scope).toBe('mcp:use')
  })

  it('a token does not verify against the wrong audience', async () => {
    const token = await keys.signJwt({ issuer: 'https://x/oauth', audience: 'aud-a', subject: 'u', expiresIn: '1h' })
    const { keys: jwkList } = await keys.jwks()
    const JWKS = createLocalJWKSet({ keys: jwkList })
    await expect(jwtVerify(token, JWKS, { issuer: 'https://x/oauth', audience: 'aud-b' })).rejects.toThrow()
  })

  it('published public JWK never contains private key material', async () => {
    const { keys: jwkList } = await keys.jwks()
    expect(jwkList[0]).not.toHaveProperty('d')   // 'd' is the EC private scalar
  })
})
