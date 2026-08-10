import { validate as validateFilter } from 'whitebox-pro-server/selector-dsl'

// Well-formedness for a whole query def, as a list of {path, message}.
//
// The MCP write tools declare `query: z.any()`, so an agent composing one has
// nothing but a prose description of the grammar to work from — and until now
// nothing checked the result. A malformed filter was accepted, stored, and only
// surfaced later as a widget that would not render, with nothing tying the
// failure back to the call that wrote it.
//
// `analytics_compose` already validates the other way, by actually resolving
// each widget and dropping the ones the selector rejects. That is stronger but
// far more expensive, and it is not available on a direct write. This is the
// cheap half: shape only, no database, no resolve.
//
// Deliberately shape-only. Whether `city` is a real fact key is a question for
// analytics_schema and for resolution — not for a syntax check that must stay
// fast enough to run on every write.

// A query def carries filters in more places than selector.filter, and a check
// that only looked there would pass a broken funnel step or series. Each entry
// is walked from the query root; `scope` may also be a plain array of passport
// ids, which is not a filter at all.
function collect(query, path, out) {
    if (!query || typeof query !== 'object') return

    // `group` decides how this one filter is EVALUATED, and therefore which
    // aggregates and bounds are legal in it. resolveGroup demands a bare
    // `selector.filter.metric` and hands it to metric.group; without `group` the
    // same clause is a gate through metric.evaluate. Nothing else in a query def
    // is ever grouped — a scope, a funnel step and a series' own scope are all
    // gates — so the flag is set here and nowhere else.
    if (query.selector?.filter != null) out.push([`${path}.selector.filter`, query.selector.filter, { grouped: !!query.group }])
    if (query.scope != null && !Array.isArray(query.scope) && query.scope.filter != null) {
        out.push([`${path}.scope.filter`, query.scope.filter])
    }
    for (const [i, step] of (query.funnel?.steps || []).entries()) {
        if (step?.select?.filter != null) out.push([`${path}.funnel.steps[${i}].select.filter`, step.select.filter])
    }
    // A series carries a whole query of its own, so this recurses rather than
    // reaching in — a series can itself have a scope, a funnel, or more series.
    for (const [i, s] of (Array.isArray(query.series) ? query.series : []).entries()) {
        collect(s?.query, `${path}.series[${i}].query`, out)
    }
}

export function validateQuery(query) {
    const found = []
    collect(query, 'query', found)
    return found.flatMap(([path, filter, opts]) =>
        validateFilter(filter, opts).map((e) => ({
            // validateFilter reports paths rooted at `filter`; re-root them at
            // the position inside the query def so the message names something
            // the caller actually sent.
            path: e.path.replace(/^filter/, path),
            message: e.message,
        })),
    )
}

// The shape a tool throws. 422 rather than 400: the request parsed fine and the
// fields are the right types — it is the query's own content that cannot be
// evaluated. The errors ride on the error object so a caller sees all of them
// at once instead of fixing one per round trip.
export function assertValidQuery(query) {
    const errors = validateQuery(query)
    if (!errors.length) return
    const e = new Error(
        `query is not well-formed:\n${errors.map((x) => `  ${x.path}: ${x.message}`).join('\n')}`,
    )
    e.status = 422
    e.errors = errors
    throw e
}
