import path from 'path'
import { fileURLToPath } from 'url'

import * as store from './store.js'
import * as computed from './computed.js'
import { matchValue, matchTemporal, temporalMatchedAt, isTemporal } from './operators.js'

// Does this predicate ask ONLY for absence? `{ present: false }` and nothing else,
// because "absent AND greater than 5" is a contradiction matchValue already answers
// with no.
function absenceOnly(predicate) {
  const p = operatorsOf(predicate)
  return Object.keys(p).length === 1 && p.present === false
}

// `use` selects WHICH of a passport's values the operators are applied to. It is a
// control key, not an operator, so it is split off before matchValue ever sees it —
// otherwise it would be rejected as "not a value operator", which is exactly the
// right error for a typo and exactly the wrong one for this.
const CONTROL_KEYS = ['use']
function operatorsOf(predicate) {
  const p = predicate || {}
  if (!CONTROL_KEYS.some(k => k in p)) return p
  const out = { ...p }
  for (const k of CONTROL_KEYS) delete out[k]
  return out
}

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
let declaredUse

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
  // WHICH of a passport's values a key MEANS, when it holds several. Seeded from
  // config FIRST for the same reason labels are: the operator has the final word, and
  // config is the only place keys nobody could anticipate can be declared — the crm
  // plugin writes arbitrary external field names as fact keys, so no plugin author can
  // pre-declare `status_2`.
  declaredUse = new Map(Object.entries(deps.config?.facts?.use || {}))
  for (const [key, u] of declaredUse) {
    if (!store.USE_VALUES.includes(u)) {
      throw new Error(`facts.use.${key}: unknown value "${u}" (one of ${store.USE_VALUES.join('/')}). ` +
        `last/first pick by observed_at (most recent / earliest write); max/min pick by VALUE.`)
    }
  }
  // Computed keys (age from birthdate, tenure from first_booked_at, …) — declared
  // once in config and then usable anywhere a stored key is. Validated here so a
  // bad unit is a boot error, not an empty chart weeks later.
  const n = computed.init(deps.config?.facts?.computed)
  if (n) logger?.info?.({ keys: computed.computedKeys() }, 'facts: computed keys registered')
}

// A computed key reads its SOURCE key's rows and derives the value in SQL.
// Returns what to actually query: the real key, plus the expression (if any).
function resolveKey(key, at) {
  const d = computed.derivedSql(key, { now: at || new Date() })
  return d ? { key: d.from, derive: d } : { key, derive: undefined }
}

// Register a human-readable label for a fact key — e.g. a plugin calling
// describe('geo_city', 'City') for a key it owns. First write wins, so a
// config-seeded label (see init() above) is never clobbered by a plugin default.
/**
 * What a plugin declares about a key it OWNS. First write wins, so a config-seeded
 * value is never clobbered by a plugin default.
 *
 *   describe('geo_city', 'City')                          the original form, still valid
 *   describe('first_booked_at', { label: 'First booked', use: 'min' })
 *
 * `use` says which of a passport's values the key MEANS when it holds several. It
 * belongs here, with the writer, because the writer is the only party that knows:
 * gpoint's CRM plugin computes the minimum booking date precisely BECAUSE it
 * understands that a first booking cannot move forward. Core cannot infer that, and a
 * caller passing `use: 'min'` by hand on every acquisition question is one forgotten
 * argument away from a quietly wrong answer.
 */
export function describe(key, declaration) {
  const { label, use } = typeof declaration === 'string' ? { label: declaration } : (declaration || {})
  if (label != null && !labels.has(key)) labels.set(key, label)
  if (use != null && !declaredUse.has(key)) {
    if (!store.USE_VALUES.includes(use)) {
      throw new Error(`facts.describe("${key}"): unknown \`use\` "${use}" (one of ${store.USE_VALUES.join('/')})`)
    }
    declaredUse.set(key, use)
  }
}

