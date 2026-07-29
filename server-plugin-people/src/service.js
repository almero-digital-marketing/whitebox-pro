// Service layer — the single implementation REST and MCP both call. No
// transport here, and no storage: this plugin owns no tables. Everything comes
// from core's own primitives (passports / facts / awareness) plus, when they
// happen to be registered, the journeys and audiences plugins.
//
// Two rules the whole module is built on:
//
//   1. FACTS ARE OPTIONAL AND ARBITRARY. A deployment may have no facts at all,
//      and the keys it does have are whatever some plugin or import chose. So
//      nothing here names a fact key, derives a "display name" from one, or
//      assumes one exists. Presentation is the caller's job.
//   2. IDENTITY TYPES ARE NOT arbitrary — core declares them
//      (fingerprint/phone/email/user) and enforces global uniqueness on the
//      strong ones. That's the only stable vocabulary available, so it's what
//      identity-shaped logic keys on.
//
// journeys/audiences are SOFT dependencies: absent → that section of the detail
// view is simply omitted. A people browser must not require the whole suite.
import { z } from 'zod'

let passports, facts, awareness, journeys, audiences, logger

export function init(deps) {
  ({ passports, facts, awareness, journeys, audiences, logger } = deps)
}

const bad = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }

// One page of awareness rows. get() inlines the first page so the detail view
// renders in a single round-trip; everything after that comes from activity().
const ACTIVITY_PAGE = 20
const notFound = () => bad('person not found', 404)

// ── read ────────────────────────────────────────────────────────────────────

export async function list({ q, fields, includeAnonymous, limit, offset } = {}) {
  const res = await passports.search({
    q,
    // Passed through as-is: core owns the vocabulary (SEARCH_FIELDS) and
    // already normalises an array, a CSV string, or junk down to a safe scope.
    // Re-validating here would mean a second copy of that list to drift.
    fields,
    // query strings arrive as 'true'/'false'
    includeAnonymous: includeAnonymous === true || includeAnonymous === 'true',
    limit,
    offset,
  })

  // How much history each person has. One grouped count for the page, added
  // here rather than inside passports.search() because awareness is a separate
  // core module and the passport table shouldn't learn about it — this plugin
  // is already the place that assembles a person across stores.
  //
  // Fails soft, the same rule get() follows: awareness off or broken costs you
  // the number, not the search. Undefined (not 0) then, so the UI can tell "no
  // history" apart from "nobody is counting".
  const counts = await awareness?.exposureCounts?.(res.people.map(p => p.id)).catch(() => null)
  if (!counts) return res
  return { ...res, people: res.people.map(p => ({ ...p, event_count: counts[p.id] || 0 })) }
}

// One person, assembled across every store that holds a piece of them. Each
// optional section fails soft and independently — a broken or unregistered
// plugin costs you that panel, not the whole page.
export async function get(id) {
  const person = await passports.get(id, { facts })
  if (!person) notFound()

  const [recent, enrollments, suppressed, segments] = await Promise.all([
    // core's own per-passport exposure history — already merge-resolving, and
    // returns [] when awareness is disabled, so no capability check needed
    awareness?.timeline
      ? awareness.timeline({ passport_id: person.id, limit: ACTIVITY_PAGE }).catch(() => [])
      : Promise.resolve([]),
    journeys?.listEnrollmentsByPassport
      ? journeys.listEnrollmentsByPassport(person.id).catch(() => null)
      : Promise.resolve(null),
    audiences?.isSuppressed
      ? audiences.isSuppressed(person.id).catch(() => null)
      : Promise.resolve(null),
    // the static lists this person has been put on — null when audiences
    // isn't registered, [] when it is and they're on none
    audiences?.passportLists
      ? audiences.passportLists(person.id).catch(() => null)
      : Promise.resolve(null),
  ])

  return {
    ...person,
    recent,
    // null (not []) means "this plugin isn't wired", which the UI shows
    // differently from "wired, and there are none"
    enrollments,
    suppressed,
    segments,
  }
}

// Recent activity, paged and optionally narrowed to certain directions.
// `direction` is core's own vocabulary (exposure | expression | conversation |
// conversion) and timeline() already filters on it, so the narrowing happens in
// SQL rather than over whatever page the client happens to be holding.
export async function activity(id, { limit, offset, directions } = {}) {
  const person = await passports.get(id)
  if (!person) notFound()
  if (!awareness?.timeline) return { rows: [], hasMore: false }

  const take = Math.min(Math.max(Number(limit) || ACTIVITY_PAGE, 1), 100)
  const want = Array.isArray(directions)
    ? directions
    : (directions ? String(directions).split(',').map(d => d.trim()).filter(Boolean) : [])

  // Ask for one more row than the page needs: if it comes back there's another
  // page. Cheaper than a second COUNT, and it can never disagree with the rows
  // actually returned the way a separately-queried total can.
  const rows = await awareness.timeline({
    passport_id: person.id,
    limit: take + 1,
    offset: Math.max(Number(offset) || 0, 0),
    directions: want.length ? want : undefined,
  }).catch(() => [])

  return { rows: rows.slice(0, take), hasMore: rows.length > take }
}

