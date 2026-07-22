// Data access. Thin knex wrappers — no business logic. init() + free functions.

let db

const SUPPRESSION = 'whitebox_audience_suppression'
const IDENTITIES = 'whitebox_audience_identities'
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

// --- audiences (boolean compositions of segments) ---
export const listAudiences = () => db(AUDIENCES).orderBy('created_at', 'desc')
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

// --- browser-collected identities ---
export const getIdentities = passportId => db(IDENTITIES).where({ passport_id: passportId }).first()
export async function saveIdentities(passportId, signals) {
  await db(IDENTITIES).insert({ passport_id: passportId, signals }).onConflict('passport_id')
    .merge({ signals: db.raw('?? || ?', [`${IDENTITIES}.signals`, JSON.stringify(signals)]), updated_at: db.fn.now() })
}
