import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as service from '../src/service.js'

// Fakes for the core primitives — this plugin owns no storage, so its whole
// job is delegating correctly and composing the result.
const person = (over = {}) => ({
  id: 'p1', created_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-06-01T00:00:00Z',
  identities: [{ id: 1, type: 'email', name: 'email', value: 'a@b.com' }],
  facts: { whatever_key: 'value' },
  ...over,
})

let passports, facts, awareness, journeys, audiences, logger

beforeEach(() => {
  passports = {
    search: vi.fn(async (args) => ({ total: 1, people: [person()], __args: args })),
    get: vi.fn(async (id) => (id === 'missing' ? null : person({ id }))),
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => 1),
    merge: vi.fn(async (s) => s),
    erase: vi.fn(async (id) => ({ id, removed: { whitebox_passports: 1 } })),
  }
  facts = { current: vi.fn(async () => ({ whatever_key: 'value' })), record: vi.fn(async () => {}) }
  awareness = { timeline: vi.fn(async () => [{ channel: 'mail', ts: '2026-06-01' }]) }
  journeys = { listEnrollmentsByPassport: vi.fn(async () => [{ id: 'e1', status: 'active' }]) }
  audiences = { isSuppressed: vi.fn(async () => false) }
  logger = { info: vi.fn(), warn: vi.fn() }
  service.init({ passports, facts, awareness, journeys, audiences, logger })
})

describe('list', () => {
  it('passes paging through and defaults includeAnonymous to false', async () => {
    await service.list({ q: 'ann', limit: 10, offset: 20 })
    expect(passports.search).toHaveBeenCalledWith({
      q: 'ann', fields: undefined, includeAnonymous: false, limit: 10, offset: 20,
    })
  })

  // Deliberately NOT validated here — core owns the field vocabulary and
  // already normalises junk. A second copy of the list in this layer is a
  // second thing to forget to update.
  it('hands the search scope to core untouched, in either shape', async () => {
    await service.list({ q: 'ann', fields: ['identities'] })
    expect(passports.search.mock.calls[0][0].fields).toEqual(['identities'])
    await service.list({ q: 'ann', fields: 'facts,id' })
    expect(passports.search.mock.calls[1][0].fields).toBe('facts,id')
  })

  // it arrives as a query string, not a boolean
  it("treats the string 'true' as opting in", async () => {
    await service.list({ includeAnonymous: 'true' })
    expect(passports.search.mock.calls[0][0].includeAnonymous).toBe(true)
  })

  it("treats the string 'false' as opting out", async () => {
    await service.list({ includeAnonymous: 'false' })
    expect(passports.search.mock.calls[0][0].includeAnonymous).toBe(false)
  })
})

describe('get', () => {
  it('composes identities, facts, awareness, enrollments and suppression', async () => {
    const p = await service.get('p1')
    expect(p.identities).toHaveLength(1)
    expect(p.facts).toEqual({ whatever_key: 'value' })
    expect(p.recent).toHaveLength(1)
    expect(p.enrollments).toEqual([{ id: 'e1', status: 'active' }])
    expect(p.suppressed).toBe(false)
    expect(awareness.timeline).toHaveBeenCalledWith({ passport_id: 'p1', limit: 20 })
  })

  it('404s for an unknown person', async () => {
    await expect(service.get('missing')).rejects.toMatchObject({ status: 404 })
  })

  // The distinction the UI relies on to omit a section rather than render an
  // empty one that looks like missing data.
  it('returns null (not []) for sections whose plugin is not registered', async () => {
    service.init({ passports, facts, awareness: null, journeys: null, audiences: null, logger })
    const p = await service.get('p1')
    expect(p.enrollments).toBeNull()
    expect(p.suppressed).toBeNull()
    expect(p.recent).toEqual([])       // awareness has a real empty value
  })

  it('survives an optional plugin throwing', async () => {
    journeys.listEnrollmentsByPassport = vi.fn(async () => { throw new Error('journeys exploded') })
    service.init({ passports, facts, awareness, journeys, audiences, logger })
    const p = await service.get('p1')
    expect(p.enrollments).toBeNull()
    expect(p.identities).toHaveLength(1)   // the rest of the profile still renders
  })
})

