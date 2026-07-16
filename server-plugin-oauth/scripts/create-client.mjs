#!/usr/bin/env node
// Register an OAuth client. Pre-registered clients only — no Dynamic Client
// Registration — so every MCP client / app that needs to log in against this
// server needs one run of this first.
//
//   node scripts/create-client.mjs --name="Claude Desktop" \
//     --redirect-uri="http://localhost:PORT/callback" \
//     --redirect-uri="https://claude.ai/api/mcp/oauth/callback"
//
// Prints the client_id — there is no client_secret (every client is public;
// PKCE is what proves possession of the original authorization request).

import { connect } from './db.mjs'
import * as store from '../src/store.js'

function parseArgs(argv) {
  const out = { redirectUris: [] }
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg)
    if (!m) continue
    const [, key, value] = m
    if (key === 'redirect-uri') out.redirectUris.push(value)
    else if (key === 'name') out.name = value
  }
  return out
}

async function main() {
  const { name, redirectUris } = parseArgs(process.argv.slice(2))
  if (!name) throw new Error('--name is required')
  if (!redirectUris.length) throw new Error('at least one --redirect-uri is required')

  const db = await connect()
  store.init({ db })
  try {
    const client = await store.createClient({ name, redirectUris })
    console.log(`Created client "${client.name}"`)
    console.log(`  client_id: ${client.client_id}`)
    console.log(`  redirect_uris: ${redirectUris.join(', ')}`)
  } finally {
    await db.destroy()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
