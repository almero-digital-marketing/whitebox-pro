// Service layer — the single implementation REST and MCP both call. No
// transport concerns here. Enrollment dedup/cooldown policy lives here;
// step execution lives in executor.js (this module calls into it to kick
// off/cancel a run, never re-implements queue mechanics itself).

import { randomUUID } from 'node:crypto'
import { validate, fromRow, fromEnrollmentRow, fromStepRunRow, isEditable } from './journeys.js'
import * as executor from './executor.js'

let store, lock, logger, notifyLifecycle, onTriggerChange, mail, sms

// `onTriggerChange` is called after anything that could change the active
// set of event/audience triggers (activate/pause/patch/delete) — wired by
// index.js to triggers.refresh(). Kept as an injected callback rather than
// importing triggers.js directly here to avoid a service<->triggers cycle
// (triggers.js calls service.enroll()).
export function init(deps) {
  ({ store, lock, logger, notifyLifecycle, onTriggerChange, mail, sms } = deps)
}

async function getOr404(id) {
  const row = await store.getJourney(id)
  if (!row) { const e = new Error('journey not found'); e.status = 404; throw e }
  return fromRow(row)
}

// --- journeys CRUD ---
export const listJourneys = async () => (await store.listJourneys()).map(fromRow)
export async function searchJourneys(opts = {}) {
  const { total, rows } = await store.searchJourneys(opts)
  return { total, rows: rows.map(fromRow) }
}
export const getJourney = async id => fromRow(await store.getJourney(id))

export async function createJourney(input) {
  const j = validate(input)
  if (!j.name || !j.trigger || !j.steps) { const e = new Error('name, trigger, and steps are required'); e.status = 400; throw e }
  const row = await store.insertJourney({
    id: randomUUID(), name: j.name, status: 'draft',
    trigger: JSON.stringify(j.trigger), steps: JSON.stringify(j.steps),
    dedupe: JSON.stringify(j.dedupe || { reenroll: false, cooldown_days: null }),
    goal: j.goal ? JSON.stringify(j.goal) : null,
  })
  return fromRow(row)
}

export async function patchJourney(id, input) {
  const existing = await getOr404(id)
  if (!isEditable(existing)) { const e = new Error('journey is active — pause it before editing'); e.status = 409; throw e }
  const j = validate({ ...input, id })
  const fields = {}
  if (j.name !== undefined) fields.name = j.name
  if (j.trigger !== undefined) fields.trigger = JSON.stringify(j.trigger)
  if (j.steps !== undefined) fields.steps = JSON.stringify(j.steps)
  if (j.dedupe !== undefined) fields.dedupe = JSON.stringify(j.dedupe)
  // null clears it — a journey is allowed to stop having a goal
  if (j.goal !== undefined) fields.goal = j.goal ? JSON.stringify(j.goal) : null
  const row = await store.updateJourney(id, fields)
  if (!row) { const e = new Error('journey not found'); e.status = 404; throw e }
  onTriggerChange?.()
  return fromRow(row)
}

export async function deleteJourney(id) {
  const n = await store.deleteJourney(id)
  onTriggerChange?.()
  return n
}

export async function activateJourney(id) {
  const existing = await getOr404(id)
  if (existing.status !== 'draft' && existing.status !== 'paused') {
    const e = new Error('only a draft or paused journey can be activated'); e.status = 409; throw e
  }
  const row = await store.updateJourney(id, { status: 'active' })
  onTriggerChange?.()
  return fromRow(row)
}

export async function pauseJourney(id) {
  const existing = await getOr404(id)
  if (existing.status !== 'active') { const e = new Error('only an active journey can be paused'); e.status = 409; throw e }
  const row = await store.updateJourney(id, { status: 'paused' })
  onTriggerChange?.()
  return fromRow(row)
}

// --- enrollment ---
// Dedup is a POLICY (reenroll/cooldown_days), not a DB invariant — a
// reenroll:true journey legitimately has multiple rows per passport over
// time, so this is enforced here under a lock, not a unique constraint.
async function canEnroll(journeyId, passportId, dedupe) {
  if (!dedupe?.reenroll) return !(await store.findAnyEnrollment(journeyId, passportId))
  if (await store.findEnrollment(journeyId, passportId)) return false   // already running
  if (dedupe.cooldown_days) {
    const last = await store.lastTerminalEnrollment(journeyId, passportId)
    const lastAt = last?.completed_at || last?.exited_at
    if (lastAt && Date.now() - new Date(lastAt).getTime() < dedupe.cooldown_days * 86_400_000) return false
  }
  return true
}

