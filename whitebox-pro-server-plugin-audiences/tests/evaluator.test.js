import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as evaluator from '../src/evaluator.js'

const rule = { id: 'churn', name: 'Churn', select: { about: 'cancel', judge: { criteria: 'at risk', confidence: 0.7 } } }
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

let selector, ai, db, captured
beforeEach(() => {
  captured = {}
  selector = {
    resolve: vi.fn(async (sel, opts) => { captured.resolve = { sel, opts }; return captured.resolveResult ?? { passports: [] } }),
    preview: vi.fn(async (sel) => { captured.preview = { sel }; return captured.previewResult }),
  }
  ai = { object: vi.fn(async (_s, user, _schema) => { captured.draft = user; return { name: 'X', select: { about: 'x' } } }) }
  // db('whitebox_facts').distinct('key').orderBy('key') → rows
  db = vi.fn(() => ({ distinct: () => ({ orderBy: async () => [{ key: 'plan_tier' }, { key: 'subscription' }] }) }))
  evaluator.init({ selector, ai, db, logger })
})

describe('audiences evaluator (selector adapter)', () => {
  it('candidates → the selector people cohort', async () => {
    captured.resolveResult = { passports: [{ id: 'a' }, { id: 'b' }] }
    expect(await evaluator.candidates(rule)).toEqual(['a', 'b'])
    expect(captured.resolve.sel).toEqual(rule.select)
    expect(captured.resolve.opts).toMatchObject({ projection: 'people' })
  })

  it('evaluate(passport) is a scoped resolve — membership + why/score', async () => {
    captured.resolveResult = { passports: [{ id: 'p1', why: 'mentioned cancelling', score: 0.9, matched_at: '2026-05-01' }] }
    const v = await evaluator.evaluate(rule, 'p1')
    expect(captured.resolve.opts).toEqual({ projection: 'people', scope: ['p1'] })   // one-passport population
    expect(v).toMatchObject({ qualified: true, score: 0.9, reason: 'mentioned cancelling' })
    expect(v.evidence.matched_at).toBe('2026-05-01')
  })

  it('evaluate → not qualified when the passport is not in the scoped result', async () => {
    captured.resolveResult = { passports: [] }
    const v = await evaluator.evaluate(rule, 'p1')
    expect(v).toMatchObject({ qualified: false, score: 0 })
  })

  it('preview maps the engine preview to the audience shape', async () => {
    captured.previewResult = { filter: { survivors: 120 }, fullScan: false, confirmRequired: false,
      judge: { sample: 20, projectedMatches: 84, reasons: ['r1', 'r2'] } }
    const p = await evaluator.preview(rule)
    expect(p).toEqual({ candidate_pool: 120, est_matches: 84, sampled: 20, full_scan: false, confirm_required: false, sample_reasons: ['r1', 'r2'] })
  })

  it('preview with no judge → est_matches is the deterministic survivor count', async () => {
    captured.previewResult = { filter: { survivors: 50 }, fullScan: true, confirmRequired: true, judge: null }
    const p = await evaluator.preview(rule)
    expect(p).toMatchObject({ candidate_pool: 50, est_matches: 50, full_scan: true, confirm_required: true, sample_reasons: [] })
  })

  it('availableFacts reads distinct keys from core facts', async () => {
    expect(await evaluator.availableFacts()).toEqual([{ key: 'plan_tier' }, { key: 'subscription' }])
    expect(db).toHaveBeenCalledWith('whitebox_facts')
  })

  it('draftRule asks the LLM for a selector-shaped rule', async () => {
    const out = await evaluator.draftRule('people about to churn')
    expect(captured.draft).toBe('people about to churn')
    expect(out).toEqual({ name: 'X', select: { about: 'x' } })
  })
})
