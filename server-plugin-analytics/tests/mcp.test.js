import { describe, it, expect, vi } from 'vitest'
import { registerMcp } from '../src/mcp.js'

function makeMcpStub() {
  const tools = new Map()
  return {
    tool:     (s) => tools.set(s.name, s),
    resource: () => {},
    prompt:   () => {},
    tools,
  }
}

function makeDeps({ recallHits = [], population = { count: 0, passports: [] }, timeline = [], forgot = 0, answer = 'a', collected = {} } = {}) {
  return {
    awareness: {
      recall:        vi.fn(async () => recallHits),
      population:    vi.fn(async () => population),
      timeline:      vi.fn(async () => timeline),
      forget:        vi.fn(async () => forgot),
      ask:           vi.fn(async () => ({ answer, evidence: recallHits, context: collected })),
      askPopulation: vi.fn(async () => ({ answer, evidence: [], cohort: { count: population.count } })),
    },
    context: {
      collect: vi.fn(async () => collected),
      names:   () => Object.keys(collected),
    },
  }
}

const PID = 'a1b2c3d4-5678-4abc-89de-1234567890ab'

describe('analytics plugin — MCP registration', () => {
  it('registers seven whitebox.* tools', () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, makeDeps())
    expect([...mcp.tools.keys()].sort()).toEqual([
      'whitebox.ask',
      'whitebox.ask_population',
      'whitebox.context',
      'whitebox.forget',
      'whitebox.population',
      'whitebox.recall',
      'whitebox.timeline',
    ])
  })

  it('whitebox.ask_population delegates to awareness.askPopulation (no passport) and returns its answer text', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ answer: 'Most customers ask about pricing and SSO.', population: { count: 42, passports: [] } })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.ask_population').handler({
      question: 'What are customers asking about?',
      similarity: 0.6,
    })
    expect(deps.awareness.askPopulation).toHaveBeenCalledWith(expect.objectContaining({
      question: 'What are customers asking about?',
      similarity: 0.6,
    }))
    expect(result.content[0].text).toContain('pricing and SSO')
  })

  it('whitebox.ask delegates to awareness.ask and returns its answer text', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ answer: 'They have an active subscription and have read about SSO.' })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.ask').handler({
      passport_id: PID,
      question: 'What does this customer have going on?',
    })
    expect(deps.awareness.ask).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: PID,
      question: 'What does this customer have going on?',
    }))
    expect(result.content[0].text).toContain('active subscription')
  })

  it('whitebox.recall passes args through to awareness.recall and JSON-stringifies hits', async () => {
    const mcp = makeMcpStub()
    const hits = [{ id: 1, chunk_text: 'pricing tier', similarity: 0.92 }]
    const deps = makeDeps({ recallHits: hits })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.recall').handler({
      passport_id: PID, query: 'pricing', limit: 5,
    })
    expect(deps.awareness.recall).toHaveBeenCalledWith({ passport_id: PID, query: 'pricing', limit: 5, min_similarity: 0 })
    const out = JSON.parse(result.content[0].text)
    expect(out[0].chunk_text).toBe('pricing tier')
  })

  it('whitebox.population returns count + passports', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ population: { count: 42, passports: [{ passport_id: 'p1' }] } })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.population').handler({ query: 'spring promo' })
    const out = JSON.parse(result.content[0].text)
    expect(out.count).toBe(42)
  })

  it('whitebox.timeline converts ISO strings to Date and forwards filters', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ timeline: [{ id: 7, channel: 'mail' }] })
    registerMcp({ mcp }, deps)

    await mcp.tools.get('whitebox.timeline').handler({
      passport_id: PID,
      from: '2026-05-01T00:00:00.000Z',
      channels: ['mail', 'voip'],
    })
    const call = deps.awareness.timeline.mock.calls[0][0]
    expect(call.from).toBeInstanceOf(Date)
    expect(call.channels).toEqual(['mail', 'voip'])
    expect(call.directions).toBeNull()
  })

  it('whitebox.context returns providers + collected blob from the registry', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ collected: { crm: [{ kind: 'reservation' }], billing: { plan: 'pro' } } })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.context').handler({ passport_id: PID })
    const out = JSON.parse(result.content[0].text)
    expect(out.providers.sort()).toEqual(['billing', 'crm'])
    expect(out.context.billing).toEqual({ plan: 'pro' })
  })

  it('whitebox.context handles absent context registry gracefully', async () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, { awareness: makeDeps().awareness /* no context */ })
    const result = await mcp.tools.get('whitebox.context').handler({ passport_id: PID })
    const out = JSON.parse(result.content[0].text)
    expect(out).toEqual({ providers: [], context: {} })
  })

  it('whitebox.forget calls awareness.forget and reports the count', async () => {
    const mcp = makeMcpStub()
    const deps = makeDeps({ forgot: 47 })
    registerMcp({ mcp }, deps)

    const result = await mcp.tools.get('whitebox.forget').handler({ passport_id: PID })
    expect(deps.awareness.forget).toHaveBeenCalledWith({ passport_id: PID })
    expect(result.content[0].text).toContain('47 exposure')
  })

  it('is a no-op when ctx.mcp is undefined', () => {
    expect(() => registerMcp({}, makeDeps())).not.toThrow()
  })
})

// Structured MCP arguments arrive as JSON STRINGS from some clients.
//
// This was not theoretical: analytics_resolve answered every question with the
// entire population (153,282 people for a filter matching 9,368), and
// analytics_add_widget persisted the string — saving a widget that would keep
// doing it on every view. Nothing threw, because reading `.selector` off a
// string is undefined, and an undefined filter is "everyone".
describe('composition mcp: structured args arrive as JSON strings', () => {
  function makeCompositionMcp() {
    const calls = []
    const mcp = makeMcpStub()
    const ctx = { mcp }
    // registerMcp for the composition surface is a separate module; import it
    // lazily so this file's existing suite is unaffected.
    return { ctx, mcp, calls }
  }

  it('parses a JSON-string query into an object before the handler sees it', async () => {
    const { registerMcp: registerComposition } = await import('../src/composition/mcp.js')
    const mcp = makeMcpStub()
    const seen = []
    // stand in for the store/selector: capture what add_widget receives
    const store = await import('../src/composition/store.js')
    const addSpy = vi.spyOn(store, 'addWidget').mockImplementation(async (report_id, w) => { seen.push(w); return { id: 'w1', ...w } })
    vi.spyOn(store, 'getReport').mockImplementation(async () => ({ id: 'r1', name: 'r' }))

    registerComposition({ mcp }, { selector: {}, awareness: {}, passports: {}, logger: console })

    const tool = mcp.tools.get('analytics_add_widget')
    await tool.handler({
      report_id: 'r1',
      kind: 'stat',
      query: '{"selector":{"filter":{"fact":{"visits_total":{"gte":1}}}},"projection":"people"}',
    })

    expect(seen).toHaveLength(1)
    // the whole point: an OBJECT, not the string it arrived as
    expect(typeof seen[0].query).toBe('object')
    expect(seen[0].query.selector.filter.fact.visits_total).toEqual({ gte: 1 })
    addSpy.mockRestore()
  })

  it('leaves a non-JSON string alone', async () => {
    const { registerMcp: registerComposition } = await import('../src/composition/mcp.js')
    const mcp = makeMcpStub()
    registerComposition({ mcp }, { selector: {}, awareness: {}, passports: {}, logger: console })
    const tool = mcp.tools.get('analytics_compose')
    // `question` is legitimately a string and must not be touched
    expect(tool.inputSchema.question).toBeDefined()
  })
})