describe('linkIdentity', () => {
  it('passes the claim through and defaults name to the type', async () => {
    await service.linkIdentity('p1', { type: 'email', value: 'new@b.com' })
    expect(passports.link).toHaveBeenCalledWith('p1', [{ name: 'email', type: 'email', value: 'new@b.com' }])
  })

  it('keeps an explicit name', async () => {
    await service.linkIdentity('p1', { type: 'external_id', name: 'crm', value: 'C-9' })
    expect(passports.link).toHaveBeenCalledWith('p1', [{ name: 'crm', type: 'external_id', value: 'C-9' }])
  })

  it('rejects a claim with no value', async () => {
    await expect(service.linkIdentity('p1', { type: 'email' })).rejects.toMatchObject({ status: 400 })
  })

  // type is NOT an enum — weak and custom types are legitimate, core only
  // privileges the strong four with global uniqueness
  it('accepts a custom identity type', async () => {
    await expect(service.linkIdentity('p1', { type: 'loyalty_card', value: 'L-1' })).resolves.toBeTruthy()
  })
})

describe('unlinkIdentity', () => {
  it('404s when the identity is not on this person', async () => {
    passports.unlink = vi.fn(async () => 0)
    service.init({ passports, facts, awareness, journeys, audiences, logger })
    await expect(service.unlinkIdentity('p1', 99)).rejects.toMatchObject({ status: 404 })
  })
})

describe('recordFact', () => {
  it('records an arbitrary key and stamps the source', async () => {
    await service.recordFact('p1', { key: 'anything_at_all', value: 'x' })
    expect(facts.record).toHaveBeenCalledWith({
      passport_id: 'p1', key: 'anything_at_all', value: 'x', source: 'people',
    })
  })

  it('rejects an empty key', async () => {
    await expect(service.recordFact('p1', { key: '', value: 'x' })).rejects.toMatchObject({ status: 400 })
  })

  it('accepts numbers and booleans', async () => {
    await expect(service.recordFact('p1', { key: 'n', value: 42 })).resolves.toBeTruthy()
    await expect(service.recordFact('p1', { key: 'b', value: true })).resolves.toBeTruthy()
  })
})

describe('merge', () => {
  it('merges absorbed into survivor', async () => {
    await service.merge('survivor', 'absorbed')
    expect(passports.merge).toHaveBeenCalledWith('survivor', 'absorbed')
  })

  it('refuses to merge a person into themselves', async () => {
    await expect(service.merge('p1', 'p1')).rejects.toMatchObject({ status: 400 })
  })

  it('requires an absorbed_id', async () => {
    await expect(service.merge('p1', undefined)).rejects.toMatchObject({ status: 400 })
  })

  // two DIFFERENT ids that already resolve to the same person is a no-op, not
  // an error — the caller can't know they were already merged
  it('no-ops when both ids already resolve to the same person', async () => {
    passports.get = vi.fn(async () => person({ id: 'same' }))
    service.init({ passports, facts, awareness, journeys, audiences, logger })
    await expect(service.merge('a', 'b')).resolves.toBeTruthy()
    expect(passports.merge).not.toHaveBeenCalled()
  })
})

describe('erase', () => {
  it('returns the per-table counts core reports', async () => {
    const res = await service.erase('p1')
    expect(res.removed).toEqual({ whitebox_passports: 1 })
    expect(passports.erase).toHaveBeenCalledWith('p1')
  })

  it('404s for an unknown person', async () => {
    await expect(service.erase('missing')).rejects.toMatchObject({ status: 404 })
  })
})

