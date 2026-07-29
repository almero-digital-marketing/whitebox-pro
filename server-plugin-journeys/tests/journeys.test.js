import { describe, it, expect } from 'vitest'
import { validate, StepsGraph, isEditable } from '../src/journeys.js'

const validGraph = () => ({
  entry: 'a',
  nodes: {
    a: { kind: 'trigger_campaign', config: { campaign_id: '11111111-1111-4111-8111-111111111111' }, next: 'b' },
    b: { kind: 'exit', config: {} },
  },
})

describe('validate() — trigger/steps/dedupe shape', () => {
  it('accepts a minimal event-trigger journey with one event', () => {
    const j = validate({ name: 'Test', trigger: { kind: 'event', event: ['mail.sent'] }, steps: validGraph() })
    expect(j.name).toBe('Test')
    expect(j.trigger).toEqual({ kind: 'event', event: ['mail.sent'] })
  })

  it('accepts an event trigger listing several event names', () => {
    const j = validate({ trigger: { kind: 'event', event: ['mail.sent', 'sms.sent'] } })
    expect(j.trigger.event).toEqual(['mail.sent', 'sms.sent'])
  })

  it('accepts an empty event list (not yet configured, matches a fresh draft)', () => {
    const j = validate({ trigger: { kind: 'event', event: [] } })
    expect(j.trigger.event).toEqual([])
  })

  it('rejects a bare string for event (must be an array now)', () => {
    expect(() => validate({ trigger: { kind: 'event', event: 'mail.sent' } })).toThrow(/invalid journey/)
  })

  it('rejects an empty string inside the event array', () => {
    expect(() => validate({ trigger: { kind: 'event', event: [''] } })).toThrow(/invalid journey/)
  })

  // 'manual' is deliberately NOT a trigger kind — every journey configures
  // exactly one automatic trigger (event or audience); manual enrollment is
  // a separate, always-available capability (service.enroll(), independent
  // of `trigger`), not a third config here. See journeys.js's Trigger comment.
  it('rejects "manual" as a trigger kind', () => {
    expect(() => validate({ trigger: { kind: 'manual' } })).toThrow(/invalid journey/)
  })

  it('accepts a minimal audience trigger with one audience, defaulting op to "any"', () => {
    const j = validate({ trigger: { kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111'] } })
    expect(j.trigger).toEqual({ kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111'], op: 'any' })
  })

  it('accepts an audience trigger listing several audiences with an explicit op', () => {
    const j = validate({ trigger: { kind: 'audience', audience_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], op: 'all' } })
    expect(j.trigger.audience_ids).toHaveLength(2)
    expect(j.trigger.op).toBe('all')
  })

  it('accepts an empty audience list (not yet configured, matches a fresh draft)', () => {
    const j = validate({ trigger: { kind: 'audience', audience_ids: [] } })
    expect(j.trigger.audience_ids).toEqual([])
  })

  it('rejects a non-uuid inside audience_ids', () => {
    expect(() => validate({ trigger: { kind: 'audience', audience_ids: ['not-a-uuid'] } })).toThrow(/invalid journey/)
  })

  it('rejects an unrecognized op value', () => {
    expect(() => validate({ trigger: { kind: 'audience', audience_ids: [], op: 'majority' } })).toThrow(/invalid journey/)
  })

  it('defaults dedupe to reenroll:false, cooldown_days:null', () => {
    const j = validate({ dedupe: {} })
    expect(j.dedupe).toEqual({ reenroll: false, cooldown_days: null })
  })
})

describe('StepsGraph — dangling references', () => {
  it('rejects an entry that is not a node in the graph', () => {
    const parsed = StepsGraph.safeParse({ entry: 'missing', nodes: { a: { kind: 'exit', config: {} } } })
    expect(parsed.success).toBe(false)
  })

  it('rejects a node whose `next` points at an unknown step', () => {
    const graph = { entry: 'b', nodes: { b: { kind: 'trigger_campaign', config: { campaign_id: '11111111-1111-4111-8111-111111111111' }, next: 'ghost' } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects a branch missing on_true/on_false', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'branch', config: { condition: { audience_id: '11111111-1111-4111-8111-111111111111' } } } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects a non-exit, non-branch node missing `next`', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'trigger_campaign', config: { campaign_id: '11111111-1111-4111-8111-111111111111' } } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })
})

describe('StepsGraph — cycles are explicitly ALLOWED', () => {
  it('accepts a branch looping back through a wait step (retry-until-match pattern)', () => {
    const graph = {
      entry: 'wait1',
      nodes: {
        wait1: { kind: 'wait', config: { duration_ms: 300_000 }, next: 'check' },
        check: { kind: 'branch', config: { condition: { audience_id: '11111111-1111-4111-8111-111111111111' } }, on_true: 'done', on_false: 'wait1' },
        done: { kind: 'exit', config: {} },
      },
    }
    expect(StepsGraph.safeParse(graph).success).toBe(true)
  })
})

describe('per-kind step config gates', () => {
  it('rejects trigger_campaign with a non-uuid campaign_id', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'trigger_campaign', config: { campaign_id: 'not-a-uuid' }, next: 'a' } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects trigger_campaign with a missing campaign_id', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'trigger_campaign', config: {}, next: 'a' } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects wait with neither duration_ms nor until', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'wait', config: {} } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects branch condition with BOTH filter and audience_id', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'branch', config: { condition: { filter: {}, audience_id: '11111111-1111-4111-8111-111111111111' } }, on_true: 'a', on_false: 'a' } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('rejects branch condition with NEITHER filter nor audience_id', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'branch', config: { condition: {} }, on_true: 'a', on_false: 'a' } } }
    expect(StepsGraph.safeParse(graph).success).toBe(false)
  })

  it('accepts a valid webhook step', () => {
    const graph = { entry: 'a', nodes: { a: { kind: 'webhook', config: { url: 'https://example.com/hook' }, next: 'b' }, b: { kind: 'exit', config: {} } } }
    expect(StepsGraph.safeParse(graph).success).toBe(true)
  })

  // the enum must stay in step with what core's sender can actually deliver
  // (server/src/webhooks.js) — a method accepted here but undeliverable there
  // would fail silently at run time, long after the journey was saved.
  const webhookGraph = (config) => ({
    entry: 'a',
    nodes: { a: { kind: 'webhook', config: { url: 'https://example.com/hook', ...config }, next: 'b' }, b: { kind: 'exit', config: {} } },
  })

  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    it(`accepts ${method} as a webhook method`, () => {
      expect(StepsGraph.safeParse(webhookGraph({ method })).success).toBe(true)
    })
  }

  it('rejects a method core cannot send', () => {
    expect(StepsGraph.safeParse(webhookGraph({ method: 'TRACE' })).success).toBe(false)
  })

  it('accepts custom headers and an extra payload', () => {
    const graph = webhookGraph({ headers: { 'X-Token': 'abc' }, payload: { source: 'loyalty-flow' } })
    expect(StepsGraph.safeParse(graph).success).toBe(true)
  })

  it('rejects non-string header values', () => {
    expect(StepsGraph.safeParse(webhookGraph({ headers: { 'X-Count': 3 } })).success).toBe(false)
  })
})

describe('isEditable()', () => {
  it('is true for draft and paused', () => {
    expect(isEditable({ status: 'draft' })).toBe(true)
    expect(isEditable({ status: 'paused' })).toBe(true)
  })

  it('is false for active and archived', () => {
    expect(isEditable({ status: 'active' })).toBe(false)
    expect(isEditable({ status: 'archived' })).toBe(false)
  })

  it('is false for a missing journey', () => {
    expect(isEditable(null)).toBe(false)
  })
})
