import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as executor from '../src/executor.js'

function makeJourneyRow(nodes, entry = 'a') {
  return {
    id: 'j1', name: 'Test Journey', status: 'active',
    trigger: JSON.stringify({ kind: 'manual' }),
    dedupe: JSON.stringify({ reenroll: false, cooldown_days: null }),
    steps: JSON.stringify({ entry, nodes }),
  }
}

function makeHarness({ journeyRow, enrollment, deps = {} } = {}) {
  const enrollments = new Map()
  enrollments.set(enrollment.id, { ...enrollment })
  const stepRuns = []

  const store = {
    getEnrollment: vi.fn(async id => enrollments.get(id)),
    getJourney: vi.fn(async id => (id === journeyRow.id ? journeyRow : null)),
    updateEnrollment: vi.fn(async (id, fields) => { const e = enrollments.get(id); Object.assign(e, fields); return e }),
    insertStepRun: vi.fn(async fields => { stepRuns.push(fields); return fields }),
  }

  const queueAdds = []
  const fakeQueue = {
    add: vi.fn(async (name, data, opts) => { queueAdds.push({ name, data, opts }); return { id: opts?.jobId } }),
    remove: vi.fn(async id => { queueAdds.push({ removed: id }) }),
  }

  const campaigns = deps.campaigns ?? { activateForPassport: vi.fn(async () => ({ sent: true, dry_run: true })) }
  const audiences = deps.audiences ?? { resolveAudience: vi.fn(async () => ({ count: 1, ids: ['p1'] })) }
  const selector = deps.selector ?? { resolve: vi.fn(async () => ({ count: 1, passports: [{ id: 'p1' }] })) }
  const facts = deps.facts ?? { record: vi.fn(async () => {}) }
  const webhooks = deps.webhooks ?? { send: vi.fn(async () => {}) }
  const notifyLifecycle = deps.notifyLifecycle ?? vi.fn()

  executor.init({ store, campaigns, audiences, selector, facts, webhooks, logger: console, notifyLifecycle, webhookSecret: deps.webhookSecret })
  executor.initQueue({ createQueue: () => fakeQueue, createWorker: () => {} })

  return { store, enrollments, stepRuns, queueAdds, fakeQueue, campaigns, audiences, selector, facts, webhooks, notifyLifecycle }
}

beforeEach(() => vi.clearAllMocks())

describe('processStep — full inline trampoline', () => {
  it('walks trigger_campaign -> branch(true) -> webhook -> exit to completion in one call', async () => {
    const journeyRow = makeJourneyRow({
      a: { kind: 'trigger_campaign', config: { campaign_id: 'c1' }, next: 'b' },
      b: { kind: 'branch', config: { condition: { audience_id: '11111111-1111-4111-8111-111111111111' } }, on_true: 'c', on_false: 'd' },
      c: { kind: 'webhook', config: { url: 'https://example.com/hook' }, next: 'e' },
      d: { kind: 'wait', config: { duration_ms: 300_000 }, next: 'e' },
      e: { kind: 'exit', config: { reason: 'done' } },
    })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr1', journey_id: 'j1', passport_id: 'p1', status: 'active', current_step_id: 'a', context: '{}' } })

    await executor.processStep('enr1')

    const enr = h.enrollments.get('enr1')
    expect(enr.status).toBe('completed')
    expect(enr.current_step_id).toBeNull()
    expect(h.stepRuns.map(s => s.kind)).toEqual(['trigger_campaign', 'branch', 'webhook', 'exit'])
    // journeyId rides along so the send is attributable to this journey, not
    // just to the campaign it borrowed content from (mail/sms migration 015/005)
    expect(h.campaigns.activateForPassport).toHaveBeenCalledWith('c1', 'p1', { idempotencyKey: 'journey.enr1.a', journeyId: 'j1' })
    expect(h.notifyLifecycle).toHaveBeenCalledWith('journey.completed', expect.objectContaining({ data: expect.objectContaining({ enrollment_id: 'enr1', journey_id: 'j1' }) }))
  })

  it('branch(false) path reaches the wait step and schedules a delayed re-advance', async () => {
    const journeyRow = makeJourneyRow({
      a: { kind: 'branch', config: { condition: { audience_id: '11111111-1111-4111-8111-111111111111' } }, on_true: 'c', on_false: 'd' },
      c: { kind: 'exit', config: {} },
      d: { kind: 'wait', config: { duration_ms: 300_000 }, next: 'e' },
      e: { kind: 'exit', config: {} },
    })
    const audiences = { resolveAudience: vi.fn(async () => ({ count: 0, ids: [] })) }   // branch -> false
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr2', journey_id: 'j1', passport_id: 'p2', status: 'active', current_step_id: 'a', context: '{}' }, deps: { audiences } })

    await executor.processStep('enr2')

    const enr = h.enrollments.get('enr2')
    expect(enr.status).toBe('waiting')
    expect(enr.current_step_id).toBe('e')
    expect(enr.next_action_at).toBeDefined()
    const waitJob = h.queueAdds.find(a => a.opts?.jobId === 'wait.enr2')
    expect(waitJob).toBeDefined()
    expect(waitJob.opts.delay).toBeGreaterThanOrEqual(0)
    expect(h.notifyLifecycle).not.toHaveBeenCalled()   // not completed yet
  })

  it('a resumed "waiting" enrollment flips back to active before the step runs', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr3', journey_id: 'j1', passport_id: 'p3', status: 'waiting', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr3')
    expect(h.enrollments.get('enr3').status).toBe('completed')   // active -> ran the exit step -> completed
  })

  it('does nothing for an already-terminal enrollment', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr4', journey_id: 'j1', passport_id: 'p4', status: 'completed', current_step_id: null, context: '{}' } })
    await executor.processStep('enr4')
    expect(h.store.updateEnrollment).not.toHaveBeenCalled()
    expect(h.stepRuns).toHaveLength(0)
  })

  it('freezes in place (no error, no reschedule) when the journey has been paused mid-flight', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'exit', config: {} } })
    journeyRow.status = 'paused'
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr5', journey_id: 'j1', passport_id: 'p5', status: 'active', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr5')
    expect(h.store.updateEnrollment).not.toHaveBeenCalled()
    expect(h.enrollments.get('enr5').status).toBe('active')
  })

  it('fails the enrollment when current_step_id references a node no longer in the graph', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr6', journey_id: 'j1', passport_id: 'p6', status: 'active', current_step_id: 'ghost', context: '{}' } })
    await executor.processStep('enr6')
    expect(h.enrollments.get('enr6').status).toBe('failed')
  })
})