describe('addManyToList', () => {
  function setup({ searchResult = { people: [] }, addResult = { added: 0, count: 0 } } = {}) {
    const audiences = { addToList: vi.fn(), addManyToList: vi.fn(async () => addResult), listLists: vi.fn() }
    const passports = { search: vi.fn(async () => searchResult) }
    service.init({ passports, facts: {}, awareness: {}, audiences, logger: console })
    return { audiences, passports }
  }

  it('adds exactly the hand-picked ids without touching the search', async () => {
    const { audiences, passports } = setup({ addResult: { added: 3, count: 10 } })
    const r = await service.addManyToList('seg1', { passportIds: ['p1', 'p2', 'p3'] })
    expect(audiences.addManyToList).toHaveBeenCalledWith('seg1', ['p1', 'p2', 'p3'], 'people-ui')
    expect(passports.search).not.toHaveBeenCalled()
    expect(r.added).toBe(3)
  })

  // the client has only ever seen one page, so "all matching" can only be
  // answered by re-running the search here
  it('re-runs the SEARCH for a query scope rather than trusting a client id list', async () => {
    const { audiences, passports } = setup({
      searchResult: { people: [{ id: 'a' }, { id: 'b' }] },
      addResult: { added: 2, count: 2 },
    })
    await service.addManyToList('seg1', { query: { q: 'gmail', includeAnonymous: false } })
    expect(passports.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'gmail', offset: 0 }))
    expect(audiences.addManyToList).toHaveBeenCalledWith('seg1', ['a', 'b'], 'people-ui')
  })

  // silently adding a different set than the one asked for is the failure mode
  // worth guarding: the cap is reported, never hidden
  it('reports truncation instead of quietly capping the set', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `p${i}` }))
    const { audiences } = setup({ searchResult: { people: many }, addResult: { added: 5000, count: 5000 } })
    const r = await service.addManyToList('seg1', { query: { q: '' } })
    expect(r.truncated).toBe(true)
    expect(audiences.addManyToList.mock.calls[0][1]).toHaveLength(5000)
  })

  it('needs a scope', async () => {
    setup()
    await expect(service.addManyToList('seg1', {})).rejects.toThrow(/passport_ids or query/)
  })

  it('is a no-op when the query matches nobody', async () => {
    const { audiences } = setup({ searchResult: { people: [] } })
    expect(await service.addManyToList('seg1', { query: { q: 'nobody' } })).toMatchObject({ added: 0 })
    expect(audiences.addManyToList).not.toHaveBeenCalled()
  })
})

describe('recordFactForMany', () => {
  function setup({ searchResult = { people: [] }, recorded = [] } = {}) {
    const facts = { record: vi.fn(), recordMany: vi.fn(async () => recorded), usedKeys: vi.fn(async () => ['tier', 'nps']) }
    const passports = { search: vi.fn(async () => searchResult) }
    service.init({ passports, facts, awareness: {}, audiences: {}, logger: console })
    return { facts, passports }
  }
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }))

  it('records ONE fact across the hand-picked ids, stamped with the people source', async () => {
    const { facts, passports } = setup({ recorded: rows(3) })
    const r = await service.recordFactForMany({ key: 'tier', value: 'gold' }, { passportIds: ['p1', 'p2', 'p3'] })
    expect(facts.recordMany).toHaveBeenCalledWith({
      passport_ids: ['p1', 'p2', 'p3'], key: 'tier', value: 'gold', source: 'people',
    })
    // never the single-record path — that would be two round trips per person
    expect(facts.record).not.toHaveBeenCalled()
    expect(passports.search).not.toHaveBeenCalled()
    expect(r).toMatchObject({ recorded: 3, requested: 3 })
  })

  // same reasoning as the list bulk: the client has seen one page, so only the
  // server can answer "all matching"
  it('re-runs the SEARCH for a query scope', async () => {
    const { facts, passports } = setup({ searchResult: { people: [{ id: 'a' }, { id: 'b' }] }, recorded: rows(2) })
    await service.recordFactForMany({ key: 'tier', value: 'gold' }, { query: { q: 'gmail' } })
    expect(passports.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'gmail', offset: 0 }))
    expect(facts.recordMany.mock.calls[0][0].passport_ids).toEqual(['a', 'b'])
  })

  // recorded < requested is real, not an error: two selected people who were
  // merged are one passport, and the same fact twice about them is one fact
  it('reports fewer recorded than requested when ids collapse through merges', async () => {
    const { facts } = setup({ recorded: rows(2) })
    const r = await service.recordFactForMany({ key: 'tier', value: 'gold' }, { passportIds: ['p1', 'p2', 'p3'] })
    expect(r).toMatchObject({ recorded: 2, requested: 3 })
    expect(facts.recordMany).toHaveBeenCalled()
  })

  it('reports truncation instead of quietly capping the set', async () => {
    const { facts } = setup({ searchResult: { people: rows(5001).map((_, i) => ({ id: `p${i}` })) }, recorded: rows(5000) })
    const r = await service.recordFactForMany({ key: 'tier', value: 'gold' }, { query: { q: '' } })
    expect(r.truncated).toBe(true)
    expect(facts.recordMany.mock.calls[0][0].passport_ids).toHaveLength(5000)
  })

  // the same schema as the single-person recordFact — that's what makes reusing
  // one panel for both honest
  it('rejects a bad fact before resolving anybody', async () => {
    const { facts, passports } = setup()
    await expect(service.recordFactForMany({ value: 'gold' }, { passportIds: ['p1'] })).rejects.toThrow(/key/)
    expect(passports.search).not.toHaveBeenCalled()
    expect(facts.recordMany).not.toHaveBeenCalled()
  })

  it('needs a scope', async () => {
    setup()
    await expect(service.recordFactForMany({ key: 'tier', value: 'g' }, {})).rejects.toThrow(/passport_ids or query/)
  })

  it('is a no-op when the query matches nobody', async () => {
    const { facts } = setup({ searchResult: { people: [] } })
    expect(await service.recordFactForMany({ key: 'tier', value: 'g' }, { query: { q: 'nobody' } }))
      .toMatchObject({ recorded: 0, requested: 0 })
    expect(facts.recordMany).not.toHaveBeenCalled()
  })

  it('degrades to an empty vocabulary when facts cannot answer', async () => {
    service.init({ passports: {}, facts: {}, awareness: {}, audiences: {}, logger: console })
    expect(await service.factKeys()).toEqual([])
  })
})

