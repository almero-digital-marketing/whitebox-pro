// Step executor — advances one enrollment through its journey's step graph.
// One BullMQ queue (`journeys:steps`), one job kind (`advance`). A `wait`
// step re-enqueues itself as a delayed job keyed `wait.<enrollmentId>`, so a
// manual exit can cancel it (queue.remove) before it fires.
//
// jobId separator is `.`, never `:` — BullMQ's Job.validateOptions rejects
// any custom id containing `:` UNLESS it splits into exactly 3 parts (a
// legacy compat rule for old repeatable-job ids). Depending on hitting that
// exact part count by accident is fragile, so every id here just avoids `:`
// entirely.
//
// IMPORTANT: `trigger_campaign` calls `campaigns.activateForPassport(...)`,
// never mail/sms directly — a journey step doesn't carry its own message
// content; it triggers a Campaign (channel + message live there), and
// campaigns' own activateForPassport() is what calls the gated
// `.queueSend` (never `.send`) internally. This executor has no direct
// mail/sms/passports dependency at all.
//
// Crash-safety: every step's DB write commits before the next step runs,
// and `current_step_id` is re-read fresh from the DB on every invocation —
// a mid-chain throw (BullMQ retries the whole `advance` job) resumes from
// wherever it actually left off, not from the start of the chain.

import { randomUUID } from 'node:crypto'
import { fromRow } from './journeys.js'

let store, campaigns, audiences, selector, facts, webhooks, logger, defaultWebhookSecret, notifyLifecycle
let stepsQueue

export function init(deps) {
  ({ store, campaigns, audiences, selector, facts, webhooks, logger, notifyLifecycle, webhookSecret: defaultWebhookSecret } = deps)
}

export function initQueue(queueModule) {
  stepsQueue = queueModule.createQueue('journeys:steps', {
    defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
  })
  queueModule.createWorker('journeys:steps', job => processStep(job.data.enrollment_id), {
    concurrency: 10,
  })
}

export async function advance(enrollmentId) {
  await stepsQueue.add('advance', { enrollment_id: enrollmentId }, { jobId: `advance.${enrollmentId}.${Date.now()}` })
}

// Cancels a pending wait-step wake-up, if any. Best-effort — DB status is
// the source of truth (matches the guarded `queue.remove` idiom already
// used in server-plugin-mail/src/outbox.js and server-plugin-sms/src/outbox.js).
export async function cancelWait(enrollmentId) {
  if (typeof stepsQueue.remove === 'function') await stepsQueue.remove(`wait.${enrollmentId}`).catch(() => {})
}

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined

async function fail(enr, reason) {
  await store.updateEnrollment(enr.id, { status: 'failed', exited_at: new Date().toISOString(), exit_reason: reason })
  logger?.warn?.({ enrollmentId: enr.id, reason }, 'journeys: enrollment failed')
}

// `journey` is passed in only for its NAME on the event. The caller has it
// loaded already (processStep), so this costs nothing, and the id alone is
// useless to anyone reading a feed — every journey row's detail column was blank
// because the payload carried no human-readable label at all. Optional so the
// notify never depends on it.
async function completeOrExit(enr, result, journey) {
  await store.updateEnrollment(enr.id, {
    status: 'completed', completed_at: new Date().toISOString(),
    exit_reason: result.reason || null, current_step_id: null,
  })
  notifyLifecycle?.('journey.completed', { type: 'journey.completed', data: { journey_id: enr.journey_id, journey_name: journey?.name ?? null, passport_id: enr.passport_id, enrollment_id: enr.id, reason: result.reason || null } })
}

const MAX_INLINE_HOPS = 25   // trampoline guard against a malformed cycle with no wait step

export async function processStep(enrollmentId, hops = 0) {
  const enr = await store.getEnrollment(enrollmentId)
  if (!enr || (enr.status !== 'active' && enr.status !== 'waiting')) return
  if (enr.status === 'waiting') await store.updateEnrollment(enr.id, { status: 'active' })   // the delayed wait job just fired

  const journey = fromRow(await store.getJourney(enr.journey_id))
  if (!journey || journey.status !== 'active') return   // paused/archived mid-flight — freeze in place, no reschedule

  const node = journey.steps.nodes[enr.current_step_id]
  if (!node) { await fail(enr, 'missing step node'); return }

  const context = p(enr.context) || {}
  const result = await runStep(node, { ...enr, context }, journey)

  await store.insertStepRun({
    id: randomUUID(), enrollment_id: enr.id, journey_id: journey.id,
    step_id: enr.current_step_id, kind: node.kind, result: JSON.stringify(result),
  })

  if (result.exit) { await completeOrExit(enr, result, journey); return }

  if (result.wait_until) {
    await store.updateEnrollment(enr.id, {
      status: 'waiting', current_step_id: result.next_step_id, next_action_at: result.wait_until,
      context: JSON.stringify({ ...context, ...result.context_patch }),
    })
    const delay = Math.max(0, new Date(result.wait_until).getTime() - Date.now())
    await stepsQueue.add('advance', { enrollment_id: enr.id }, { jobId: `wait.${enr.id}`, delay })
    return
  }

  await store.updateEnrollment(enr.id, {
    current_step_id: result.next_step_id, context: JSON.stringify({ ...context, ...result.context_patch }),
  })
  if (!result.next_step_id) return
  if (hops >= MAX_INLINE_HOPS) { await advance(enrollmentId); return }
  return processStep(enrollmentId, hops + 1)
}