// The lists a person can be put ON. Query segments are deliberately absent:
// their membership is recomputed from a predicate, so "adding" someone would be
// undone by the next resolve.
// Bulk cherry-pick — the only practical way to fill a list without an import.
//
// Two scopes, and the difference is the whole point of the feature:
//   { passportIds } — exactly these, hand-picked from the rail
//   { query }       — everyone the SEARCH matches, re-run server-side
//
// The query form re-runs the search rather than trusting a client-sent id list
// because the client has only ever seen one page of it. Asking for "all 240
// matching" when the rail shows 25 is the case that makes this worth building,
// and it can only be answered here.
//
// The cap is deliberate and reported, not silent: a runaway selection should
// tell you it was cut short rather than quietly add a different set than the
// one you asked for.
const BULK_MAX = 5000

// Turning "who is selected" into a list of ids is the same job for every bulk
// verb, so it lives here once. Two shapes, and the second is the whole point:
// an explicit set of ids, or a QUERY the server re-runs — the client has seen
// one page of 25 and cannot enumerate "all 40 000 matching".
async function bulkIds({ passportIds, query }) {
  if (passportIds) return { ids: passportIds, truncated: false }
  if (!query) bad('either passport_ids or query is required')
  const res = await list({ ...query, limit: BULK_MAX + 1, offset: 0 })
  const rows = res.people || res.rows || res
  return { ids: rows.slice(0, BULK_MAX).map(p => p.id), truncated: rows.length > BULK_MAX }
}

export async function addManyToList(segmentId, { passportIds, query } = {}) {
  needAudiences()
  if (!segmentId) bad('segment_id is required')

  const { ids, truncated } = await bulkIds({ passportIds, query })
  if (!ids.length) return { added: 0, requested: 0, count: null, truncated }

  const res = await audiences.addManyToList(segmentId, ids, 'people-ui')
  return { ...res, truncated }
}

export async function lists() {
  if (!audiences?.listLists) return []
  return audiences.listLists().catch(() => [])
}

// ── write ───────────────────────────────────────────────────────────────────

// Mirrors core's link() contract, which takes a list of claims and has no
// opinion on type. The schema here is only about rejecting obvious junk before
// it reaches the identities table — `type` is intentionally NOT an enum, since
// weak/custom types are legitimate (core only privileges the strong four).
const Claim = z.object({
  type: z.string().min(1).max(32),
  name: z.string().min(1).max(64).optional(),
  value: z.string().min(1).max(512),
})