/**
 * The rule for `key`, or null when nobody has declared one.
 *
 * Null is not the same as 'last'. It means UNDECLARED, which is what
 * undeclaredAmbiguous() reports on — a key that holds several values and has never
 * been told which one it means is the one case worth a human's attention.
 */
// Optional-chained: selector.init() and facts.init() have no guaranteed order, and a
// read before init should fall back to the default rather than throw.
export const useFor = (key) => declaredUse?.get(key) ?? null

// Every declaration, for discovery surfaces and for the report below.
export const declaredKeys = () =>
  [...(declaredUse?.entries() ?? [])].map(([key, use]) => ({ key, use, label: labels.get(key) || key }))

// The human label for `key`, or the raw key when nothing is registered.
export function label(key) {
  return labels.get(key) || key
}

// Every registered { key, label } pair — for vocabulary/discovery surfaces (AI
// compose, audience rule authoring) that want to show people a name, not a key.
export function describedKeys() {
  return [...labels.entries()].map(([key, humanLabel]) => ({ key, label: humanLabel }))
}

/**
 * Ambiguous keys nobody has declared a rule for — the report that turns "somebody
 * should think about this" into a named list with the responsible writer attached.
 *
 * Not a per-query warning. Ambiguity is the NORMAL state for a key that legitimately
 * changes (geo_city) or that is really a per-event stream stored as a fact
 * (booking_cost, at 7.4 rows per passport). A warning on every query touching those
 * would fire on most queries forever and teach people to ignore it. A warning about an
 * UNDECLARED key is a config gap: actionable once, then silent.
 */
export const undeclaredAmbiguous = () =>
  store.ambiguousKeys({ undeclaredOnly: true, declared: new Set(declaredUse?.keys() ?? []) })

// Every ambiguous key, declared or not — for a data-health view that wants the whole
// picture rather than only the outstanding decisions.
export const allAmbiguous = () => store.ambiguousKeys({ undeclaredOnly: false })

// Is the current-value projection consistent with the append-only log? Exposed so a
// deployment can assert it on a schedule — the projection is trigger-maintained and
// therefore hard to desynchronise, but "hard" is not "impossible" and the failure
// mode is a confidently wrong number rather than an error.
export const verifyCurrent = (opts) => store.verifyCurrent(opts)

// Rebuild it from the log. One statement; the escape hatch that makes the projection
// safe to depend on.
export const rebuildCurrent = () => store.rebuildCurrent()

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

// ── no-op suppression ───────────────────────────────────────────────────────
//
// A write that restates the CURRENT value of a key changes nothing any reader
// can observe — `current`, `asOf`, `matches` and the selector's fact predicate
// all resolve to the latest row per (passport, key), so a second identical row
// is invisible to every one of them while still costing heap and, far worse,
// index. It is stored, indexed, vacuumed and backed up to answer no question.
//
// This was not hypothetical. The geolocation plugin hooks sessions.onResolve and
// writes five facts (country/region/city/lat/lon) on EVERY session, with no
// comparison against what is already there — so a returning visitor from the
// same city wrote five identical rows per visit. On the GPoint deployment that
// was ~107k redundant rows per geo key within a week, against a facts table
// whose indexes (3.6 GB) had grown to nearly twice its heap (1.9 GB).
//
// Two carve-outs, both load-bearing:
//
//  · A row carrying an `external_id` is never suppressed. It names a distinct
//    external thing (`booking:123`), and two different bookings legitimately
//    share a value — `booking_online = true` for both. Collapsing those would
//    destroy real records, not redundant ones. This is exactly the line the data
//    showed: geo keys carry no external_id and duplicated heavily; booking keys
//    carry one and did not duplicate at all.
//
//    This is also why suppression and `resolve` never overlap. `resolve`
//    ('skip'/'replace') settles what a RE-SEND of an identified observation
//    means, and reaches the database as ON CONFLICT against a partial index the
//    external_id rows alone occupy. Suppression handles the other half — the
//    anonymous restatement, which no index can recognise as a repeat because
//    nothing about it is stable enough to key on.
//
//  · A BACK-DATED write is never suppressed. Suppression compares against the
//    current (latest) row, so a row landing before it can still change what
//    `asOf(t)` returns for an earlier instant, and `history()` reads the whole
//    timeline. Only a write that would itself become the new current row, with
//    an unchanged value, is a true no-op.
//
// `force: true` opts out per call, for a caller that genuinely wants an
// append-only observation log ("we saw this again at T").

