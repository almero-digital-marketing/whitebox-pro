// Knex queries over whitebox_facts. init + module-singleton, matching the core
// pattern (awareness/store, passports, …). All reads are valid-time: "current"
// is the latest row per key; "as-of D" is the latest row with observed_at <= D.
import { whereScope } from '../db.js'


// WHICH ROW IS CURRENT — one rule, stated once, because it is applied in seven
// queries here and two more in selector/metric.js.
//
//   order by observed_at, id — both in the SAME direction.
//
// `observed_at` alone does not decide it. Two rows legitimately share an instant: a
// CRM sync writing a corrected value in the same batch, a backfill stamping a whole
// import with one timestamp. On live data 1,914 (passport, key) pairs have two or
// more rows at their newest instant, and for 38 of them those rows hold DIFFERENT
// values — so `distinct on` with an incomplete ORDER BY picks arbitrarily, and
// Postgres is free to pick differently between plans.
//
// It was incomplete here and complete in metric.js, which meant the fact PREDICATE
// and the fact BUCKET could disagree about the same customer's current value —
// exactly what the comment above joinFact promises they never do. currentForPairs
// feeds no-op suppression, so the same divergence could also suppress a write that
// was not a no-op, or keep one that was.
//
// `id` is monotonic per insert, so among rows sharing an instant the one written
// last wins. That is the only reading with a defensible meaning: later-known.

const TABLE = 'whitebox_facts'

let db

export function init(deps) {
  db = deps.db
}

// The conflict target must REPEAT the index's WHERE clause. Postgres infers
// which unique index an ON CONFLICT refers to from the target, and a partial
// index is only inferable when the predicate is given too — `ON CONFLICT
// (source, external_id, key, observed_at)` alone raises "there is no unique or
// exclusion constraint matching the ON CONFLICT specification". Knex's
// .onConflict([columns]) cannot express a predicate, so this is raw.
const CONFLICT_TARGET = '(source, external_id, key, observed_at) WHERE external_id IS NOT NULL'

// `resolve` belongs to the caller, and there is deliberately no default: only
// the writer knows whether a repeat means "I already told you this" (skip) or
// "what I told you was wrong" (replace). Omitted, a conflicting row throws —
// loud, and only reachable by a writer that opted in by sending external_id.
function withResolve(q, resolve) {
  if (resolve === 'skip') return q.onConflict(db.raw(CONFLICT_TARGET)).ignore()
  if (resolve === 'replace') return q.onConflict(db.raw(CONFLICT_TARGET)).merge()
  return q
}

// `.returning('*')` returns FEWER rows than were sent when resolve is 'skip' —
// a skipped row returns nothing at all. Callers counting the result are counting
// rows written, not rows accepted, and the two stopped being the same number here.
export async function insert(row, { resolve } = {}) {
  const [out] = await withResolve(db(TABLE).insert(row), resolve).returning('*')
  return out
}

// Many rows, one statement. Chunked because a bulk fact can carry thousands of
// passports and every row here binds 7 parameters — Postgres caps a single
// statement at 65535 of them.
const CHUNK = 2000
export async function insertMany(rows, { resolve } = {}) {
  if (!rows?.length) return []
  const out = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    out.push(...await withResolve(db(TABLE).insert(rows.slice(i, i + CHUNK)), resolve).returning('*'))
  }
  return out
}