export async function linkIdentity(id, claim) {
  const person = await passports.get(id)
  if (!person) notFound()
  const parsed = Claim.safeParse(claim || {})
  if (!parsed.success) bad(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  // name defaults to the type — core's table requires one, and for a plain
  // email/phone the type IS the label
  const item = { name: parsed.data.type, ...parsed.data }
  await passports.link(person.id, [item])
  return get(person.id)
}

export async function unlinkIdentity(id, identityId) {
  const person = await passports.get(id)
  if (!person) notFound()
  const removed = await passports.unlink(person.id, identityId)
  if (!removed) bad('identity not found on this person', 404)
  return get(person.id)
}

// Record an arbitrary fact. `key` is free-form on purpose — that's what facts
// are. `source` is stamped so a hand-entered value is distinguishable from one
// a plugin observed, which matters when someone later asks where it came from.
const FactInput = z.object({
  key: z.string().min(1).max(128),
  value: z.union([z.string(), z.number(), z.boolean()]),
  observed_at: z.string().datetime().optional(),
})

export async function recordFact(id, input) {
  const person = await passports.get(id)
  if (!person) notFound()
  const parsed = FactInput.safeParse(input || {})
  if (!parsed.success) bad(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  await facts.record({ passport_id: person.id, ...parsed.data, source: 'people' })
  return get(person.id)
}

// The same fact on everyone selected. Same schema, same `source`, same
// append-only semantics as recordFact — the only difference is how many
// passports it lands on, which is exactly what makes reusing the single-person
// panel for it honest.
//
// `recorded` can be lower than `requested`: merged passports resolve to one id,
// and one fact stated twice about the same person is one fact. Reported rather
// than smoothed over, like the list bulk's `added`.
export async function recordFactForMany(input, { passportIds, query } = {}) {
  const parsed = FactInput.safeParse(input || {})
  if (!parsed.success) bad(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))

  const { ids, truncated } = await bulkIds({ passportIds, query })
  if (!ids.length) return { recorded: 0, requested: 0, truncated }

  const rows = await facts.recordMany({ passport_ids: ids, ...parsed.data, source: 'people' })
  return { recorded: rows.length, requested: ids.length, truncated }
}

// The key vocabulary, deployment-wide. Facts have no fixed schema, so the only
// defence against `client_status` and `clientStatus` living side by side is
// showing what already exists before you type.
export async function factKeys() {
  if (!facts?.usedKeys) return []
  return facts.usedKeys().catch(() => [])
}

// List membership. Both go through the audiences plugin rather than touching
// its table, so its own validation (is this actually a list?) stays the single
// authority.
const needAudiences = () => {
  if (!audiences?.addToList) bad('the audiences plugin is not registered', 501)
}

// Creating a list from here is deliberate: cherry-picking starts from a person
// you're looking at, and making the operator leave for the Audiences module to
// create an empty list first would break that in half.
export async function createList(name) {
  needAudiences()
  if (!audiences.createList) bad('the audiences plugin is too old to create lists', 501)
  return audiences.createList({ name })
}

export async function addToList(id, segmentId) {
  needAudiences()
  if (!segmentId) bad('segment_id is required')
  const person = await passports.get(id)
  if (!person) notFound()
  await audiences.addToList(segmentId, person.id)
  return get(person.id)
}

export async function removeFromList(id, segmentId) {
  needAudiences()
  const person = await passports.get(id)
  if (!person) notFound()
  await audiences.removeFromList(segmentId, person.id)
  return get(person.id)
}

// Merge is NON-destructive (core keeps the absorbed id as a tombstone that
// resolves forward), which is why it needs no erase-level permission.
export async function merge(survivorId, absorbedId) {
  if (!absorbedId) bad('absorbed_id is required')
  if (survivorId === absorbedId) bad('cannot merge a person into themselves')
  const [survivor, absorbed] = await Promise.all([passports.get(survivorId), passports.get(absorbedId)])
  if (!survivor || !absorbed) notFound()
  // resolve() forwards both ids first, so two ids that ALREADY point at the
  // same person is a no-op, not an error
  if (survivor.id === absorbed.id) return get(survivor.id)
  await passports.merge(survivor.id, absorbed.id)
  logger?.info?.({ survivor: survivor.id, absorbed: absorbed.id }, 'people: merged')
  return get(survivor.id)
}

// Right-to-be-forgotten. Irreversible, and separately permissioned from the
// other writes — see the plugin's `people:erase`.
export async function erase(id) {
  const person = await passports.get(id)
  if (!person) notFound()
  const result = await passports.erase(person.id)
  logger?.warn?.({ passport_id: person.id, removed: result?.removed }, 'people: erased a person')
  return result
}

// Erase, for a whole selection.
//
// Its own cap, far below BULK_MAX, and that's not timidity: every other bulk
// verb here is ONE statement for the whole set, while this is a lock round trip
// plus a transaction across every referencing table PER PERSON. Five thousand
// of those will not finish inside an HTTP request, so the endpoint does what it
// can and says where it stopped — running it again picks up the rest. Silently
// starting an unfinishable erasure is the failure mode worth avoiding: a
// half-done right-to-be-forgotten that reported success is a compliance claim
// that isn't true.
const ERASE_MAX = 200

export async function eraseMany({ passportIds, query } = {}) {
  const { ids: all, truncated: overBulk } = await bulkIds({ passportIds, query })
  const ids = all.slice(0, ERASE_MAX)

  const removed = {}
  let erased = 0
  for (const id of ids) {
    // Sequential, not Promise.all. Each erase takes a passport-scoped lock and
    // opens a transaction touching the same 17 passport-referencing tables; running
    // them at once
    // would contend for those tables without buying wall-clock.
    const res = await passports.erase(id)
    // null means there was nothing there — normal, not an error: erasing a
    // survivor also drops the passports merged into it, so an absorbed id
    // later in the same set is already gone by the time its turn comes.
    if (!res) continue
    erased++
    for (const [tbl, n] of Object.entries(res.removed)) removed[tbl] = (removed[tbl] || 0) + n
  }

  logger?.warn?.({ erased, requested: ids.length, removed }, 'people: bulk erased')
  return { erased, requested: ids.length, removed, truncated: overBulk || all.length > ERASE_MAX }
}
