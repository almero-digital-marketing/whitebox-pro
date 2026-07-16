import { describe, it, expect } from 'vitest'
import { challengeFromVerifier, verifyPkce } from '../src/pkce.js'

describe('PKCE (S256)', () => {
  it('a challenge derived from a verifier verifies against it', () => {
    const verifier = 'a-random-verifier-at-least-43-chars-long-per-rfc7636'
    const challenge = challengeFromVerifier(verifier)
    expect(verifyPkce(verifier, challenge)).toBe(true)
  })

  it('rejects a mismatched verifier', () => {
    const challenge = challengeFromVerifier('the-real-verifier')
    expect(verifyPkce('a-different-guess', challenge)).toBe(false)
  })

  it('rejects a missing verifier or challenge', () => {
    expect(verifyPkce(undefined, 'x')).toBe(false)
    expect(verifyPkce('x', undefined)).toBe(false)
  })

  it('produces a base64url string with no padding (RFC 7636 §4.2)', () => {
    const challenge = challengeFromVerifier('anything')
    expect(challenge).not.toMatch(/[+/=]/)
  })
})
