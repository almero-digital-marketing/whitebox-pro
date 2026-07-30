import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as service from '../src/service.js'

// service.js calls executor.advance()/cancelWait() as a side effect of
// enroll()/exitEnrollment() — mock the whole module so these tests exercise
// only service.js's own dedup/lifecycle logic, not the executor.
vi.mock('../src/executor.js', () => ({ advance: vi.fn(async () => {}), cancelWait: vi.fn(async () => {}) }))
import * as executor from '../src/executor.js'

function makeStore(overrides = {}) {
  return {
    getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{"kind":"manual"}', steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}', dedupe: '{"reenroll":false,"cooldown_days":null}' })),
    findAnyEnrollment: vi.fn(async () => null),
    findEnrollment: vi.fn(async () => null),
    lastTerminalEnrollment: vi.fn(async () => null),
    insertEnrollment: vi.fn(async (fields) => ({ ...fields })),
    getEnrollment: vi.fn(async () => ({ id: 'enr1', journey_id: 'j1', passport_id: 'p1', status: 'active' })),
    updateEnrollment: vi.fn(async (id, fields) => ({ id, ...fields })),
    ...overrides,
  }
}

function makeLock() {
  const order = []
  return {
    order,
    acquire: vi.fn(async (resource) => { order.push(`acquire:${resource}`); return { resource } }),
    release: vi.fn(async (held) => { order.push(`release:${held.resource}`) }),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('service.enroll — dedup policy', () => {
  it('reenroll:false blocks enrollment if ANY prior row exists (even a terminal one)', async () => {
    const store = makeStore({ findAnyEnrollment: vi.fn(async () => ({ id: 'old-enr' })) })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).toBeNull()
    expect(store.insertEnrollment).not.toHaveBeenCalled()
  })

  it('reenroll:true with no cooldown blocks only a currently-running enrollment', async () => {
    const store = makeStore({
      getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{"kind":"manual"}', steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}', dedupe: '{"reenroll":true,"cooldown_days":null}' })),
      findEnrollment: vi.fn(async () => ({ id: 'running-enr' })),
    })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).toBeNull()
  })

  it('reenroll:true allows a fresh enrollment when no currently-running row exists', async () => {
    const store = makeStore({
      getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{"kind":"manual"}', steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}', dedupe: '{"reenroll":true,"cooldown_days":null}' })),
      findEnrollment: vi.fn(async () => null),
    })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).not.toBeNull()
    expect(store.insertEnrollment).toHaveBeenCalled()
    expect(executor.advance).toHaveBeenCalled()
  })

  it('cooldown_days blocks re-enrollment within the window', async () => {
    const store = makeStore({
      getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{"kind":"manual"}', steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}', dedupe: '{"reenroll":true,"cooldown_days":7}' })),
      findEnrollment: vi.fn(async () => null),
      lastTerminalEnrollment: vi.fn(async () => ({ completed_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })),   // 2 days ago
    })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).toBeNull()
  })

  it('cooldown_days allows re-enrollment once the window has passed', async () => {
    const store = makeStore({
      getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{"kind":"manual"}', steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}', dedupe: '{"reenroll":true,"cooldown_days":7}' })),
      findEnrollment: vi.fn(async () => null),
      lastTerminalEnrollment: vi.fn(async () => ({ completed_at: new Date(Date.now() - 10 * 86_400_000).toISOString() })),   // 10 days ago
    })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).not.toBeNull()
  })

  it('refuses to enroll into a non-active (draft/paused) journey', async () => {
    const store = makeStore({ getJourney: vi.fn(async () => ({ id: 'j1', status: 'draft', trigger: '{"kind":"manual"}', steps: '{}', dedupe: '{}' })) })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).toBeNull()
    expect(store.insertEnrollment).not.toHaveBeenCalled()
  })
})

