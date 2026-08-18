import { describe, it, expect } from 'vitest'
import { validateQuery, assertValidQuery } from '../src/composition/validate-query.js'

// The MCP write tools declare `query: z.any()`, so an agent composing one works
// from a prose description of the grammar and nothing checks the result. These
// cover the check that now stands between it and the database.

describe('validateQuery — well-formed queries pass', () => {
  it('accepts the shapes the compose prompt teaches', () => {
    for (const q of [
      { selector: { filter: { fact: { membership: { eq: 'gold' } } } }, projection: 'people' },
      { selector: { filter: { metric: { attrs: { event: 'x' }, count: { gte: 1 } } } }, projection: 'knowledge', group: { by: 'week' } },
      { funnel: { steps: [{ name: 'Sent', select: { filter: { metric: { attrs: { event: 'email_sent' }, count: { gte: 1 } } } } }] } },
      { scope: { filter: { fact: { city: { in: ['Sofia'] } } } }, distribution: { source: 'fact', key: 'visits' } },
      { series: [{ name: 'A', query: { selector: { filter: { fact: { a: { eq: 1 } } } } } }] },
    ]) expect(validateQuery(q)).toEqual([])
  })

  // `group` decides how a filter.metric is EVALUATED, and the two modes do not
  // share an aggregate list or a bounds rule. Validating everything as a gate
  // rejected the two commonest widget shapes there are — the timeseries the
  // compose prompt literally teaches, and any breakdown counting people — and
  // did so in production for two hours.
  it('accepts a GROUPED metric: no bound needed, distinct_passports allowed', () => {
    expect(validateQuery({
      selector: { filter: { metric: { attrs: { event: 'booking' }, count: {} } } },
      projection: 'knowledge', group: { by: 'month' },
    })).toEqual([])
    expect(validateQuery({
      selector: { filter: { metric: { distinct_passports: {}, channel: 'web' } } },
      group: { by: 'day' },
    })).toEqual([])
  })

  it('still holds a GATE metric to the gate rules', () => {
    // No group → metric.evaluate → a bound is required, and an aggregate with
    // none matches nobody.
    const [noBound] = validateQuery({ selector: { filter: { metric: { attrs: { event: 'x' }, count: {} } } } })
    expect(noBound.message).toMatch(/numeric gte or lte/)
    // distinct_passports cannot gate the passports it counts.
    const [wrongAgg] = validateQuery({ selector: { filter: { metric: { distinct_passports: { gte: 1 } } } } })
    expect(wrongAgg.message).toMatch(/needs exactly one aggregate/)
  })

  it('rejects recency_days when grouped — there is nothing to bucket about "days since"', () => {
    const [err] = validateQuery({ selector: { filter: { metric: { recency_days: {} } } }, group: { by: 'day' } })
    expect(err.message).toMatch(/needs exactly one aggregate/)
  })

  it('only the selector filter is grouped — a scope and a funnel step stay gates', () => {
    // resolveGroup reads selector.filter.metric and nothing else, so a bare
    // aggregate anywhere else is still a gate and still needs its bound.
    const [err] = validateQuery({
      selector: { filter: { metric: { count: {} } } },
      scope: { filter: { metric: { count: {} } } },
      group: { by: 'day' },
    })
    expect(err.path).toBe('query.scope.filter.metric.count')
    expect(err.message).toMatch(/numeric gte or lte/)
  })

  it('has no opinion on a query with no filter at all', () => {
    expect(validateQuery({ scatter: { x: 'a', y: 'b' } })).toEqual([])
    expect(validateQuery({})).toEqual([])
    expect(validateQuery(undefined)).toEqual([])
  })

  it('leaves a scope that is a plain passport array alone', () => {
    // `scope` is either a selector or an already-resolved id list; only the
    // former has a filter to check.
    expect(validateQuery({ scope: ['a', 'b'], group: { by: 'week' } })).toEqual([])
  })
})