export async function enroll(journeyId, passportId, meta = {}) {
  if (!passportId) { const e = new Error('passport_id is required'); e.status = 400; throw e }
  let held = null
  try {
    held = await lock.acquire(`journeys:enroll:${journeyId}:${passportId}`, 5000)
  } catch (err) {
    logger?.warn?.({ err, journeyId, passportId }, 'journeys: enroll lock unavailable, skipping this attempt')
    return null
  }
  try {
    const journey = fromRow(await store.getJourney(journeyId))
    if (!journey || journey.status !== 'active') return null
    if (!(await canEnroll(journeyId, passportId, journey.dedupe))) return null

    const id = randomUUID()
    const row = await store.insertEnrollment({
      id, journey_id: journeyId, passport_id: passportId, status: 'active',
      current_step_id: journey.steps.entry,
      // journey_version is a materialized snapshot at enroll time, not a live
      // reference — a later edit doesn't retroactively change what an
      // in-flight enrollment is considered to be running (see journeys.js's
      // isEditable note on why full graph versioning is a v2 deferral).
      context: JSON.stringify({ trigger: meta, journey_version: journey.updated_at }),
    })
    notifyLifecycle?.('journey.enrolled', { type: 'journey.enrolled', data: { journey_id: journeyId, passport_id: passportId, enrollment_id: id } })
    executor.advance(id).catch(err => logger?.error?.({ err, enrollmentId: id }, 'journeys: initial advance failed'))
    return fromEnrollmentRow(row)
  } finally {
    if (held) await lock.release(held).catch(() => {})
  }
}

export async function exitEnrollment(enrollmentId, reason = 'manual') {
  const enr = await store.getEnrollment(enrollmentId)
  if (!enr) { const e = new Error('enrollment not found'); e.status = 404; throw e }
  await executor.cancelWait(enrollmentId)
  const row = await store.updateEnrollment(enrollmentId, {
    status: 'exited', exited_at: new Date().toISOString(), exit_reason: reason,
  })
  notifyLifecycle?.('journey.exited', { type: 'journey.exited', data: { journey_id: enr.journey_id, passport_id: enr.passport_id, enrollment_id: enrollmentId, reason } })
  return fromEnrollmentRow(row)
}

// --- enrollment inspection ---
export const listEnrollments = async (journeyId, opts) => (await store.listEnrollments(journeyId, opts)).map(fromEnrollmentRow)
// Every journey one PERSON has been through — the person-centric counterpart
// of the above, for the People module's detail view. Keeps journey_name/status
// from the join rather than mapping through fromEnrollmentRow, which is shaped
// for the per-journey list and would drop them.
export const listEnrollmentsByPassport = async (passportId, opts) =>
  (await store.listEnrollmentsByPassport(passportId, opts)).map(r => ({
    ...fromEnrollmentRow(r), journey_name: r.journey_name, journey_status: r.journey_status,
  }))
// live count of enrollments currently sitting at each step node — { step_id: count }
export const getStepCounts = journeyId => store.stepCounts(journeyId)

// Did this journey work? Three answers, in widening order of "so what":
//   enrollments — how many people it took in and where they ended up
//   delivery    — what the channels actually did with the messages it caused
//   goal        — how many of those people then did the thing it exists for
//
// Delivery is read from the channel plugins by journey_id (mail/sms migration
// 015/005), never from their tables: journeys asks them what they did on its
// behalf, the same boundary campaigns keeps. A channel that isn't wired is
// simply absent, and so is one that has nothing for this journey.
export async function getResults(journeyId) {
  const j = fromRow(await getOr404(journeyId))
  const enrollments = await store.enrollmentCounts(journeyId)
  const total = Object.values(enrollments).reduce((a, b) => a + b, 0)

  const delivery = {}
  for (const [channel, svc] of [['email', mail], ['sms', sms]]) {
    if (typeof svc?.funnel !== 'function') continue
    try {
      const f = await svc.funnel({ journeyId })
      if (f.total > 0) delivery[channel] = f
    } catch (err) {
      logger?.warn({ err }, 'journeys: %s funnel failed for journey %s', channel, journeyId)
    }
  }

  // null (not 0) when there's no goal: "nobody converted" and "you never said
  // what converting means" are different answers and the UI shows them
  // differently
  const met = j.goal ? await store.goalMetCount(journeyId, j.goal) : null
  return {
    journey_id: journeyId,
    goal: j.goal,
    enrollments: { total, ...enrollments },
    goal_met: met,
    delivery,
  }
}

export async function getEnrollment(id) {
  const row = await store.getEnrollment(id)
  if (!row) return null
  const stepRuns = (await store.listStepRuns(id)).map(fromStepRunRow)
  return { ...fromEnrollmentRow(row), step_runs: stepRuns }
}
