// Turns a journey's `trigger` config into actual `service.enroll()` calls.
// Two kinds — event, audience — both AUTOMATIC. Manual enrollment isn't a
// third trigger kind: every journey supports it regardless of its configured
// trigger, called directly from rest.js/mcp.js with no involvement from this
// file at all (service.enroll() never reads `trigger`).
//
// Event triggers: one Redis subscription per DISTINCT event name referenced
// by any active event-triggered journey, shared across journeys that listen
// to the same event — matches the sharing already done for mail/sms/voip's
// own notify() consumers.
//
// Audience triggers: a debounced recheck on `awareness.recorded` (the fast
// path) plus a periodic full sweep (the only path that's ever complete —
// core's facts.record() never publishes an event, only awareness.record()
// does, so a plugin writing facts with no matching awareness exposure won't
// fire the fast path for that passport; the sweep is what keeps this from
// being silently incomplete).

let store, events, service, audiences, logger
let recheckQueue
const eventSubs = new Map()   // event name -> handler fn (events.unsubscribe needs the same fn reference)
let audienceFastPathOn = false
let debounceMs = 5000
let sweepIntervalMs = 15 * 60_000

const AWARENESS_RECORDED = 'awareness.recorded'

export function init(deps) {
  ({ store, events, service, audiences, logger } = deps)
  if (deps.debounceMs) debounceMs = deps.debounceMs
  if (deps.sweepIntervalMs) sweepIntervalMs = deps.sweepIntervalMs
  // Reset subscription bookkeeping — a (re-)init means any handler already
  // registered on a prior `events` instance is gone, so tracking it as still
  // subscribed would make refresh() skip re-subscribing on the new instance.
  eventSubs.clear()
  audienceFastPathOn = false
}

export function initQueue(queueModule) {
  recheckQueue = queueModule.createQueue('journeys:audiences')
  queueModule.createWorker('journeys:audiences', job =>
    job.name === 'sweep' ? runSweep() : runRecheck(job.data.passport_id))
}

// Registers the repeatable sweep job. Idempotent across restarts — BullMQ
// dedupes repeatable jobs that share the same jobId + repeat options.
export async function startSweep() {
  await recheckQueue.add('sweep', {}, { repeat: { every: sweepIntervalMs }, jobId: 'audience-sweep' })
}

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

async function onEvent(eventName, payload) {
  const rows = await store.activeEventJourneys(eventName)
  const passportId = get(payload, 'data.passport_id')
  if (!passportId) return
  for (const row of rows) {
    await service.enroll(row.id, passportId, { source: 'event', event: eventName, data: payload?.data ?? payload })
      .catch(err => logger?.error?.({ err, journeyId: row.id, eventName }, 'journeys: event-trigger enroll failed'))
  }
}

async function onAwarenessRecorded(payload) {
  const passportId = payload?.data?.passport_id
  if (!passportId) return
  // debounce via cancel-then-readd — BullMQ does not reset an existing
  // delayed job's timer on a duplicate add() with the same jobId (same
  // idiom as server-plugin-mail/sms's outbox.js). Separator is `.`, not `:`
  // — BullMQ's Job.validateOptions rejects a custom id containing `:`
  // unless it happens to split into exactly 3 parts (see executor.js).
  if (typeof recheckQueue.remove === 'function') await recheckQueue.remove(`recheck.${passportId}`).catch(() => {})
  await recheckQueue.add('recheck', { passport_id: passportId }, { jobId: `recheck.${passportId}`, delay: debounceMs })
}

// Resolves a trigger's set of matching passport ids across ALL its configured
// audiences, combined per `op` — 'any' (union: in at least one) or 'all'
// (intersection: in every one) — same op vocabulary as Audiences' own rule.
async function resolveTriggerIds(trigger) {
  const sets = await Promise.all(trigger.audience_ids.map(id => audiences.resolveAudience(id).then(r => new Set(r.ids))))
  if (!sets.length) return new Set()
  if (trigger.op === 'all') return sets.reduce((a, b) => new Set([...a].filter(id => b.has(id))))
  const union = new Set()
  for (const s of sets) for (const id of s) union.add(id)
  return union
}

async function runRecheck(passportId) {
  const rows = await store.activeAudienceJourneys()
  for (const row of rows) {
    const trigger = p(row.trigger)
    const ids = await resolveTriggerIds(trigger)
    if (ids.has(passportId)) {
      await service.enroll(row.id, passportId, { source: 'audience' })
        .catch(err => logger?.error?.({ err, journeyId: row.id, passportId }, 'journeys: audience recheck enroll failed'))
    }
  }
}

async function runSweep() {
  const rows = await store.activeAudienceJourneys()
  for (const row of rows) {
    const trigger = p(row.trigger)
    const ids = await resolveTriggerIds(trigger)
    for (const passportId of ids) {
      await service.enroll(row.id, passportId, { source: 'audience-sweep' })
        .catch(err => logger?.error?.({ err, journeyId: row.id, passportId }, 'journeys: sweep enroll failed'))
    }
  }
}

// Recomputes the desired subscription set. Call once at startup, and again
// after anything that could change which journeys are active or what they
// trigger on — service.js wires this in as its injected onTriggerChange.
export async function refresh() {
  const desired = new Set(await store.distinctActiveEventNames())
  for (const name of desired) {
    if (!eventSubs.has(name)) {
      const handler = data => onEvent(name, data).catch(err => logger?.error?.({ err, eventName: name }, 'journeys: event handler failed'))
      events.subscribe(name, handler)
      eventSubs.set(name, handler)
    }
  }
  for (const [name, handler] of eventSubs) {
    if (!desired.has(name)) { events.unsubscribe(name, handler); eventSubs.delete(name) }
  }

  const anyAudienceJourneys = (await store.activeAudienceJourneys()).length > 0
  if (anyAudienceJourneys && !audienceFastPathOn) {
    events.subscribe(AWARENESS_RECORDED, onAwarenessRecorded)
    audienceFastPathOn = true
  } else if (!anyAudienceJourneys && audienceFastPathOn) {
    events.unsubscribe(AWARENESS_RECORDED, onAwarenessRecorded)
    audienceFastPathOn = false
  }
}
