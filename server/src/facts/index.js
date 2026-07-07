import path from 'path'
import { fileURLToPath } from 'url'

import * as store from './store.js'
import { matchValue, matchTemporal, temporalMatchedAt, isTemporal } from './operators.js'

// Facts — the core structured memory: an append-only, typed, value-queryable
// per-passport fact timeline (the structured twin of awareness). Channel-
// agnostic: any source writes facts via ctx.facts.record(); the term "crm"
// never appears here. See whitebox-pro-server/docs/temporal-facts.md.
//
// init + module-singleton, matching awareness / passports / sessions.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db
let logger
let passports
let labels

export function init(deps) {
  db = deps.db
  passports = deps.passports
  logger = deps.logger.child({ component: 'facts' })
  store.init({ db })
  // Config always wins: seed from whitebox.config.js's `facts.labels` FIRST, so
  // a plugin's own describe() call (below) — which only sets a key that's still
  // unset — can never override an operator's explicit choice. This is also the
  // only way to label a key no plugin author could ever anticipate, like a
  // user's custom CRM field (whitebox-pro-server-plugin-crm writes arbitrary
  // external field names as fact keys — there's no fixed vocabulary to default).
  labels = new Map(Object.entries(deps.config?.facts?.labels || {}))
}

// Register a human-readable label for a fact key — e.g. a plugin calling
// describe('geo_city', 'City') for a key it owns. First write wins, so a
// config-seeded label (see init() above) is never clobbered by a plugin default.
export function describe(key, humanLabel) {
  if (!labels.has(key)) labels.set(key, humanLabel)
}

// The human label for `key`, or the raw key when nothing is registered.
export function label(key) {
  return labels.get(key) || key
}

// Every registered { key, label } pair — for vocabulary/discovery surfaces (AI
// compose, audience rule authoring) that want to show people a name, not a key.
export function describedKeys() {
  return [...labels.entries()].map(([key, humanLabel]) => ({ key, label: humanLabel }))
}

export async function migrate() {
  await db.migrate.latest({
    directory: path.join(__dirname, 'migrations'),
    tableName: 'whitebox_facts_migrations',
  })
}

// Follow the passport merge chain so an absorbed (merged-away) id maps to its
// survivor everywhere — a stale id never orphans facts under a tombstone.
// No-op when passports isn't wired (unit tests).
async function resolveId(id) {
  return id && passports?.resolve ? passports.resolve(id) : id
}

// Tag a value with its storage type. Callers may pass `type` explicitly
// (adapters usually do); otherwise we infer from the JS value.
function inferType(value) {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'bool'
  if (value instanceof Date) return 'date'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) return 'date'
  return 'string'
}

const asArray = k => (k == null ? undefined : [].concat(k))

// Record one observed fact. `observed_at` defaults to now (valid-time); `type`
// is inferred when omitted. A value change is a new row — nothing is overwritten.
export async function record({ passport_id, key, value, type, source, observed_at, entity } = {}) {
  if (!passport_id) throw new Error('facts.record: passport_id is required')
  if (!key) throw new Error('facts.record: key is required')
  if (value === undefined) throw new Error('facts.record: value is required')

  const pid = await resolveId(passport_id)
  const row = await store.insert({
    passport_id: pid,
    key,
    value: JSON.stringify(value),   // jsonb; node-pg returns it parsed on read
    type: type || inferType(value),
    source: source || 'unknown',
    entity: entity || null,
    observed_at: observed_at ? new Date(observed_at) : new Date(),
  })
  logger?.debug?.({ passport_id: pid, key }, 'fact recorded')
  return row
}

// Current value of every key (or just `keys`) for a passport → { key: value }.
export async function current(passport_id, keys) {
  const pid = await resolveId(passport_id)
  const rows = await store.currentRows(pid, asArray(keys))
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Value of every key (or just `keys`) as it stood at instant `at` → { key: value }.
export async function asOf(passport_id, at, keys) {
  const pid = await resolveId(passport_id)
  const rows = await store.asOfRows(pid, new Date(at), asArray(keys))
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// A single key's value — current, or as of `at`.
export async function get(passport_id, key, { at } = {}) {
  const obj = at ? await asOf(passport_id, at, key) : await current(passport_id, key)
  return obj[key]
}

// The full timeline of one key (oldest first): [{ value, type, observed_at, source }].
export async function history(passport_id, key) {
  const pid = await resolveId(passport_id)
  return store.historyRows(pid, key)
}

// --- predicate evaluation (the read layer the selector's filter.fact uses) ---

// Does one passport's `key` satisfy `predicate` (current, or as of `at`)?
// predicate is a value op (eq/ne/in/gt/gte/lt/lte/within/since/before/present)
// or a temporal op (changed/transition/decreased/increased).
export async function test(passport_id, key, predicate, { at } = {}) {
  const pid = await resolveId(passport_id)
  const now = at ? new Date(at) : new Date()
  if (isTemporal(predicate)) {
    let hist = await store.historyRows(pid, key)
    if (at) hist = hist.filter(r => new Date(r.observed_at) <= now)
    return matchTemporal(hist, predicate, now)
  }
  const rows = at ? await store.asOfRows(pid, now, [key]) : await store.currentRows(pid, [key])
  return matchValue(rows.length ? rows[0].value : undefined, predicate, now)
}

// Population WITH the qualifying-event time: `[{ id, matched_at }]` for every
// passport whose `key` matches `predicate` (current or as-of), optionally
// restricted to `scope`. matched_at is the value row's observed_at (value op) or
// the qualifying event's observed_at (temporal op) — the funnel anchor (§7).
export async function matchesTimed(key, predicate, { at, scope } = {}) {
  const now = at ? new Date(at) : new Date()
  const scopeArr = scope == null ? undefined : [].concat(scope)

  if (isTemporal(predicate)) {
    const rows = await store.keyRows(key, { at: at && now, scope: scopeArr })
    const byPassport = new Map()
    for (const r of rows) {
      let h = byPassport.get(r.passport_id)
      if (!h) byPassport.set(r.passport_id, (h = []))
      h.push(r)
    }
    const out = []
    for (const [pid, hist] of byPassport) {
      const matchedAt = temporalMatchedAt(hist, predicate, now)
      if (matchedAt != null) out.push({ id: pid, matched_at: matchedAt })
    }
    return out
  }

  const rows = await store.currentByKey(key, { at: at && now, scope: scopeArr })
  return rows
    .filter(r => matchValue(r.value, predicate, now))
    .map(r => ({ id: r.passport_id, matched_at: r.observed_at ? new Date(r.observed_at) : null }))
}

// Population: just the passport ids (the membership view of matchesTimed).
export async function matches(key, predicate, opts) {
  return (await matchesTimed(key, predicate, opts)).map(r => r.id)
}
