// Password hashing — Node's built-in scrypt (no native dependency, unlike
// bcrypt/argon2). N=16384/r=8/p=1 is the scrypt-recommended interactive-login
// cost as of 2024; keylen 64 matches scrypt's typical derived-key length.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)
const KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS)
  return { hash: derived.toString('hex'), salt }
}

async function verifyPassword(password, hash, salt) {
  const derived = await scrypt(password, salt, KEYLEN, SCRYPT_OPTS)
  const stored = Buffer.from(hash, 'hex')
  // scrypt's output length is fixed by KEYLEN, but a corrupted/foreign hash
  // value could still be some other length — guard before timingSafeEqual,
  // which throws (not returns false) on a length mismatch.
  if (derived.length !== stored.length) return false
  return timingSafeEqual(derived, stored)
}

let db

export function init(deps) {
  db = deps.db
}

// `permissions` defaults to no grants at all — scripts/create-admin.mjs is
// the one caller that passes ['*'] (the reserved "everything" sentinel), to
// bootstrap the very first user with enough access to grant everyone else's.
export async function createUser({ email, password, permissions = [] }) {
  if (!email || !password) throw new Error('createUser: email and password are required')
  const { hash, salt } = await hashPassword(password)
  const [row] = await db('whitebox_oauth_users')
    .insert({ id: randomUUID(), email: email.toLowerCase().trim(), password_hash: hash, password_salt: salt, permissions: JSON.stringify(permissions) })
    .returning(['id', 'email', 'permissions'])
  return { ...row, permissions }
}

export async function verifyCredentials(email, password) {
  const user = await db('whitebox_oauth_users').where({ email: email.toLowerCase().trim() }).first()
  if (!user || !user.password_hash) return null   // pending invite — no password set yet
  const ok = await verifyPassword(password, user.password_hash, user.password_salt)
  return ok ? { id: user.id, email: user.email } : null
}

export async function getByInviteToken(token) {
  const user = await db('whitebox_oauth_users')
    .where({ invite_token: token })
    .andWhere('invite_expires_at', '>', new Date())
    .first()
  return user ? { email: user.email } : null
}

// Single-use, same atomic-guard pattern as store.redeemCode/revokeRefreshToken:
// only succeeds while the token is still live and the account is still
// pending, so a replayed accept-invite request (or a token reused after
// someone already completed it) can't win a race or set the password twice.
// firstName/lastName/phone are self-reported here — this is the one point in
// the flow where the account materializes with real user-supplied info.
// defaultPermissions is a SNAPSHOT of each plugin's declared defaults at this
// exact moment — materialized onto the row, not recomputed later, so a
// plugin changing its defaults afterward doesn't retroactively change
// already-onboarded users.
export async function completeInvite({ token, password, firstName, lastName, phone, defaultPermissions = [] }) {
  if (!token || !password) throw new Error('completeInvite: token and password are required')
  if (password.length < 12) throw new Error('completeInvite: password must be at least 12 characters')
  const { hash, salt } = await hashPassword(password)
  const n = await db('whitebox_oauth_users')
    .where({ invite_token: token, password_hash: null })
    .andWhere('invite_expires_at', '>', new Date())
    .update({
      password_hash: hash, password_salt: salt, invite_token: null, invite_expires_at: null,
      first_name: firstName?.trim() || null, last_name: lastName?.trim() || null, phone: phone?.trim() || null,
      permissions: JSON.stringify(defaultPermissions),
    })
  return n === 1
}
