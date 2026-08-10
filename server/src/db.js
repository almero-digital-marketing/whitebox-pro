import knex from 'knex'
import logger from './logger.js'

let db

function init(options) {
  const cfg = options.config.db
  db = knex({
    client: 'pg',
    connection: {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl,
    },
    pool: { min: 2, max: 10 },
    acquireConnectionTimeout: 10000,
  })

  return db.raw('SELECT 1').then(() => {
    logger.info('Database connected: %s:%s/%s', cfg.host, cfg.port, cfg.database)
  })
}

function get() {
  if (!db) throw new Error('Database not initialized')
  return db
}

/**
 * Narrow a query to a set of passports, as ONE bind parameter.
 *
 * `whereIn(col, ids)` binds a placeholder per id, and Postgres accepts at most
 * 65,535 in a message. A board that had run fine for months therefore started
 * answering `bind message has 931 parameter formats but 0 parameters` the day a
 * backfill pushed a cohort past that line — the failure arrives as a protocol
 * error naming neither the query nor the limit, at a size nobody chose.
 *
 * `= any(array)` passes the whole set as a single uuid[] value: one parameter
 * whatever the size, and Postgres still uses the index. Every passport_id in
 * this schema is a uuid, which is what makes the cast safe to hardcode.
 *
 * `column` is INTERPOLATED, so it must be a literal from this codebase and
 * never anything a caller supplied. The ids are bound.
 *
 * @param {import('knex').Knex.QueryBuilder} q
 * @param {string} column   e.g. 'passport_id' or 'e.passport_id'
 * @param {string[]} ids    empty/absent leaves the query untouched
 */
function whereScope(q, column, ids) {
  if (!ids?.length) return q
  return q.whereRaw(`${column} = any(?::uuid[])`, [ids])
}

export { init, get, whereScope }
