import { describe, it, expect } from 'vitest'
import { validate, toRow, fromRow } from '../src/rules.js'

const base = { id: 'churn_risk', name: 'Churn risk', select: { about: 'cancel, competitor', judge: { criteria: 'at risk', confidence: 0.7 } } }

describe('audience rule schema (selector-based)', () => {
  it('validates a select-based rule and applies defaults', () => {
    const r = validate(base)
    expect(r.select.about).toBe('cancel, competitor')
    expect(r).toMatchObject({ enabled: false, ttl_days: 30, policy: 'non_sensitive', delivery: {} })
  })

  it('accepts a purely structural selector (filter only, no about/judge)', () => {
    const r = validate({ id: 'pro', name: 'Pro', select: { filter: { fact: { plan_tier: { eq: 'pro' } } } } })
    expect(r.select.filter).toBeTruthy()
  })

  it('rejects an empty selector (would mean "everyone")', () => {
    expect(() => validate({ id: 'x', name: 'X', select: {} })).toThrow(/at least one of about/)
  })

  it('rejects the retired legacy fields (strict schema)', () => {
    expect(() => validate({ ...base, seed: 'x', criteria: 'y' })).toThrow(/invalid rule/)
  })

  it('round-trips through toRow / fromRow (selector column)', () => {
    const rule = validate(base)
    const row = toRow(rule, 'tester')
    expect(typeof row.selector).toBe('string')          // jsonb serialized
    expect(row).not.toHaveProperty('seed')
    const back = fromRow({ ...row, selector: row.selector })
    expect(back.select).toEqual(rule.select)
    expect(back.updated_by).toBe('tester')
  })
})
