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

export async function createUser({ email, password }) {
  if (!email || !password) throw new Error('createUser: email and password are required')
  const { hash, salt } = await hashPassword(password)
  const [row] = await db('whitebox_oauth_users')
    .insert({ id: randomUUID(), email: email.toLowerCase().trim(), password_hash: hash, password_salt: salt })
    .returning(['id', 'email'])
  return row
}

export async function verifyCredentials(email, password) {
  const user = await db('whitebox_oauth_users').where({ email: email.toLowerCase().trim() }).first()
  if (!user) return null
  const ok = await verifyPassword(password, user.password_hash, user.password_salt)
  return ok ? { id: user.id, email: user.email } : null
}