describe('runTriggerCampaign', () => {
  it('exits with a clear reason when the campaigns dep is not configured', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'trigger_campaign', config: { campaign_id: 'c1' }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr7', journey_id: 'j1', passport_id: 'p7', status: 'active', current_step_id: 'a', context: '{}' }, deps: { campaigns: false } })
    await executor.processStep('enr7')
    expect(h.stepRuns).toHaveLength(1)   // never reached the exit node — exited straight from the trigger_campaign step
    expect(h.enrollments.get('enr7').exit_reason).toBe('campaigns plugin not configured')
  })

  it('continues to next regardless of the activation outcome, with the raw result riding into the step-run audit', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'trigger_campaign', config: { campaign_id: 'c1' }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const campaigns = { activateForPassport: vi.fn(async () => ({ sent: false, reason: 'suppressed_or_no_consent' })) }
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr8', journey_id: 'j1', passport_id: 'p8', status: 'active', current_step_id: 'a', context: '{}' }, deps: { campaigns } })
    await executor.processStep('enr8')
    expect(h.enrollments.get('enr8').status).toBe('completed')   // still advanced to the exit node
    expect(h.stepRuns[0].result).toContain('"sent":false')
    expect(h.stepRuns[0].result).toContain('suppressed_or_no_consent')
  })
})

describe('runBranch — filter condition (non-audience)', () => {
  it('calls selector.resolve scoped to the passport and follows on_true when matched', async () => {
    const journeyRow = makeJourneyRow({
      a: { kind: 'branch', config: { condition: { filter: { fact: { vip: { eq: true } } } } }, on_true: 'b', on_false: 'c' },
      b: { kind: 'exit', config: { reason: 'matched' } },
      c: { kind: 'exit', config: { reason: 'no-match' } },
    })
    const selector = { resolve: vi.fn(async () => ({ count: 1, passports: [{ id: 'p9' }] })) }
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr9', journey_id: 'j1', passport_id: 'p9', status: 'active', current_step_id: 'a', context: '{}' }, deps: { selector } })
    await executor.processStep('enr9')
    expect(selector.resolve).toHaveBeenCalledWith({ filter: { fact: { vip: { eq: true } } } }, { projection: 'people', scope: ['p9'] })
    expect(h.enrollments.get('enr9').exit_reason).toBe('matched')
  })
})

describe('runWait', () => {
  it('computes wait_until from a relative duration', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'wait', config: { duration_ms: 2 * 3_600_000 }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const before = Date.now()
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr10', journey_id: 'j1', passport_id: 'p10', status: 'active', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr10')
    const enr = h.enrollments.get('enr10')
    const waitMs = new Date(enr.next_action_at).getTime() - before
    expect(waitMs).toBeGreaterThan(2 * 3_600_000 - 1000)
    expect(waitMs).toBeLessThan(2 * 3_600_000 + 5000)
  })

  it('honors an absolute `until` timestamp over a relative duration', async () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    const journeyRow = makeJourneyRow({ a: { kind: 'wait', config: { until }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr11', journey_id: 'j1', passport_id: 'p11', status: 'active', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr11')
    expect(h.enrollments.get('enr11').next_action_at).toBe(until)
  })
})

