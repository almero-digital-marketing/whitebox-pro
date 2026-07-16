// JWT signing key — generated once on first boot and persisted, so restarts
// (and every replica sharing the same DB) keep signing with — and publishing
// via JWKS — the exact same key. A fresh key per boot would silently
// invalidate every outstanding access/refresh token and desync the JWKS
// response across replicas. ES256 (P-256): short tokens, fast verify, and
// jose's most broadly interoperable asymmetric alg for this use case.

import { generateKeyPair, exportJWK, importJWK, SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'

let db
let cached = null   // { kid, privateKey, publicJwk }

export function init(deps) {
  db = deps.db
  cached = null
}

async function loadOrCreateKey() {
  if (cached) return cached

  const existing = await db('whitebox_oauth_keys').where({ singleton: 'active' }).first()
  if (existing) {
    const privateKey = await importJWK(JSON.parse(existing.private_jwk), 'ES256')
    cached = { kid: existing.kid, privateKey, publicJwk: JSON.parse(existing.public_jwk) }
    return cached
  }

  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const kid = randomUUID()
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' }

  // The `singleton` UNIQUE constraint (not `kid`, which is different on every
  // attempt) is what makes this race-safe: if another process already won,
  // this insert is silently dropped and the re-read below picks up ITS key —
  // every process converges on one winner regardless of insert order.
  await db('whitebox_oauth_keys')
    .insert({ singleton: 'active', kid, public_jwk: JSON.stringify(publicJwk), private_jwk: JSON.stringify(privateJwk) })
    .onConflict('singleton').ignore()

  return loadOrCreateKey()
}

export async function signJwt({ issuer, audience, subject, scope, expiresIn = '1h' }) {
  const { kid, privateKey } = await loadOrCreateKey()
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

export async function jwks() {
  const { publicJwk } = await loadOrCreateKey()
  return { keys: [publicJwk] }
}