describe('validateQuery — malformed queries are named precisely', () => {
  it('catches an aggregate with no bound', () => {
    // The case a print-based check would have passed: it renders as
    // `count(...) <= undefined` rather than failing.
    const errs = validateQuery({ selector: { filter: { metric: { attrs: { event: 'x' }, count: {} } } } })
    expect(errs).toHaveLength(1)
    expect(errs[0].path).toBe('query.selector.filter.metric.count')
    expect(errs[0].message).toMatch(/numeric gte or lte/)
  })

  it('names an unknown fact operator and lists the real ones', () => {
    const [err] = validateQuery({ selector: { filter: { fact: { city: { simmilar: 'Sof' } } } } })
    expect(err.message).toMatch(/unknown operator "simmilar"/)
    expect(err.message).toMatch(/eq, ne, gt, gte, lt, lte, in, present/)
  })

  // The validator standing between the API and the engine has now been stricter than
  // the engine three times: the temporal operators, the value aggregates, and these.
  // Each time the feature was built, tested against selector.resolve directly, and
  // shipped unreachable — every widget using it failing to save with "unknown
  // operator" for something the engine matches perfectly well.
  it('accepts the substring operators the engine matches', () => {
    for (const op of ['contains', 'startsWith', 'endsWith']) {
      expect(validateQuery({ selector: { filter: { fact: { city: { [op]: 'Sof' } } } } })).toEqual([])
    }
    const [err] = validateQuery({ selector: { filter: { fact: { city: { contains: { eq: 'x' } } } } } })
    expect(err.message).toMatch(/`contains` takes a string/)
  })


  // The validator must accept exactly the durations the engine parses. `last` gained
  // calendar units (6M/1y); `window.offset`/`within` did NOT, because the engine
  // converts those to SECONDS for make_interval and a month has no seconds count.
  // Widening both would have made the validator LOOSER than the engine — the mirror
  // of the bug that hid `contains` and the value aggregates.
  it('accepts calendar durations for `last` and refuses them for an anchor offset', () => {
    expect(validateQuery({
      selector: { filter: { metric: { attrs: { event: 'booking' }, last: '6M', sum: { field: 'paid' } } } },
      projection: 'knowledge', group: { by: 'attr:location' },
    })).toEqual([])
    expect(validateQuery({
      selector: { filter: { metric: { attrs: { event: 'booking' }, last: '1y', count: {} } } },
      projection: 'knowledge', group: { by: 'month' },
    })).toEqual([])

    const [badLast] = validateQuery({
      selector: { filter: { metric: { attrs: { event: 'booking' }, last: '6m', count: {} } } },
      projection: 'knowledge', group: { by: 'month' },
    })
    expect(badLast.message).toMatch(/6M or 1y/)

    const [badOffset] = validateQuery({
      selector: { filter: { metric: { attrs: { event: 'booking' }, count: {},
        window: { after: { fact: 'first_booked_at' }, offset: '6M' } } } },
      projection: 'knowledge', group: { by: 'month' },
    })
    expect(badOffset.message).toMatch(/M\/y apply to `last`, not to an anchor offset/)
  })


  // ATTRS took three operators while a FACT took fourteen, and this validator enforced the
  // three. So the range/negation/substring operators the engine just learned would have
  // been rejected on the way in — the fourth instance of this file being stricter than the
  // engine, after the temporal operators, the value aggregates and `contains`.
  it('accepts the attr operators the engine matches', () => {
    const ok = (attrs) => validateQuery({
      selector: { filter: { metric: { attrs, count: {} } } },
      projection: 'knowledge', group: { by: 'month' },
    })
    expect(ok({ paid: { gte: 100 } })).toEqual([])
    expect(ok({ paid: { gte: 100, lte: 500 } })).toEqual([])        // a range ANDs
    expect(ok({ location: { ne: 'Варна' } })).toEqual([])
    expect(ok({ location: { contains: 'Пловдив' } })).toEqual([])
    expect(ok({ paid: { present: false } })).toEqual([])
    expect(ok({ event: 'booking' })).toEqual([])                     // sugar still fine
    expect(ok({ online: ['true', 'false'] })).toEqual([])

    const [bad] = ok({ paid: { roughly: 100 } })
    expect(bad.message).toMatch(/no operator "roughly"/)
    expect(bad.message).toMatch(/gte: 100, lte: 500/)                // says how to write a range
    const [badIn] = ok({ paid: { in: 100 } })
    expect(badIn.message).toMatch(/`in` takes an array/)
  })

  it('leaves `session` on its narrower set', () => {
    // Sessions are typed columns with a small vocabulary; nothing has asked for ranges
    // there, and widening both from one shared check is what would have hidden the
    // difference.
    const [err] = validateQuery({
      selector: { filter: { metric: { session: { utm_source: { gte: 1 } }, count: {} } } },
      projection: 'knowledge', group: { by: 'month' },
    })
    expect(err.message).toMatch(/a session filter takes a value/)
  })

  // The validator's window keys had DRIFTED from the engine's: it listed `missing` where
  // the engine reads `missingAnchor`, and its mode list had no `bucket`. analytics_resolve
  // does not validate, so the anchor cross-tab previewed fine and was refused the moment
  // anyone tried to SAVE it as a widget.
  it('accepts missingAnchor, including the cross-tab mode', () => {
    const w = (window) => validateQuery({
      selector: { filter: { metric: { source: 'video', count: {}, window } } },
      projection: 'knowledge', group: { by: 'content_url' },
    })
    for (const mode of ['exclude', 'include', 'only', 'bucket']) {
      expect(w({ after: { fact: 'first_booked_at' }, missingAnchor: mode })).toEqual([])
    }
    const [stale] = w({ after: { fact: 'k' }, missing: 'only' })
    expect(stale.message).toMatch(/unknown key "missing"/)
    const [bad] = w({ after: { fact: 'k' }, missingAnchor: 'maybe' })
    expect(bad.message).toMatch(/exclude, include, only, bucket/)
  })

  it('accepts `use` on a fact predicate, and checks the rule', () => {
    expect(validateQuery({
      selector: { filter: { fact: { first_booked_at: { gte: '2026-01-01', use: 'min' } } } },
    })).toEqual([])

    const [bad] = validateQuery({
      selector: { filter: { fact: { first_booked_at: { gte: '2026-01-01', use: 'earliest' } } } },
    })
    expect(bad.path).toBe('query.selector.filter.fact.first_booked_at.use')
    expect(bad.message).toMatch(/last, first, min, max/)

    // `use` alone picks a value and asks nothing about it — true of everyone.
    const [alone] = validateQuery({ selector: { filter: { fact: { ltv: { use: 'max' } } } } })
    expect(alone.message).toMatch(/needs an operator too/)
  })

  it('accepts `use` on an aggregate over a fact, and refuses it elsewhere', () => {
    expect(validateQuery({
      selector: { filter: { metric: { avg: { fact: 'ltv', use: 'max' } } } },
      projection: 'knowledge', group: { by: 'month' },
    })).toEqual([])

    const [noFact] = validateQuery({
      selector: { filter: { metric: { avg: { field: 'value', use: 'max' } } } },
      projection: 'knowledge', group: { by: 'month' },
    })
    expect(noFact.message).toMatch(/only applies with `fact`/)
  })

  it('reaches inside a funnel step', () => {
    const [err] = validateQuery({ funnel: { steps: [
      { name: 'ok', select: { filter: { metric: { attrs: { event: 'a' }, count: { gte: 1 } } } } },
      { name: 'bad', select: { filter: { metric: { count: { gte: 1 }, nonsense: 1 } } } },
    ] } })
    expect(err.path).toBe('query.funnel.steps[1].select.filter.metric')
    expect(err.message).toMatch(/unknown key "nonsense"/)
  })

  it('recurses into a series, which carries a whole query of its own', () => {
    const [err] = validateQuery({ series: [
      { name: 'A', query: { selector: { filter: { fact: { a: { eq: 1 } } } } } },
      { name: 'B', query: { scope: { filter: { all: [] } } } },
    ] })
    expect(err.path).toBe('query.series[1].query.scope.filter')
    expect(err.message).toMatch(/non-empty array/)
  })

  it('reports every problem at once rather than one per round trip', () => {
    const errs = validateQuery({ selector: { filter: { all: [
      { fact: { a: { nope: 1 } } },
      { metric: { sum: { gte: 1 } } },
      { wat: {} },
    ] } } })
    expect(errs.length).toBeGreaterThanOrEqual(3)
    expect(errs.map(e => e.path)).toEqual(expect.arrayContaining([
      'query.selector.filter.all[0].fact.a',
      'query.selector.filter.all[1].metric.sum',
      'query.selector.filter.all[2]',
    ]))
  })
})

