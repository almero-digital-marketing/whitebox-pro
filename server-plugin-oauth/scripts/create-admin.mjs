#!/usr/bin/env node
// Bootstrap the first (or another) user. No UI exists to do this yet — every
// user is created this way.
//
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... node scripts/create-admin.mjs
//   node scripts/create-admin.mjs                 # prompts for both instead
//
// Run from wherever your WB_DB_* env is available (e.g. via
// `node --env-file-if-exists=.env scripts/create-admin.mjs` from the server's
// working directory, or `npm run create-admin` from this package).

import readline from 'node:readline/promises'
import { connect } from './db.mjs'
import * as users from '../src/users.js'

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer
}

async function main() {
  const email = process.env.ADMIN_EMAIL || await prompt('Email: ')
  const password = process.env.ADMIN_PASSWORD || await prompt('Password (visible — pipe ADMIN_PASSWORD instead for a hidden value): ')
  if (!email || !password) throw new Error('email and password are both required')
  if (password.length < 12) throw new Error('password must be at least 12 characters')

  const db = await connect()
  users.init({ db })
  try {
    const user = await users.createUser({ email, password })
    console.log(`Created user ${user.email} (${user.id})`)
  } finally {
    await db.destroy()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