async function runStep(node, enr, journey) {
  switch (node.kind) {
    case 'trigger_campaign': return runTriggerCampaign(node, enr)
    case 'wait':       return runWait(node)
    case 'branch':     return runBranch(node, enr)
    case 'set_fact':   return runSetFact(node, enr)
    case 'add_to_list': return runAddToList(node, enr)
    case 'webhook':    return runWebhook(node, enr, journey)
    case 'exit':       return { exit: true, reason: node.config.reason || 'reached exit step' }
    default:           return { exit: true, reason: `unknown step kind "${node.kind}"` }
  }
}

// No `on_missing_contact`-style branching here — the activation outcome
// (sent/suppressed/no_contact/dry_run) always rides along in `activation`,
// visible in the step-run audit trail; a journey that needs to react to it
// can already do so with a `branch` step reading a fact.
async function runTriggerCampaign(node, enr) {
  if (!campaigns) return { exit: true, reason: 'campaigns plugin not configured' }
  const idempotencyKey = `journey.${enr.id}.${enr.current_step_id}`
  // journeyId rides along so the resulting outbox row is attributable to THIS
  // journey, not just to the campaign whose content it borrowed — campaigns
  // has no way to know who called it (see its activateForPassport)
  const activation = await campaigns.activateForPassport(node.config.campaign_id, enr.passport_id, { idempotencyKey, journeyId: enr.journey_id })
  return { next_step_id: node.next, activation }
}

async function runWait(node) {
  const untilMs = node.config.until ? new Date(node.config.until).getTime() : Date.now() + (node.config.duration_ms || 0)
  return { wait_until: new Date(untilMs).toISOString(), next_step_id: node.next }
}

// Three condition kinds — an audience membership check, a deterministic
// fact/activity filter, or an LLM verdict (`judge`). See journeys.js's branch
// schema for why judge is scoped to one passport and what that costs.
//
// A branch cannot decline to decide. The selector's judge is written for
// AUDIENCES, where an unconfirmed person is simply not added — so `evaluate`
// drops a candidate whose verdict errored, and "dropped" reads as no-match here.
// That happens to be the safe reading (an unanswered question is not a yes, and
// `on_true` is the side that usually sends something), but it is safe by
// coincidence rather than by statement, so it is asserted rather than inherited:
// anything other than a confident yes goes down `on_false`, and says why.
async function runBranch(node, enr) {
  const cond = node.config.condition

  if (cond.audience_id) {
    const { ids } = await audiences.resolveAudience(cond.audience_id)
    return { next_step_id: ids.includes(enr.passport_id) ? node.on_true : node.on_false }
  }

  if (cond.judge) {
    // Errors are caught rather than thrown: a throw retries the step, and
    // retrying a model call that is failing for a structural reason (no API key,
    // a revoked one) just burns the enrollment's retry budget to arrive at the
    // same answer. `verdict` rides along into step_runs.result — the executor
    // stores whatever this returns — so an operator can see WHY someone went the
    // way they did, which matters more here than on the deterministic paths
    // where the condition alone explains it.
    let res
    try {
      res = await selector.resolve({ judge: cond.judge }, { projection: 'people', scope: [enr.passport_id] })
    } catch (err) {
      return {
        next_step_id: node.on_false,
        verdict: { match: false, error: err.message, reason: 'the judge could not be reached — took the No path' },
      }
    }
    const hit = res.passports.find(pp => pp.id === enr.passport_id)
    return {
      next_step_id: hit ? node.on_true : node.on_false,
      // `why`/`score` come back only for a confirmed match — the people
      // projection returns survivors, not verdicts — so a No records the outcome
      // without a reason. Carrying the model's reasoning for a No would mean
      // surfacing rejected verdicts out of selector.judge.evaluate.
      verdict: hit
        ? { match: true, score: hit.score, reason: hit.why }
        : { match: false, reason: 'the judge did not confirm this person' },
    }
  }

  const res = await selector.resolve({ filter: cond.filter }, { projection: 'people', scope: [enr.passport_id] })
  return { next_step_id: res.passports.some(pp => pp.id === enr.passport_id) ? node.on_true : node.on_false }
}

async function runSetFact(node, enr) {
  await facts.record({ passport_id: enr.passport_id, key: node.config.key, value: node.config.value, type: node.config.type, source: `journey:${enr.journey_id}` })
  return { next_step_id: node.next }
}

// Cherry-pick by automation: the same membership rows the People browser
// writes by hand, so a list can be filled either way and composes into an
// audience identically. addToList() is idempotent (onConflict ignore), which
// makes a re-run after a crash a no-op rather than an error.
async function runAddToList(node, enr) {
  if (!audiences?.addToList) throw new Error('audiences service not wired — cannot add to a list')
  const res = await audiences.addToList(node.config.segment_id, enr.passport_id)
  return { next_step_id: node.next, added: true, list_size: res?.count }
}

// Pure, dumb, one-way notification — the objective fact "this passport
// reached this step in this journey", nothing more. Whitebox never waits
// for or reacts to whatever the receiver does with it, and never encodes
// any assumption about external business meaning (see README).
// jobId makes a retried step idempotent — a second enqueue with the same id
// is a BullMQ no-op, so a step re-run after a crash doesn't double-fire.
async function runWebhook(node, enr, journey) {
  const payload = {
    type: 'journey.step.webhook', journey_id: journey.id, journey_name: journey.name,
    enrollment_id: enr.id, passport_id: enr.passport_id, step_id: enr.current_step_id,
    reached_at: new Date().toISOString(), context: enr.context,
    ...(node.config.payload || {}),
  }
  await webhooks.send({
    url: node.config.url, method: node.config.method, data: payload, headers: node.config.headers,
    secret: node.config.secret || defaultWebhookSecret,
    jobId: `journey-webhook.${enr.id}.${enr.current_step_id}`,
  })
  return { next_step_id: node.next }
}