// Stable stringify — object key ORDER must not decide equality, or a provider
// that serialises {lat, lon} today and {lon, lat} tomorrow reads as a change.
function canonical(v) {
  return JSON.stringify(v, (_k, val) =>
    (val && typeof val === 'object' && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]))
      : val)
}

// rows in → { write, skipped }. `rows` are fully-built store rows (value and
// external_id already normalised). One query regardless of batch size.
async function suppressNoOps(rows) {
  const comparable = rows.filter(r => r.external_id == null)
  if (!comparable.length) return { write: rows, skipped: [] }

  const current = await store.currentForPairs(
    comparable.map(({ passport_id, key }) => ({ passport_id, key })),
  )
  const k = (pid, key) => `${pid}\u0000${key}`
  const idx = new Map(current.map(c => [k(c.passport_id, c.key), c]))

  const write = [], skipped = []
  for (const r of rows) {
    const cur = r.external_id != null ? null : idx.get(k(r.passport_id, r.key))
    const isNoOp = cur
      && canonical(cur.value) === canonical(JSON.parse(r.value))
      && new Date(r.observed_at) >= new Date(cur.observed_at)
    if (isNoOp) skipped.push(cur); else write.push(r)
  }
  return { write, skipped }
}

// Record one observed fact. `observed_at` defaults to now (valid-time); `type`
// is inferred when omitted. A value CHANGE is a new row — nothing is overwritten;
// a write that merely restates the current value is suppressed (see above), and
// the existing current row comes back, so the contract holds either way: what is
// returned is the row that is now current for this (passport, key). `force: true`
// records the restatement anyway.
//
// `external_id` is the writer's own handle for this observation, and supplying it
// is what makes a re-send resolvable (see migrations/003). `resolve` then says
// what a repeat means — 'skip' if you are re-sending what you already sent,
// 'replace' if what you sent was wrong. There is no default on purpose: only the
// writer knows which, and a conflict without one throws rather than guessing.
export async function record({ passport_id, key, value, type, source, observed_at, external_id, resolve, force } = {}) {
  if (!passport_id) throw new Error('facts.record: passport_id is required')
  if (!key) throw new Error('facts.record: key is required')
  if (value === undefined) throw new Error('facts.record: value is required')
  if (resolve && external_id == null) throw new Error('facts.record: resolve needs an external_id to resolve against')

  const pid = await resolveId(passport_id)
  const candidate = {
    passport_id: pid,
    key,
    value: JSON.stringify(value),   // jsonb; node-pg returns it parsed on read
    type: type || inferType(value),
    source: source || 'unknown',
    external_id: external_id == null ? null : String(external_id),
    observed_at: observed_at ? new Date(observed_at) : new Date(),
  }

  if (!force) {
    const { write, skipped } = await suppressNoOps([candidate])
    if (!write.length) {
      logger?.debug?.({ passport_id: pid, key }, 'fact unchanged — write suppressed')
      return skipped[0]
    }
  }

  const row = await store.insert(candidate, { resolve })
  logger?.debug?.({ passport_id: pid, key }, 'fact recorded')
  return row
}

