// PKCE (RFC 7636), S256 only — the plain method is deliberately unsupported:
// it exists in the spec for constrained clients that can't compute SHA-256,
// which doesn't describe any client this server expects to serve, and
// accepting it would let a network observer who captures the authorization
// request replay the code without ever needing the verifier.

import { createHash } from 'node:crypto'

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function challengeFromVerifier(codeVerifier) {
  return base64url(createHash('sha256').update(codeVerifier).digest())
}

export function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false
  return challengeFromVerifier(codeVerifier) === codeChallenge
}