describe('service.enroll — lock brackets the dedup check', () => {
  it('acquires the per-journey-per-passport lock before checking, releases after', async () => {
    const store = makeStore()
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    await service.enroll('j1', 'p1')
    expect(lock.order).toEqual(['acquire:journeys:enroll:j1:p1', 'release:journeys:enroll:j1:p1'])
  })

  it('releases the lock even when insertEnrollment throws', async () => {
    const store = makeStore({ insertEnrollment: vi.fn(async () => { throw new Error('db down') }) })
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    await expect(service.enroll('j1', 'p1')).rejects.toThrow('db down')
    expect(lock.order).toEqual(['acquire:journeys:enroll:j1:p1', 'release:journeys:enroll:j1:p1'])
  })

  it('skips the attempt (returns null) when the lock is unavailable, rather than proceeding unguarded', async () => {
    const store = makeStore()
    const lock = { acquire: vi.fn(async () => { throw new Error('lock timeout') }), release: vi.fn() }
    const logger = { warn: vi.fn(), error: vi.fn() }
    service.init({ store, lock, logger, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const result = await service.enroll('j1', 'p1')
    expect(result).toBeNull()
    expect(store.insertEnrollment).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('requires a passport_id', async () => {
    const store = makeStore()
    const lock = makeLock()
    service.init({ store, lock, logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    await expect(service.enroll('j1', null)).rejects.toMatchObject({ status: 400 })
  })
})

describe('service.exitEnrollment', () => {
  it('cancels the pending wait job and marks the enrollment exited', async () => {
    const store = makeStore()
    const notifyLifecycle = vi.fn()
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle, onTriggerChange: vi.fn() })
    const result = await service.exitEnrollment('enr1', 'user requested')
    expect(executor.cancelWait).toHaveBeenCalledWith('enr1')
    expect(store.updateEnrollment).toHaveBeenCalledWith('enr1', expect.objectContaining({ status: 'exited', exit_reason: 'user requested' }))
    expect(notifyLifecycle).toHaveBeenCalledWith('journey.exited', expect.objectContaining({ data: expect.objectContaining({ enrollment_id: 'enr1', reason: 'user requested' }) }))
    expect(result.status).toBe('exited')
  })

  it('404s on an unknown enrollment', async () => {
    const store = makeStore({ getEnrollment: vi.fn(async () => null) })
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    await expect(service.exitEnrollment('ghost')).rejects.toMatchObject({ status: 404 })
  })
})

describe('service — trigger-change hook + editability guard', () => {
  it('activateJourney calls onTriggerChange', async () => {
    const store = makeStore({ getJourney: vi.fn(async () => ({ id: 'j1', status: 'draft', trigger: '{}', steps: '{}', dedupe: '{}' })), updateJourney: vi.fn(async (id, fields) => ({ id, status: 'active', trigger: '{}', steps: '{}', dedupe: '{}', ...fields })) })
    const onTriggerChange = vi.fn()
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle: vi.fn(), onTriggerChange })
    await service.activateJourney('j1')
    expect(onTriggerChange).toHaveBeenCalled()
  })

  it('patchJourney refuses to edit an active journey', async () => {
    const store = makeStore({ getJourney: vi.fn(async () => ({ id: 'j1', status: 'active', trigger: '{}', steps: '{}', dedupe: '{}' })) })
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    await expect(service.patchJourney('j1', { name: 'x' })).rejects.toMatchObject({ status: 409 })
  })
})

describe('service.getStepCounts', () => {
  it('passes the journey id straight through to store.stepCounts', async () => {
    const store = makeStore({ stepCounts: vi.fn(async () => ({ a1: 2, b2: 1 })) })
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    const counts = await service.getStepCounts('j1')
    expect(store.stepCounts).toHaveBeenCalledWith('j1')
    expect(counts).toEqual({ a1: 2, b2: 1 })
  })
})

// docs/10-plugin-status.md — the plugin describes its own health; the board
// holds no journeys knowledge and must not be able to be taken down by it.
describe('service.status', () => {
  const LIVE = { active_journeys: 2, enrolled: 9, stuck: 0 }
  const ACTIVITY = { started: 5, completed: 3, failed: 0 }

  function setup({ live = LIVE, activity = ACTIVITY } = {}) {
    const store = makeStore({
      liveCounts: vi.fn(async () => { if (live instanceof Error) throw live; return live }),
      activityCounts: vi.fn(async () => { if (activity instanceof Error) throw activity; return activity }),
    })
    service.init({ store, lock: makeLock(), logger: { warn: vi.fn(), error: vi.fn() }, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn() })
    return store
  }
  const at = (s, key) => s.metrics.find(m => m.key === key)

  it('reports live journey/enrollment state alongside the windowed flow', async () => {
    setup()
    const s = await service.status({ since: new Date('2026-07-30T00:00:00.000Z') })
    expect(s.label).toBe('journeys')
    expect(s.metrics.map(m => m.key)).toEqual(['active journeys', 'enrolled', 'started', 'completed', 'failed', 'stuck'])
    expect(at(s, 'active journeys').value).toBe(2)
    expect(at(s, 'enrolled').value).toBe(9)
    expect(at(s, 'completed').value).toBe(3)
  })

  // Only the two that mean a person is stranded mid-journey. `enrolled` is
  // large-and-fine; a count being big is not a fault.
  it('marks only failed and stuck as bad', async () => {
    setup({ live: { ...LIVE, stuck: 4 }, activity: { ...ACTIVITY, failed: 2 } })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['failed', 'stuck'])
    expect(at(s, 'enrolled').severity).toBeUndefined()
  })

  it('windows the activity read on `since`, but asks for live state with a grace cutoff in the past', async () => {
    const since = new Date('2026-07-30T00:00:00.000Z')
    const store = setup()
    await service.status({ since })
    expect(store.activityCounts).toHaveBeenCalledWith(since)
    // not now(), and not `since` either — the grace margin is what keeps normal
    // queue lag out of `stuck`
    const [cutoff] = store.liveCounts.mock.calls[0]
    expect(cutoff).toBeInstanceOf(Date)
    expect(cutoff.getTime()).toBeLessThan(Date.now())
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })

  it('still answers without a `since` — the whole history, not a crash', async () => {
    const store = setup()
    const s = await service.status()
    expect(store.activityCounts).toHaveBeenCalledWith(new Date(0))
    expect(at(s, 'started').value).toBe(5)
  })

  it('names the stranded enrollments in the note, and stays quiet when there are none', async () => {
    setup({ live: { ...LIVE, stuck: 1 } })
    expect((await service.status({ since: new Date() })).note).toMatch(/1 enrollment past its wake-up time/)
    setup()
    expect((await service.status({ since: new Date() })).note).toBeNull()
  })

  // A failing status() must not take the board down, and the metrics it CAN
  // still answer are worth more than a uniform zero — zero reads as healthy.
  it('survives a failing read: reports the half it got, and says the rest is missing', async () => {
    setup({ live: new Error('db down') })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.map(m => m.key)).toEqual(['started', 'completed', 'failed'])
    expect(s.note).toMatch(/could not be read/)
  })

  it('survives both reads failing', async () => {
    setup({ live: new Error('db down'), activity: new Error('db down') })
    const s = await service.status({ since: new Date() })
    expect(s.metrics).toEqual([])
    expect(s.note).toMatch(/could not be read/)
  })
})