// Record MANY DIFFERENT facts, in one INSERT.
//
// The complement of recordMany below: that one is a single key across many
// passports (a bulk tag), this one is many keys — typically for one passport,
// though nothing here requires that.
//
// Exists because the shape it serves had no bulk path at all. An external
// system pushing a customer's structured state writes one fact per field, and
// the CRM adapter did it with `for (const w of writes) await facts.record(w)` —
// one round trip per field. At ~90 fields for a customer with some history that
// is ~90 sequential trips to Postgres, and it measured at 7.5 customers/minute:
// a backfill of 98k customers would have taken nine days.
//
// Passport ids are resolved ONCE per distinct id rather than once per fact,
// since the common case is many facts for one person and resolution walks the
// merge chain.
//
// A malformed entry throws rather than being skipped. These batches are built
// by code, not by users — a missing key is a bug, and dropping it silently
// would write a partial state that looks complete.
// `resolve` is per BATCH, not per row: it is one INSERT, and ON CONFLICT is a
// property of the statement. Rows carry their own `external_id` — a batch may
// mix identified and anonymous facts, and the partial index only sees the former.
// `force` is per batch for the same reason, though nothing forces it to be: a
// caller who wants half a batch suppressed and half of it forced is describing
// two batches.
export async function recordBatch(facts = [], { resolve, force } = {}) {
  if (!facts.length) return []

  for (const f of facts) {
    if (!f?.passport_id) throw new Error('facts.recordBatch: passport_id is required')
    if (!f?.key) throw new Error('facts.recordBatch: key is required')
    if (f?.value === undefined) throw new Error('facts.recordBatch: value is required')
  }
  if (resolve && !facts.some(f => f.external_id != null)) {
    throw new Error('facts.recordBatch: resolve needs at least one external_id to resolve against')
  }

  const resolved = new Map()
  for (const id of new Set(facts.map(f => f.passport_id))) {
    resolved.set(id, await resolveId(id))
  }

  const rows = facts
    .filter(f => resolved.get(f.passport_id))
    .map(f => ({
      passport_id: resolved.get(f.passport_id),
      key: f.key,
      value: JSON.stringify(f.value),
      type: f.type || inferType(f.value),
      source: f.source || 'unknown',
      external_id: f.external_id == null ? null : String(f.external_id),
      // Per row here, unlike recordMany: these facts are not one act observed
      // once. A booking from 2023 and a total computed today belong at their own
      // instants, and collapsing them would flatten the history the temporal
      // operators read.
      observed_at: f.observed_at ? new Date(f.observed_at) : new Date(),
    }))

  // Suppression matters most here: this is the CRM re-sync path, where a
  // customer's ~90 fields are pushed again on every run and typically two or
  // three of them have actually moved.
  const { write, skipped } = force ? { write: rows, skipped: [] } : await suppressNoOps(rows)

  const out = await store.insertMany(write, { resolve })
  // requested vs count: with resolve 'skip' or a suppressed restatement they
  // differ, and the difference is the number of facts the writer had already
  // sent. That is the useful figure.
  logger?.debug?.({ count: out.length, requested: rows.length, suppressed: skipped.length }, 'facts recorded in batch')
  return out
}

// Record the SAME fact for many passports — one INSERT, not one per person.
//
// Exists because the alternative (a loop over record()) is two round trips per
// passport, which is the difference between a bulk action and a timeout at any
// realistic cohort size. Merge resolution stays per-id and parallel, matching
// audiences.addManyToList() — the chain walk isn't set-expressible, and it's
// the insert that dominates.
//
// Returns the rows actually written, which can be FEWER than the ids passed:
// two people who were merged resolve to the same passport, and recording the
// same key twice for them would be one fact stated twice, not two facts.
export async function recordMany({ passport_ids, key, value, type, source, observed_at, external_id, force } = {}) {
  if (!key) throw new Error('facts.recordMany: key is required')
  if (value === undefined) throw new Error('facts.recordMany: value is required')
  const ids = [...new Set((await Promise.all((passport_ids || []).map(resolveId))).filter(Boolean))]
  if (!ids.length) return []

  const at = observed_at ? new Date(observed_at) : new Date()
  const candidates = ids.map(passport_id => ({
    passport_id,
    key,
    value: JSON.stringify(value),
    type: type || inferType(value),
    source: source || 'unknown',
    external_id: external_id == null ? null : String(external_id),
    // one timestamp for the whole batch, not one per row: these were observed
    // as a single act, and per-row clock drift would order them arbitrarily
    observed_at: at,
  }))

  // Re-tagging a cohort is the norm, not the exception — an audience refresh
  // re-states the same tag for everyone who was already in it.
  const { write, skipped } = force ? { write: candidates, skipped: [] } : await suppressNoOps(candidates)

  const rows = await store.insertMany(write)
  logger?.debug?.({ count: rows.length, suppressed: skipped.length, key }, 'facts recorded in bulk')
  return rows
}