describe('eraseMany', () => {
  function setup({ searchResult = { people: [] }, results = {} } = {}) {
    const passports = {
      search: vi.fn(async () => searchResult),
      // null is the "already gone" answer core's erase() gives
      erase: vi.fn(async id => (id in results ? results[id] : { id, removed: { whitebox_passports: 1 } })),
    }
    service.init({ passports, facts: {}, awareness: {}, audiences: {}, logger: console })
    return { passports }
  }

  it('erases every hand-picked id and sums the per-table counts', async () => {
    const { passports } = setup({ results: {
      p1: { id: 'p1', removed: { whitebox_facts: 3, whitebox_passports: 1 } },
      p2: { id: 'p2', removed: { whitebox_facts: 2, whitebox_mail_outbox: 5 } },
    } })
    const r = await service.eraseMany({ passportIds: ['p1', 'p2'] })
    expect(passports.erase.mock.calls.map(c => c[0])).toEqual(['p1', 'p2'])
    expect(r).toMatchObject({
      erased: 2, requested: 2,
      removed: { whitebox_facts: 5, whitebox_passports: 1, whitebox_mail_outbox: 5 },
    })
  })

  // erasing a survivor also drops the passports merged into it, so an absorbed
  // id later in the same set is already gone — not an error, just not counted
  it('skips ids that are already gone without counting them as erased', async () => {
    setup({ results: { p2: null } })
    expect(await service.eraseMany({ passportIds: ['p1', 'p2', 'p3'] }))
      .toMatchObject({ erased: 2, requested: 3 })
  })

  it('re-runs the SEARCH for a query scope', async () => {
    const { passports } = setup({ searchResult: { people: [{ id: 'a' }, { id: 'b' }] } })
    await service.eraseMany({ query: { q: 'gmail' } })
    expect(passports.search).toHaveBeenCalledWith(expect.objectContaining({ q: 'gmail', offset: 0 }))
    expect(passports.erase.mock.calls.map(c => c[0])).toEqual(['a', 'b'])
  })

  // Its own cap, well under BULK_MAX: each erase is a lock plus a transaction
  // across every table, so a 5000-person set cannot finish in one request. A
  // half-done erasure reported as success would be a false compliance claim.
  it('caps far below the other bulk verbs and says where it stopped', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `p${i}` }))
    const { passports } = setup({ searchResult: { people: many } })
    const r = await service.eraseMany({ query: { q: '' } })
    expect(passports.erase).toHaveBeenCalledTimes(200)
    expect(r).toMatchObject({ erased: 200, requested: 200, truncated: true })
  })

  it('needs a scope', async () => {
    setup()
    await expect(service.eraseMany({})).rejects.toThrow(/passport_ids or query/)
  })

  it('is a no-op when the query matches nobody', async () => {
    const { passports } = setup({ searchResult: { people: [] } })
    expect(await service.eraseMany({ query: { q: 'nobody' } })).toMatchObject({ erased: 0, requested: 0 })
    expect(passports.erase).not.toHaveBeenCalled()
  })
})
