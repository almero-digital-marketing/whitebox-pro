// Data access. Thin knex wrappers — no business logic. init() + free functions.

import { pagedList } from 'whitebox-pro-server/pagination'

let db

const SUPPRESSION = 'whitebox_audience_suppression'
const SIGNALS = 'whitebox_audience_signals'
const SEGMENTS = 'whitebox_audience_segments'
const AUDIENCES = 'whitebox_audiences'

export function init({ db: knex }) { db = knex }

// --- segments (chart-derived dynamic sub-queries) ---
export const listSegments = () => db(SEGMENTS).orderBy('created_at', 'desc')
export const getSegment = id => db(SEGMENTS).where({ id }).first()
export const getSegmentByKey = key => db(SEGMENTS).where({ predicate_key: key }).first()
export async function insertSegment(seg) {
  const [row] = await db(SEGMENTS).insert(seg).returning('*')
  return row
}
export async function updateSegment(id, fields) {
  const [row] = await db(SEGMENTS).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteSegment = id => db(SEGMENTS).where({ id }).del()

// --- static-list membership (see migrations/014) ---------------------------
const MEMBERS = 'whitebox_audience_segment_members'

export const listMemberIds = async segmentId =>
  (await db(MEMBERS).where({ segment_id: segmentId }).select('passport_id')).map(r => r.passport_id)

// onConflict → adding someone already on the list is a no-op, not an error:
// the caller asked for them to be on it, and they are.
export const addMember = (segmentId, passportId, addedBy) =>
  db(MEMBERS).insert({ segment_id: segmentId, passport_id: passportId, added_by: addedBy || null })
    .onConflict(['segment_id', 'passport_id']).ignore()

// One statement for the whole set. The same onConflict rule applies per row,
// so a bulk add over people who are already on the list is a partial no-op
// rather than a failure — which is what makes re-running a selection safe.
export const addMembers = async (segmentId, passportIds, addedBy) => {
  if (!passportIds.length) return 0
  const before = await memberCount(segmentId)
  await db(MEMBERS).insert(passportIds.map(passportId => ({ segment_id: segmentId, passport_id: passportId, added_by: addedBy || null })))
    .onConflict(['segment_id', 'passport_id']).ignore()
  return (await memberCount(segmentId)) - before
}

export const removeMember = (segmentId, passportId) =>
  db(MEMBERS).where({ segment_id: segmentId, passport_id: passportId }).del()

export const memberCount = async segmentId =>
  Number((await db(MEMBERS).where({ segment_id: segmentId }).count('* as n').first())?.n || 0)

// Which lists is this passport on? Joined to the segment so the caller gets
// names without a second round-trip.
export const segmentsForPassport = passportId =>
  db(MEMBERS + ' as m')
    .join(SEGMENTS + ' as s', 's.id', 'm.segment_id')
    .where('m.passport_id', passportId)
    .orderBy('m.added_at', 'desc')
    .select('s.id', 's.name', 'm.added_at', 'm.added_by')

// --- audiences (boolean compositions of segments) ---
export const listAudiences = () => db(AUDIENCES).orderBy('created_at', 'desc')
// The rail's read: one page, plus the real total so the pager can say where you
// are. Kept beside the unpaged list rather than replacing it — activation still
// needs every client-side audience at once, and so does the MCP tool.
export const searchAudiences = opts => pagedList(db(AUDIENCES), { ...opts, fields: ['name'] })
export const getAudience = id => db(AUDIENCES).where({ id }).first()
export const getAudienceByActivationId = activation_id => db(AUDIENCES).where({ activation_id }).first()
export async function upsertAudience(aud) {
  const [row] = await db(AUDIENCES).insert(aud)
    .onConflict('id').merge({ ...aud, updated_at: db.fn.now() }).returning('*')
  return row
}
// partial update of an existing audience — only the given columns (used for flags like
// client_side, so we don't have to round-trip name/rule/delivery through an upsert)
export async function updateAudience(id, fields) {
  const [row] = await db(AUDIENCES).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteAudience = id => db(AUDIENCES).where({ id }).del()

// --- suppression ---
export const isSuppressed = async passportId => !!(await db(SUPPRESSION).where({ passport_id: passportId }).first())
// Which of these passports are suppressed — ONE query for the whole cohort (a Set),
// instead of N per-passport round-trips. Used to gate a cohort without latency × N.
export const suppressedAmong = async (ids) => {
  if (!ids.length) return new Set()
  const rows = await db(SUPPRESSION).whereIn('passport_id', ids).select('passport_id')
  return new Set(rows.map(r => r.passport_id))
}
export const suppress = (passportId, reason) =>
  db(SUPPRESSION).insert({ passport_id: passportId, reason }).onConflict('passport_id').merge()
export const unsuppress = passportId => db(SUPPRESSION).where({ passport_id: passportId }).del()
export const listSuppression = () => db(SUPPRESSION).orderBy('created_at', 'desc')

// --- health (see ../../docs/10-plugin-status.md) ---
// How much of the audience layer exists. CURRENT STATE, so no `since`: "how
// many audiences are there" is not an event that happened at a time, and these
// tables hold no history to window against — a segment row carries created_at
// but the number that matters is the one that's there now.
export const healthCounts = async () => {
  const [seg] = await db(SEGMENTS).select(db.raw(`count(*)::int AS segments`))
  const [aud] = await db(AUDIENCES).select(db.raw(`count(*)::int AS audiences`))
  return { ...seg, ...aud }
}

// Per-network delivery state, read out of each audience's `delivery` jsonb.
//
// That column is the ONLY record of it. Migration 011 dropped
// whitebox_audience_deliveries along with the standalone rule system it belonged
// to, so there is no per-event delivery audit trail left to count accepts and
// rejects from — nothing writes one.
//
// What the column does record is the thing that goes wrong silently.
// service.setDelivery() stamps `dry_run: true` when no ELIGIBLE adapter is wired
// for the network it was just switched on for: delivery reads as enabled in the
// UI, and nothing ever reaches the platform. Nobody is told. That's what this
// counts.
//
// jsonb_each() raises on a non-object, so the column is normalised to '{}'
// inside the lateral rather than filtered in WHERE — a WHERE clause is evaluated
// after the lateral, which would be too late to stop the error, and status()
// must not throw.
export const deliveryByNetwork = async () => {
  const { rows } = await db.raw(`
    SELECT d.key                                                     AS network,
           count(*)::int                                             AS enabled,
           count(*) FILTER (WHERE d.value->>'dry_run' = 'true')::int AS dry_run
    FROM ${AUDIENCES} a
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(a.delivery) = 'object' THEN a.delivery ELSE '{}'::jsonb END
    ) AS d(key, value)
    WHERE d.value->>'enabled' = 'true'
    GROUP BY d.key
    ORDER BY d.key
  `)
  return (rows || []).map(r => ({ network: r.network, enabled: Number(r.enabled), dry_run: Number(r.dry_run) }))
}

// --- browser-collected ad signals (fbp, gclid, ttclid, …) ---
// Stored one row per signal, but handed to callers as a flat { name: value }
// object — that's the shape identity.resolve() passes to the ad adapters, and
// it stayed identical through the jsonb-blob → rows migration.
export async function getSignals(passportId) {
  const rows = await db(SIGNALS).where({ passport_id: passportId }).select('name', 'value')
  return Object.fromEntries(rows.map(r => [r.name, r.value]))
}
// Upsert per key: capturing one new signal touches one row and leaves the
// others (and their individual last_seen_at) alone. Values are coerced to text
// because the column is a string and an adapter only ever wants a scalar id;
// empty/nullish keys are dropped rather than stored as "".
export async function saveSignals(passportId, signals) {
  const rows = Object.entries(signals || {})
    .filter(([name, value]) => name && value != null && value !== '' && typeof value !== 'object')
    .map(([name, value]) => ({ passport_id: passportId, name, value: String(value) }))
  if (!rows.length) return
  await db(SIGNALS).insert(rows)
    .onConflict(['passport_id', 'name'])
    .merge({ value: db.raw('excluded.value'), last_seen_at: db.fn.now() })
}
