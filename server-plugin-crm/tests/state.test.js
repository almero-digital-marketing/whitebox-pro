import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as state from '../src/state.js'

const logger = { debug: vi.fn(), error: vi.fn() }
let facts, notify

beforeEach(() => {
  // recordBatch, not record: the adapter writes a whole record in one
  // statement now. Returns one row per fact so `written` still counts rows.
  facts = {
    recordBatch: vi.fn(async (rows) => rows.map(() => ({}))),
    current: vi.fn(async () => ({})),
  }
  notify = vi.fn()
  state.init({ facts, logger, notify })
})

const written = () => facts.recordBatch.mock.calls[0]?.[0] ?? []
const callsByKey = () => Object.fromEntries(written().map((f) => [f.key, f]))

describe('crm state adapter (records → core facts)', () => {
  it('maps status → fact keyed by kind, and each scalar data field → its own fact', async () => {
    const res = await state.record({
      source: 'stripe', kind: 'subscription', external_id: 'sub_1', passport_id: 'p-1',
      status: 'active', starts_at: '2026-01-01T00:00:00Z', data: { plan_tier: 'pro', seats: 9 },
    })
    expect(res.written).toBe(3)
    const by = callsByKey()
    expect(by.subscription).toMatchObject({ passport_id: 'p-1', key: 'subscription', value: 'active', source: 'stripe', external_id: 'subscription:sub_1' })
    expect(by.plan_tier).toMatchObject({ key: 'plan_tier', value: 'pro', external_id: 'subscription:sub_1' })
    expect(by.seats).toMatchObject({ key: 'seats', value: 9 })
    // starts_at → observed_at on every fact
    for (const f of written()) expect(f.observed_at).toEqual(new Date('2026-01-01T00:00:00Z'))
    expect(notify).toHaveBeenCalledWith('crm.subscription', {
      type: 'crm.subscription',
      data: { passport_id: 'p-1', status: 'active', source: 'stripe', external_id: 'sub_1', plan_tier: 'pro', seats: 9 },
    })
  })

  it('skips non-scalar data fields (not value-queryable)', async () => {
    await state.record({
      source: 'hubspot', kind: 'deal', external_id: 'd1', passport_id: 'p-1',
      status: 'open', data: { amount: 500, owner: { id: 7, name: 'X' }, tags: ['a', 'b'] },
    })
    const keys = written().map((f) => f.key).sort()
    expect(keys).toEqual(['amount', 'deal'])   // owner (object) + tags (array) skipped
  })

  it('records a bare presence fact when there is neither status nor scalar data', async () => {
    await state.record({ source: 'x', kind: 'reservation', external_id: 'r1', passport_id: 'p-1', status: null, data: {} })
    expect(written()).toHaveLength(1)
    expect(written()[0]).toMatchObject({ key: 'reservation', value: true })
    expect(notify).not.toHaveBeenCalled()   // bare presence isn't a transition — nothing to notify
  })

  it('defaults observed_at to now when starts_at is absent', async () => {
    await state.record({ source: 'x', kind: 'k', external_id: '1', passport_id: 'p-1', status: 'a', data: {} })
    expect(written()[0].observed_at).toBeInstanceOf(Date)
  })

  // The batch is deliberately all-or-nothing, where the old per-field loop was
  // tolerant. A record half-written is a customer whose status landed and whose
  // amount did not — that reads as real data and is worse than a record that
  // visibly failed. Ingest is idempotent by (source, kind, external_id), so
  // re-sending costs nothing.
  it('writes nothing and reports zero when the batch fails', async () => {
    facts.recordBatch.mockImplementationOnce(async () => { throw new Error('down') })
    const res = await state.record({ source: 'x', kind: 'k', external_id: '1', passport_id: 'p-1', status: 'a', data: { f: 1 } })
    expect(res.written).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it('sends one statement per record, not one per field', async () => {
    await state.record({
      source: 'x', kind: 'k', external_id: '1', passport_id: 'p-1',
      status: 'a', data: { f: 1, g: 2, h: 3 },
    })
    expect(facts.recordBatch).toHaveBeenCalledTimes(1)
    expect(written()).toHaveLength(4)
  })

  it('current() reads the passport\'s facts straight through', async () => {
    facts.current.mockResolvedValueOnce({ subscription: 'active', plan_tier: 'pro' })
    expect(await state.current('p-1')).toEqual({ subscription: 'active', plan_tier: 'pro' })
    expect(facts.current).toHaveBeenCalledWith('p-1')
  })
})