describe('runSetFact', () => {
  it('records the fact tagged with the journey as source', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'set_fact', config: { key: 'journeyed', value: true }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr12', journey_id: 'j1', passport_id: 'p12', status: 'active', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr12')
    expect(h.facts.record).toHaveBeenCalledWith({ passport_id: 'p12', key: 'journeyed', value: true, type: undefined, source: 'journey:j1' })
  })
})

describe('runAddToList', () => {
  it('adds the passport to the configured static list', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'add_to_list', config: { segment_id: 'seg1' }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const audiences = { resolveAudience: vi.fn(), addToList: vi.fn(async () => ({ count: 7 })) }
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr20', journey_id: 'j1', passport_id: 'p20', status: 'active', current_step_id: 'a', context: '{}' }, deps: { audiences } })
    await executor.processStep('enr20')
    expect(audiences.addToList).toHaveBeenCalledWith('seg1', 'p20')
    // the run log carries the resulting size, which is what the enrollment
    // detail renders as a chip
    expect(JSON.parse(h.stepRuns.find(r => r.step_id === 'a').result)).toMatchObject({ added: true, list_size: 7 })
    expect(h.enrollments.get('enr20').status).toBe('completed')
  })

  // throws out of processStep, like every other step's dependency failure, so
  // the queue's retry/fail handling applies — it must not quietly continue as
  // though the person had been added
  it('throws rather than silently skipping when audiences is not wired', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'add_to_list', config: { segment_id: 'seg1' }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr21', journey_id: 'j1', passport_id: 'p21', status: 'active', current_step_id: 'a', context: '{}' }, deps: { audiences: {} } })
    await expect(executor.processStep('enr21')).rejects.toThrow(/audiences service not wired/)
    expect(h.stepRuns).toHaveLength(0)
  })
})

describe('runWebhook', () => {
  it('sends an objective, business-logic-free payload with a deterministic jobId', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'webhook', config: { url: 'https://example.com/hook', payload: { extra: 'x' } }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr13', journey_id: 'j1', passport_id: 'p13', status: 'active', current_step_id: 'a', context: '{}' }, deps: { webhookSecret: 'default-secret' } })
    await executor.processStep('enr13')
    expect(h.webhooks.send).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/hook',
      jobId: 'journey-webhook.enr13.a',
      secret: 'default-secret',
      data: expect.objectContaining({ type: 'journey.step.webhook', journey_id: 'j1', enrollment_id: 'enr13', passport_id: 'p13', step_id: 'a', extra: 'x' }),
    }))
  })

  it('a step-level secret overrides the plugin-level default', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'webhook', config: { url: 'https://example.com/hook', secret: 'step-secret' }, next: 'b' }, b: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr14', journey_id: 'j1', passport_id: 'p14', status: 'active', current_step_id: 'a', context: '{}' }, deps: { webhookSecret: 'default-secret' } })
    await executor.processStep('enr14')
    expect(h.webhooks.send).toHaveBeenCalledWith(expect.objectContaining({ secret: 'step-secret' }))
  })
})

describe('cancelWait', () => {
  it('removes the wait.<enrollmentId> job when the queue supports remove', async () => {
    const journeyRow = makeJourneyRow({ a: { kind: 'exit', config: {} } })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr15', journey_id: 'j1', passport_id: 'p15', status: 'waiting', current_step_id: 'a', context: '{}' } })
    await executor.cancelWait('enr15')
    expect(h.fakeQueue.remove).toHaveBeenCalledWith('wait.enr15')
  })
})

describe('regression: jobId/idempotencyKey must never contain `:`', () => {
  // BullMQ's Job.validateOptions throws "Custom Id cannot contain :" for any
  // custom id containing `:` UNLESS it happens to split into exactly 3 parts
  // (a legacy compat rule for old repeatable-job ids) — a real, live-only
  // failure mode our mocked queue/harness above can't catch on its own,
  // since it never validates jobId format. This test asserts the actual
  // constraint directly so a future `:`-separated id gets caught here
  // instead of only surfacing against a real BullMQ queue in production.
  it('every jobId/idempotencyKey produced by a full run is colon-free', async () => {
    const journeyRow = makeJourneyRow({
      a: { kind: 'trigger_campaign', config: { campaign_id: 'c1' }, next: 'c' },
      c: { kind: 'webhook', config: { url: 'https://example.com/hook' }, next: 'd' },
      d: { kind: 'wait', config: { duration_ms: 300_000 }, next: 'e' },
      e: { kind: 'exit', config: {} },
    })
    const h = makeHarness({ journeyRow, enrollment: { id: 'enr16', journey_id: 'j1', passport_id: 'p16', status: 'active', current_step_id: 'a', context: '{}' } })
    await executor.processStep('enr16')
    await executor.cancelWait('enr16')

    const ids = [
      ...h.queueAdds.map(a => a.opts?.jobId).filter(Boolean),
      ...h.queueAdds.map(a => a.removed).filter(Boolean),
      ...h.campaigns.activateForPassport.mock.calls.map(([, , opts]) => opts.idempotencyKey),
      ...h.webhooks.send.mock.calls.map(([args]) => args.jobId),
    ]
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).not.toContain(':')
  })
})