describe('service.getResults', () => {
  const GOAL = { event: ['booking.created'], window_days: 14 }
  function setup({ goal = null, counts = {}, met = 0, mail, sms } = {}) {
    const store = makeStore({
      getJourney: vi.fn(async () => ({
        id: 'j1', status: 'active', trigger: '{"kind":"manual"}',
        steps: '{"entry":"a","nodes":{"a":{"kind":"exit","config":{}}}}',
        dedupe: '{"reenroll":false,"cooldown_days":null}',
        goal: goal ? JSON.stringify(goal) : null,
      })),
      enrollmentCounts: vi.fn(async () => counts),
      goalMetCount: vi.fn(async () => met),
    })
    service.init({ store, lock: makeLock(), logger: console, notifyLifecycle: vi.fn(), onTriggerChange: vi.fn(), mail, sms })
    return store
  }

  it('totals the enrollment funnel and reports goal conversion', async () => {
    const store = setup({ goal: GOAL, counts: { completed: 8, active: 2, exited: 1 }, met: 5 })
    const r = await service.getResults('j1')
    expect(r.enrollments).toEqual({ total: 11, completed: 8, active: 2, exited: 1 })
    expect(r.goal_met).toBe(5)
    expect(store.goalMetCount).toHaveBeenCalledWith('j1', GOAL)
  })

  // "nobody converted" and "you never said what converting means" are
  // different answers — 0 would state the first while meaning the second
  it('returns goal_met null, not 0, when the journey has no goal', async () => {
    const store = setup({ goal: null, counts: { completed: 3 } })
    const r = await service.getResults('j1')
    expect(r.goal_met).toBeNull()
    expect(r.goal).toBeNull()
    expect(store.goalMetCount).not.toHaveBeenCalled()
  })

  it('asks each wired channel what it did FOR THIS JOURNEY, and drops the silent ones', async () => {
    const mail = { funnel: vi.fn(async () => ({ total: 6, sent: 6, delivered: 5, opened: 3 })) }
    const sms = { funnel: vi.fn(async () => ({ total: 0, sent: 0 })) }
    setup({ counts: { completed: 6 }, mail, sms })
    const r = await service.getResults('j1')
    expect(mail.funnel).toHaveBeenCalledWith({ journeyId: 'j1' })
    expect(sms.funnel).toHaveBeenCalledWith({ journeyId: 'j1' })
    expect(Object.keys(r.delivery)).toEqual(['email'])
  })

  it('omits delivery entirely when no channel plugin is wired', async () => {
    setup({ counts: { completed: 1 } })
    expect((await service.getResults('j1')).delivery).toEqual({})
  })

  it('survives a channel plugin that throws', async () => {
    const mail = { funnel: vi.fn(async () => { throw new Error('db down') }) }
    setup({ counts: { completed: 1 }, mail })
    expect((await service.getResults('j1')).delivery).toEqual({})
  })
})
