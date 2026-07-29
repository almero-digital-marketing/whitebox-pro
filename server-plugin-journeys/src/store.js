// Data access. Thin knex wrappers — no business logic. init() + free functions.

import { pagedList } from 'whitebox-pro-server/pagination'

let db

const JOURNEYS = 'whitebox_journeys'
const ENROLLMENTS = 'whitebox_journey_enrollments'
const STEP_RUNS = 'whitebox_journey_step_runs'

export function init({ db: knex }) { db = knex }

// --- journeys ---
export const listJourneys = () => db(JOURNEYS).orderBy('created_at', 'desc')
// One page for the rail, with the real total — see the audiences store.
export const searchJourneys = opts => pagedList(db(JOURNEYS), { ...opts, fields: ['name'] })
export const getJourney = id => db(JOURNEYS).where({ id }).first()
export async function insertJourney(fields) {
  const [row] = await db(JOURNEYS).insert(fields).returning('*')
  return row
}
export async function updateJourney(id, fields) {
  const [row] = await db(JOURNEYS).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteJourney = id => db(JOURNEYS).where({ id }).del()

// active journeys whose trigger is event-based and whose `event` array
// CONTAINS this specific name (a journey can list several event names —
// JSONB containment, not equality, since `trigger->'event'` is an array)
export const activeEventJourneys = eventName =>
  db(JOURNEYS).where({ status: 'active' }).whereRaw("trigger->>'kind' = 'event'")
    .whereRaw("trigger->'event' @> ?::jsonb", [JSON.stringify([eventName])])
// distinct event names referenced by any active event-triggered journey — lets triggers.js
// maintain exactly one ctx.events subscription per name, shared across journeys.
// Flattened/deduped in JS rather than in SQL (jsonb_array_elements) — simple
// and robust at this data scale (a handful of journeys, not big data).
export const distinctActiveEventNames = async () => {
  const rows = await db(JOURNEYS).where({ status: 'active' }).whereRaw("trigger->>'kind' = 'event'").select(db.raw("trigger->'event' as event"))
  const names = new Set()
  for (const row of rows) {
    const arr = typeof row.event === 'string' ? JSON.parse(row.event) : row.event
    for (const name of arr || []) names.add(name)
  }
  return [...names]
}
// active journeys whose trigger targets an Audience
export const activeAudienceJourneys = () => db(JOURNEYS).where({ status: 'active' }).whereRaw("trigger->>'kind' = 'audience'")

// --- enrollments ---
export const getEnrollment = id => db(ENROLLMENTS).where({ id }).first()
export async function insertEnrollment(fields) {
  const [row] = await db(ENROLLMENTS).insert(fields).returning('*')
  return row
}
export async function updateEnrollment(id, fields) {
  const [row] = await db(ENROLLMENTS).where({ id }).update(fields).returning('*')
  return row
}
export const listEnrollments = (journeyId, { status, limit = 50, offset = 0 } = {}) => {
  let q = db(ENROLLMENTS).where({ journey_id: journeyId }).orderBy('enrolled_at', 'desc').limit(limit).offset(offset)
  if (status) q = q.andWhere({ status })
  return q
}
// The same rows the other way round: every journey ONE passport has been
// through. The per-journey view above answers "who is in this journey"; a
// person-centric surface (the People module) needs "what is this person in",
// which no query answered before. Joined to journeys so a caller gets the name
// without N follow-up reads.
export const listEnrollmentsByPassport = (passportId, { limit = 50 } = {}) =>
  db(ENROLLMENTS + ' as e')
    .leftJoin('whitebox_journeys as j', 'j.id', 'e.journey_id')
    .where('e.passport_id', passportId)
    .select('e.*', 'j.name as journey_name', 'j.status as journey_status')
    .orderBy('e.enrolled_at', 'desc')
    .limit(limit)
// an existing active/waiting run for this passport in this journey — the
// "don't double-enroll a currently-running passport" check
export const findEnrollment = (journeyId, passportId) =>
  db(ENROLLMENTS).where({ journey_id: journeyId, passport_id: passportId }).whereIn('status', ['active', 'waiting']).first()
// any row at all (terminal or not) for this passport in this journey — the
// "has this passport EVER run this journey" check (reenroll:false gate)
export const findAnyEnrollment = (journeyId, passportId) =>
  db(ENROLLMENTS).where({ journey_id: journeyId, passport_id: passportId }).first()
// most recent terminal (completed/exited) run — the cooldown_days gate
export const lastTerminalEnrollment = (journeyId, passportId) =>
  db(ENROLLMENTS).where({ journey_id: journeyId, passport_id: passportId }).whereIn('status', ['completed', 'exited'])
    .orderBy(db.raw('coalesce(completed_at, exited_at)'), 'desc').first()

// how many enrollments currently sit at each step node — lets the UI badge
// every node with a live count instead of one aggregate per journey. Grouped
// in SQL (not derived from a paginated enrollments page) so it stays correct
// regardless of how many enrollments the journey has.
//
// NOT a plain GROUP BY current_step_id — for a 'waiting' enrollment,
// executor.js's runWait() already advances current_step_id to the step AFTER
// the wait (that's the resume pointer for when the delayed job fires), so
// current_step_id names next Tuesday's step, not where the enrollment is
// actually sitting today. The step it's really "at" is the last one that
// truly ran, i.e. its most recent whitebox_journey_step_runs row — which for
// a wait-paused enrollment IS the wait step itself (insertStepRun logs the
// wait node before current_step_id gets bumped past it). A freshly-created
// enrollment has no step_run yet, so it falls back to current_step_id, which
// at creation time correctly equals the entry node. Only active/waiting
// enrollments count — completed/exited clear current_step_id to null
// already, and a failed one is stuck/dead, not meaningfully "at" a node.
export const stepCounts = async journeyId => {
  const rows = await db({ e: ENROLLMENTS }).where({ 'e.journey_id': journeyId }).whereIn('e.status', ['active', 'waiting'])
    .joinRaw(`LEFT JOIN LATERAL (
      SELECT step_id FROM ${STEP_RUNS} sr WHERE sr.enrollment_id = e.id ORDER BY sr.ran_at DESC LIMIT 1
    ) latest ON true`)
    .groupBy(db.raw('COALESCE(latest.step_id, e.current_step_id)'))
    .select(db.raw('COALESCE(latest.step_id, e.current_step_id) as step_id'))
    .count('* as count')
  return Object.fromEntries(rows.map(r => [r.step_id, Number(r.count)]))
}

// --- results ---
// The enrollment funnel: one grouped count, not five queries.
export const enrollmentCounts = async journeyId => {
  const rows = await db(ENROLLMENTS).where({ journey_id: journeyId }).groupBy('status').select('status').count('* as count')
  return Object.fromEntries(rows.map(r => [r.status, Number(r.count)]))
}

// How many enrollments were followed by one of the goal events, within that
// enrollment's OWN window. Not a cohort query: each row is measured from its
// own enrolled_at, so this can't be answered by counting events in a date
// range — hence EXISTS per enrollment rather than a join + DISTINCT.
//
// The merge clause is not defensive padding. whitebox_event_registry.passport_id
// is a denormalised string, deliberately not an FK (it's a copy lifted from the
// event payload), so passports.merge() never rewrites it — while enrollments DO
// get re-pointed to the survivor. Without resolving through the merge table,
// every event a person emitted before being merged would stop counting toward
// a goal they actually met.
export const goalMetCount = async (journeyId, goal) => {
  const events = goal?.event || []
  if (!events.length) return 0
  const [row] = await db({ e: ENROLLMENTS }).where({ 'e.journey_id': journeyId })
    .whereExists(function () {
      this.select(db.raw('1')).from({ l: 'whitebox_event_registry' })
        .whereIn('l.type', events)
        .whereRaw('l.occurred_at >= e.enrolled_at')
        .where(function () {
          this.whereRaw('l.passport_id = e.passport_id::text')
            .orWhereRaw(`l.passport_id IN (
              SELECT m.absorbed_id::text FROM whitebox_passports_merges m WHERE m.survivor_id = e.passport_id
            )`)
        })
      if (goal.window_days) {
        this.whereRaw(`l.occurred_at <= e.enrolled_at + (? || ' days')::interval`, [goal.window_days])
      }
    })
    .count('* as count')
  return Number(row.count)
}

// --- step run audit log (append-only) ---
export async function insertStepRun(fields) {
  const [row] = await db(STEP_RUNS).insert(fields).returning('*')
  return row
}
export const listStepRuns = enrollmentId => db(STEP_RUNS).where({ enrollment_id: enrollmentId }).orderBy('ran_at', 'asc')