// The CURRENT row for each of a set of (passport_id, key) pairs, in ONE query —
// the read half of no-op suppression (see facts/index.js `suppressNoOps`).
//
// Over-fetches slightly: it filters on the DISTINCT sets rather than the exact
// pairs, so N passports × M keys can return more rows than pairs asked for. That
// is deliberate — the exact-pair form is a VALUES join that plans worse, and the
// dominant callers are "one passport, a few keys" (a session hook) or "many
// passports, one key" (a bulk tag), where the two are identical. The
// (passport_id, key, observed_at) index serves it either way.
export async function currentForPairs(pairs) {
  if (!pairs?.length) return []
  const passportIds = [...new Set(pairs.map(p => p.passport_id))]
  const keys = [...new Set(pairs.map(p => p.key))]
  return db(TABLE)
    .distinctOn(['passport_id', 'key'])
    .whereIn('passport_id', passportIds)
    .whereIn('key', keys)
    .orderBy([{ column: 'passport_id' }, { column: 'key' }, { column: 'observed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('*')
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
    .orderBy([{ column: 'key' }, { column: 'observed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
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
    .orderBy([{ column: 'key' }, { column: 'observed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('key', 'value', 'type', 'observed_at')
}

// The full timeline of one key, oldest first — for transitions / history.
export async function historyRows(passportId, key) {
  return db(TABLE)
    .where({ passport_id: passportId, key })
    .orderBy([{ column: 'observed_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('value', 'type', 'observed_at', 'source')
}

// --- population (across passports), for the selector's filter.fact ---

// Current (or as-of `at`) value of `key` for every passport, optionally
// restricted to `scope` (passport ids). One row per passport.
// `derive` — a { sql, binds } expression (see facts/computed.js) selected AS the
// value instead of the stored one. The query still reads the SOURCE key's rows; the
// caller substitutes that key. Derived in SQL rather than in JS after the fetch so
// the predicate path and the grouped path share one definition of "age".
export async function currentByKey(key, { at, scope, derive } = {}) {
  let q = db(TABLE).distinctOn('passport_id').where({ key })
  if (at) q = q.where('observed_at', '<=', at)
  if (scope?.length) q = whereScope(q, 'passport_id', scope)
  q = q.orderBy([{ column: 'passport_id' }, { column: 'observed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
  return derive
    ? q.select('passport_id', db.raw(`${derive.sql} as value`, derive.binds), 'observed_at')
    : q.select('passport_id', 'value', 'observed_at')   // observed_at = the matched_at for a value-op match
}

/**
 * Passports whose CURRENT value for `key` is absent — no row at all, or a row
 * whose value is JSON null. The answer to `{ exists: false }`.
 *
 * It needs its own query because every other read here starts FROM whitebox_facts,
 * so it can only ever enumerate passports that HAVE a row for the key. Filtering
 * those rows for absence therefore returned the passports with a recorded-empty
 * value and nobody else — on live data, `{ present: false }` answered 0 where the
 * truth was 494. Zero looks like a real answer, which is what made it worth
 * finding: the caller had already worked around it with a sentinel date.
 *
 * Anchored on whitebox_passports instead, with an anti-join, so "never had it" is
 * expressible at all. An empty string is NOT absence — matchValue treats '' as a
 * value — so only JSON null counts here, and the two agree.
 */
export async function absentByKey(key, { at, scope, derive } = {}) {
  const valueSql = derive ? derive.sql : 'value'
  const binds = derive ? derive.binds : []
  let cur = db(TABLE).distinctOn('passport_id').where({ key })
  if (at) cur = cur.where('observed_at', '<=', at)
  cur = cur
    .orderBy([{ column: 'passport_id' }, { column: 'observed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('passport_id', db.raw(`${valueSql} as value`, binds))

  let q = db('whitebox_passports as p')
    .leftJoin(cur.as('cur'), 'cur.passport_id', 'p.id')
    .whereRaw('(cur.passport_id is null or cur.value is null)')
    .select('p.id as passport_id')
  if (scope?.length) q = whereScope(q, 'p.id', scope)
  return (await q).map(r => r.passport_id)
}

// Every row for `key` (optionally up to `at`, restricted to `scope`), ordered so
// the caller can group into per-passport histories for temporal operators.
export async function keyRows(key, { at, scope, derive } = {}) {
  let q = db(TABLE).where({ key })
  if (at) q = q.where('observed_at', '<=', at)
  if (scope?.length) q = whereScope(q, 'passport_id', scope)
  q = q.orderBy([{ column: 'passport_id' }, { column: 'observed_at', order: 'asc' }, { column: 'id', order: 'asc' }])
  return derive
    ? q.select('passport_id', db.raw(`${derive.sql} as value`, derive.binds), 'observed_at')
    : q.select('passport_id', 'value', 'observed_at')
}