// Every key in use, deployment-wide. describedKeys() is the subset someone has
// given a human label to; this is all of them, which is what a key field needs
// to suggest — an undescribed key is still a key you must not misspell.
// Computed keys are part of the vocabulary a caller can query, so discovery has to
// list them — otherwise `age` works but nothing advertises it, and the compose
// model never learns it exists.
export const usedKeys = async () => [...new Set([...(await store.distinctKeys()), ...computed.computedKeys()])]

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
  return matchValue(rows.length ? rows[0].value : undefined, operatorsOf(predicate), now)
}

// Population WITH the qualifying-event time: `[{ id, matched_at }]` for every
// passport whose `key` matches `predicate` (current or as-of), optionally
// restricted to `scope`. matched_at is the value row's observed_at (value op) or
// the qualifying event's observed_at (temporal op) — the funnel anchor (§7).
export async function matchesTimed(key, predicate, { at, scope } = {}) {
  const now = at ? new Date(at) : new Date()
  const scopeArr = scope == null ? undefined : [].concat(scope)

  const src = resolveKey(key, at && now)

  if (isTemporal(predicate)) {
    const rows = await store.keyRows(src.key, { at: at && now, scope: scopeArr, derive: src.derive })
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

  // ABSENCE asks a different question of the database. Every read below starts from
  // whitebox_facts, so it can only enumerate passports that HAVE a row for the key —
  // and "who has never had this fact" is not in that set. Filtering enumerated rows
  // for absence answered 0 on live data where the truth was 494, which is why the
  // caller reached for a sentinel date (`{ gte: '2000-01-01' }`) instead: a magic
  // constant that has no equivalent for a string or a bool, and that silently files
  // a mistyped 1900 birth year under "absent".
  if (absenceOnly(predicate)) {
    const ids = await store.absentByKey(src.key, { at: at && now, scope: scopeArr, derive: src.derive })
    // matched_at is null on purpose: there is no event where someone failed to
    // acquire a fact, so a funnel step cannot anchor on this.
    return ids.map(id => ({ id, matched_at: null }))
  }

  // Precedence: the query's own `use` beats the key's declaration, which beats 'last'.
  // A declared key is therefore correct everywhere without the caller doing anything —
  // which is the whole point, since the alternative is remembering it every time.
  const rows = await store.currentByKey(src.key, {
    at: at && now, scope: scopeArr, derive: src.derive,
    use: predicate?.use ?? useFor(key) ?? undefined,
  })
  // Null values (a derived key whose source was absent or unparseable, or a stored
  // one recorded empty) are rejected by matchValue itself — it treats null and
  // undefined as the same absence. This used to filter them here, for derived keys
  // only, which left the identical hole open for stored ones.
  const ops = operatorsOf(predicate)
  return rows
    .filter(r => matchValue(r.value, ops, now))
    .map(r => ({ id: r.passport_id, matched_at: r.observed_at ? new Date(r.observed_at) : null }))
}

// Population: just the passport ids (the membership view of matchesTimed).
export async function matches(key, predicate, opts) {
  return (await matchesTimed(key, predicate, opts)).map(r => r.id)
}