describe('assertValidQuery', () => {
  it('is silent on a good query', () => {
    expect(() => assertValidQuery({ selector: { filter: { fact: { a: { eq: 1 } } } } })).not.toThrow()
  })

  it('throws 422 carrying every error, and lists them in the message', () => {
    let caught
    try {
      assertValidQuery({ selector: { filter: { all: [{ fact: { a: { nope: 1 } } }, { metric: {} }] } } })
    } catch (e) { caught = e }

    expect(caught).toBeDefined()
    // 422, not 400: the request parsed and the field types are right — it is the
    // query's own content that cannot be evaluated.
    expect(caught.status).toBe(422)
    expect(caught.errors).toHaveLength(2)
    expect(caught.message).toMatch(/query is not well-formed/)
    expect(caught.message).toMatch(/query\.selector\.filter\.all\[0\]\.fact\.a/)
    expect(caught.message).toMatch(/query\.selector\.filter\.all\[1\]\.metric/)
  })
})

// The check lives in the store, not in the tools, so every writer is covered by
// one call — the two MCP tools, the AI compose loop, and the HTTP routes. These
// assert it at that boundary rather than at the module, because "the validator
// works" and "the validator runs" are different claims and only the second one
// keeps a bad query out of the table.
//
// No database needed: the assertion is deliberately the first statement in each
// function, so it throws before anything touches the connection. That ordering
// is itself the thing under test.
describe('the store enforces it for every writer', () => {
  it('addWidget rejects a malformed query before inserting', async () => {
    const store = await import('../src/composition/store.js')
    await expect(
      store.addWidget('some-report', { kind: 'stat', query: { selector: { filter: { metric: { count: {} } } } } }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('updateWidget rejects a malformed query patch', async () => {
    const store = await import('../src/composition/store.js')
    await expect(
      store.updateWidget('some-widget', { query: { selector: { filter: { fact: { a: { bogus: 1 } } } } } }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('a patch that does not touch the query is not rejected by the check', async () => {
    const store = await import('../src/composition/store.js')
    // It still fails — there is no database here — but it must get PAST the
    // validator to do so, or every title edit on a legacy widget would break.
    await expect(store.updateWidget('some-widget', { title: 'renamed' }))
      .rejects.not.toMatchObject({ status: 422 })
  })
})
