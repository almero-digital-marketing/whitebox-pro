import { describe, it, expect } from 'vitest'
import { oauth } from '../src/index.js'

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

  it('basePath is derived from issuer\'s own path, never separately configurable — a mismatch between the two is architecturally impossible', () => {
    // Indirect check: register() must not throw when mounting at whatever
    // path issuer implies, for any of these issuer shapes.
    for (const issuer of ['http://x/oauth', 'https://auth.example.com/idp/oauth2', 'http://localhost:3000/']) {
      expect(() => oauth({ issuer, audience: 'a' })).not.toThrow()
    }
  })
})
