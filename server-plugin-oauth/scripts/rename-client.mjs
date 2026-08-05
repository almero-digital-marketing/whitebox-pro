#!/usr/bin/env node
// Rename a registered OAuth client, and list what is registered.
//
//   node scripts/rename-client.mjs                                    # list every client
//   node scripts/rename-client.mjs --client-id=<uuid> --name="GPoint WhiteBox"
//   node scripts/rename-client.mjs --client-id=<uuid> --delete
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
    // Bare flags first: `--delete` carries no value, so a =-only pattern skips it silently and
    // the script falls through to "both --client-id and --name are required to rename" — an
    // error about the wrong thing entirely.
    if (arg === '--delete') { out.del = true; continue }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg)
    if (!m) continue
    const [, key, value] = m
    if (key === 'client-id') out.clientId = value
    else if (key === 'name') out.name = value
    // An unrecognised --flag=value is a typo, not something to ignore: silently doing nothing
    // is how you delete the wrong client and believe you deleted the right one.
    else throw new Error(`unknown option --${key}`)
  }
  return out
}

// Counts are shown because deleting a client is not a local act: whitebox_oauth_logins and
// whitebox_oauth_refresh_tokens both reference client_id with ON DELETE CASCADE, so the row
// takes its login history and its tokens with it. An operator deciding what to prune needs to
// see that before choosing, not after.
async function counts(db, clientId) {
  const [{ count: logins }] = await db('whitebox_oauth_logins').where({ client_id: clientId }).count({ count: '*' })
  const live = (await db('whitebox_oauth_refresh_tokens')
    .where({ client_id: clientId }).whereNull('revoked_at').select('expires_at'))
    .filter(t => new Date(t.expires_at) > new Date()).length
  return { logins: Number(logins), live }
}

async function list(db) {
  const rows = await db(TABLE).select('client_id', 'name').orderBy('name')
  console.log(`${rows.length} client(s):`)
  for (const r of rows) {
    // Flagged, because this is the one name the sign-in page deliberately does NOT show —
    // the console signing its own users in isn't a third party being granted access.
    const own = r.client_id === store.CONSOLE_CLIENT_ID ? '  (the console itself — name not shown at sign-in)' : ''
    const c = await counts(db, r.client_id)
    console.log(`  ${String(r.name ?? '(no name)').padEnd(28)} ${r.client_id}  `
      + `logins=${String(c.logins).padEnd(4)} live_tokens=${String(c.live).padEnd(4)}${own}`)
  }
}

async function main() {
  const { clientId, name, del } = parseArgs(process.argv.slice(2))
  const db = await connect()
  store.init({ db })
  try {
    // `await`, not `return list(db)`: returning the promise exits the try block immediately,
    // so `finally` destroys the pool while the query is still in flight and the listing dies
    // mid-read. Awaiting keeps the connection alive until it has actually printed.
    if (!clientId && !name && !del) { await list(db); return }

    if (del) {
      if (!clientId) throw new Error('--client-id is required to delete')
      const row = await db(TABLE).where({ client_id: clientId }).first()
      if (!row) throw new Error(`no client with client_id ${clientId}`)
      // Refuse the two auto-provisioned ids outright. They are recreated on the next boot, so
      // deleting one achieves nothing except signing out everyone currently using it.
      if (clientId === store.CONSOLE_CLIENT_ID || clientId === store.CLI_CLIENT_ID) {
        throw new Error(`${clientId} is provisioned automatically on boot — deleting it only signs out its current users`)
      }
      const c = await counts(db, clientId)
      await db(TABLE).where({ client_id: clientId }).del()
      console.log(`Deleted ${clientId} (${row.name})`)
      // Stated after the fact because CASCADE already did it — better to name what went than to
      // let someone discover a gap in the login history later and wonder.
      console.log(`  cascaded: ${c.logins} login row(s), ${c.live} live token(s) — both reference`)
      console.log('  client_id with ON DELETE CASCADE')
      return
    }

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
