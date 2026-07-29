// Knex queries over whitebox_facts. init + module-singleton, matching the core
// pattern (awareness/store, passports, …). All reads are valid-time: "current"
// is the latest row per key; "as-of D" is the latest row with observed_at <= D.
const TABLE = 'whitebox_facts'

let db

export function init(deps) {
  db = deps.db
}

export async function insert(row) {
  const [out] = await db(TABLE).insert(row).returning('*')
  return out
}

// Many rows, one statement. Chunked because a bulk fact can carry thousands of
// passports and every row here binds 7 parameters — Postgres caps a single
// statement at 65535 of them.
const CHUNK = 2000
export async function insertMany(rows) {
  if (!rows?.length) return []
  const out = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(...await db(TABLE).insert(rows.slice(i, i + CHUNK)).returning('*'))
  }
  return out
}

// Every fact key this deployment has ever recorded. There is no fixed
// vocabulary, so this IS the vocabulary — it's what lets a key field suggest
// `client_status` instead of letting you invent `clientStatus` beside it.
export async function distinctKeys() {
  const rows = await db(TABLE).distinct('key').orderBy('key')
  return rows.map(r => r.key)
}

// Latest value per key for a passport (optionally restricted to `keys`).
// DISTINCT ON (key) + ORDER BY key, observed_at DESC keeps the newest per key.
export async function currentRows(passportId, keys) {
  let q = db(TABLE).distinctOn('key').where({ passport_id: passportId })
  if (keys?.length) q = q.whereIn('key', keys)
  return q
    .orderBy([{ column: 'key' }, { column: 'observed_at', order: 'desc' }])
    .select('key', 'value', 'type', 'observed_at')
}

// Value per key as it was at instant `at` (the newest row not after `at`).
export async function asOfRows(passportId, at, keys) {
  let q = db(TABLE)
    .distinctOn('key')
    .where({ passport_id: passportId })
    .where('observed_at', '<=', at)
  if (keys?.length) q = q.whereIn('key', keys)
  return q
    .orderBy([{ column: 'key' }, { column: 'observed_at', order: 'desc' }])
    .select('key', 'value', 'type', 'observed_at')
}

// The full timeline of one key, oldest first — for transitions / history.
export async function historyRows(passportId, key) {
  return db(TABLE)
    .where({ passport_id: passportId, key })
    .orderBy('observed_at', 'asc')
    .select('value', 'type', 'observed_at', 'source')
}

// --- population (across passports), for the selector's filter.fact ---

// Current (or as-of `at`) value of `key` for every passport, optionally
// restricted to `scope` (passport ids). One row per passport.
export async function currentByKey(key, { at, scope } = {}) {
  let q = db(TABLE).distinctOn('passport_id').where({ key })
  if (at) q = q.where('observed_at', '<=', at)
  if (scope?.length) q = q.whereIn('passport_id', scope)
  return q
    .orderBy([{ column: 'passport_id' }, { column: 'observed_at', order: 'desc' }])
    .select('passport_id', 'value', 'observed_at')   // observed_at = the matched_at for a value-op match
}

// Every row for `key` (optionally up to `at`, restricted to `scope`), ordered so
// the caller can group into per-passport histories for temporal operators.
export async function keyRows(key, { at, scope } = {}) {
  let q = db(TABLE).where({ key })
  if (at) q = q.where('observed_at', '<=', at)
  if (scope?.length) q = q.whereIn('passport_id', scope)
  return q
    .orderBy([{ column: 'passport_id' }, { column: 'observed_at', order: 'asc' }])
    .select('passport_id', 'value', 'observed_at')
}
