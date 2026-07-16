// Standalone DB connection for the CLI scripts — this package isn't running
// inside a booted WhiteBox server here, so it connects itself using the same
// WB_DB_* env vars the main server reads, then runs its own migration (in
// case this script is the very first thing ever run against a fresh DB).

import knex from 'knex'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function connect() {
  const db = knex({
    client: 'pg',
    connection: {
      host: process.env.WB_DB_HOST || 'localhost',
      port: Number(process.env.WB_DB_PORT || 5432),
      database: process.env.WB_DB_NAME || 'whitebox',
      user: process.env.WB_DB_USER || 'whitebox',
      password: process.env.WB_DB_PASSWORD || '',
      // Opt-in — a hosted Postgres (Neon, RDS, …) typically requires SSL; a
      // plain local dev instance typically doesn't support it at all, so this
      // must not be on unconditionally. Matches whitebox.config.js's own
      // `db.ssl` for whichever DB the main server is pointed at.
      ssl: process.env.WB_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    },
    pool: { min: 1, max: 2 },
  })
  await db.migrate.latest({
    directory: path.join(__dirname, '..', 'src', 'migrations'),
    tableName: 'whitebox_oauth_migrations',
  })
  return db
}
