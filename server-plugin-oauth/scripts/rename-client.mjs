#!/usr/bin/env node
// Rename a registered OAuth client, and list what is registered.
//
//   node scripts/rename-client.mjs                                    # list every client
//   node scripts/rename-client.mjs --client-id=<uuid> --name="GPoint WhiteBox"
//
// This exists because a client's name is no longer an internal label. The sign-in page shows
// it to the user — "to give <name> access" — so it is the only thing telling someone WHAT
// they are handing their permissions to. A name that was fine as a note to self ("gpoint
// console", "test client") reads as sloppy or, worse, unrecognisable on a consent screen.
//
// A script rather than a hand-written UPDATE, because the alternative is an ad-hoc query
// against a production database — the thing this repo is meant to make unnecessary. Renaming
// changes nothing about authorization: the client_id, redirect URIs and issued tokens are
// untouched.

import { connect } from './db.mjs'
import * as store from '../src/store.js'

const TABLE = 'whitebox_oauth_clients'

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg)
    if (!m) continue
    const [, key, value] = m
    if (key === 'client-id') out.clientId = value
    else if (key === 'name') out.name = value
  }
  return out
}

async function list(db) {
  const rows = await db(TABLE).select('client_id', 'name').orderBy('name')
  console.log(`${rows.length} client(s):`)
  for (const r of rows) {
    // Flagged, because this is the one name the sign-in page deliberately does NOT show —
    // the console signing its own users in isn't a third party being granted access.
    const own = r.client_id === store.CONSOLE_CLIENT_ID ? '  (the console itself — name not shown at sign-in)' : ''
    console.log(`  ${String(r.name ?? '(no name)').padEnd(28)} ${r.client_id}${own}`)
  }
}

async function main() {
  const { clientId, name } = parseArgs(process.argv.slice(2))
  const db = await connect()
  store.init({ db })
  try {
    // `await`, not `return list(db)`: returning the promise exits the try block immediately,
    // so `finally` destroys the pool while the query is still in flight and the listing dies
    // mid-read. Awaiting keeps the connection alive until it has actually printed.
    if (!clientId && !name) { await list(db); return }
    if (!clientId || !name) throw new Error('both --client-id and --name are required to rename')

    const before = await db(TABLE).where({ client_id: clientId }).first()
    if (!before) throw new Error(`no client with client_id ${clientId}`)

    await db(TABLE).where({ client_id: clientId }).update({ name })
    // Re-read rather than trusting the update's return: .returning() is Postgres-specific,
    // and this has to work against whatever the deployment's driver is.
    const after = await db(TABLE).where({ client_id: clientId }).first()
    console.log(`Renamed ${clientId}`)
    console.log(`  was: ${before.name ?? '(no name)'}`)
    console.log(`  now: ${after.name}`)
    console.log('  redirect_uris unchanged; existing tokens unaffected.')
  } finally {
    await db.destroy()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
