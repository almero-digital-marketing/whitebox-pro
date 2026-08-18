import * as filter from './filter.js'
import * as metric from './metric.js'
import { rt } from './runtime.js'
import { aboutQuery } from './about.js'

// The `knowledge` projection — ranked evidence (chunks), never prose (prose is
// the /ask layer §7). `about` is the *ranker* here, not a gate. Three shapes:
//   · passport          → recall over one passport's memory, ranked by about
//   · base + about      → about-ranked evidence across the base, intersected with
//                         the deterministic filter cohort if a filter is present
//   · base, no about    → a representative content sample of the base
export async function resolveKnowledge(selector, { scope, passport, asOf, limit } = {}) {
  if (!rt.awareness) throw new Error('selector: knowledge requires the awareness module')
  const lim = limit ?? rt.defaults.knowledgeLimit
  const query = aboutQuery(selector.about)

  // · passport
  if (scope === 'passport' || passport != null) {
    if (passport == null) throw new Error('selector: knowledge `passport` scope needs a `passport` id')
    if (!query) throw new Error('selector: knowledge over a passport needs `about` to rank evidence')
    const rows = await rt.awareness.recall({ passport_id: passport, query, limit: lim })
    return { projection: 'knowledge', scope: 'passport', passport, evidence: asEvidence(rows).slice(0, lim) }
  }

  // · base — the deterministic cohort (filter only; about ranks, never gates here)
  let cohort = null
  if (selector.filter) {
    const at = asOf ? new Date(asOf) : null
    cohort = new Set(await filter.evaluate(selector.filter, baseCtx(at)))
  }

  if (query) {
    // A filter that matches nobody has no evidence, and that has to be said HERE.
    // `scope` is applied downstream as `if (scope?.length)`, so an empty array is
    // indistinguishable from "unscoped" and would widen the query back to the whole
    // base — turning "nobody matches" into "here is everyone", which is the worst
    // possible answer to give confidently.
    if (cohort && cohort.size === 0) {
      return { projection: 'knowledge', scope: 'base', count: 0, evidence: [] }
    }

    // The cohort confines the CANDIDATE POOL, not just the result.
    //
    // This used to fetch base-wide and narrow in JS below. The narrowing was
    // correct and the pool was not: `population` returns the top `candidateLimit`
    // chunks by similarity ACROSS THE BASE, so a cohort competed with everyone for
    // those slots. A cohort whose content ranked below the cut got partial evidence
    // — or none, which /ask renders as "I don't have any relevant content to answer
    // that." An answerable question about fifty people came back as a confident
    // denial, and nothing in the response distinguished that from a real miss.
    //
    // Pushing it down (docs/scoped-recall.md — this is the contract that doc
    // describes, which the analytics answer widget already honours) means the pool
    // is the cohort's own top-N. It is also the cheaper shape: the exposure JOIN
    // stops fanning out across the whole base only to discard it in Node.
    const scopeIds = cohort ? [...cohort] : undefined
    const pop = await rt.awareness.population({
      query,
      similarity: rt.defaults.knowledgeSimilarity,
      limit: rt.defaults.candidateLimit,
      ...(scopeIds ? { scope: scopeIds } : {}),
    })

    let hits = (pop?.passports || []).flatMap(p => (p.hits || []).map(h => ({ passport_id: p.passport_id, ...h })))
    // Kept even though `scope` now does this in SQL. `rt.awareness` is injected, so
    // an implementation that ignores `scope` would otherwise leak other people's
    // content into a cohort's answer — a correctness property should not rest on a
    // provider honouring a hint. Over a bounded pool it costs nothing.
    if (cohort) hits = hits.filter(h => cohort.has(h.passport_id))
    hits.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    return { projection: 'knowledge', scope: 'base', count: hits.length, evidence: asEvidence(hits).slice(0, lim) }
  }

  // no about → nothing to rank by. A base-wide content sample is the honest
  // fallback; a *filtered* cohort can't be sampled without a ranker (yet).
  if (cohort) throw new Error('selector: knowledge over a filtered cohort needs `about` to rank evidence')
  const rows = await rt.awareness.sampleContent({ limit: lim })
  return { projection: 'knowledge', scope: 'base', evidence: asEvidence(rows).slice(0, lim) }
}

// group(selector, { group, scope, asOf }) → a time-series / breakdown series (§7):
// the `metric` aggregate in selector.filter, bucketed by `group.by` — a time grain
// (hour/day/week/month), an exposure column (channel/direction/source), a session
// dimension (session:utm_campaign), or a meta attribute (attr:event).
// Returns [{ bucket, value }]. Unlike a people resolve this is the TOTAL aggregate,
// optionally restricted to a caller-provided scope (e.g. a cohort's ids), and
// optionally capped to the top-N buckets by value via `group.limit` (the
// high-cardinality guardrail). The one engine capability charts add.
// Only these reach metric.group. Anything else a caller puts in `group` was
// accepted-and-ignored, which is indistinguishable from an answer.
const GROUP_KEYS = ['by', 'limit', 'band', 'cohortSize', 'use', 'seriesLimit']

// Which aggregate a metric clause names — echoed back beside `cohortSize` so the
// caller knows what the series values ARE without inferring it from their own query.
const GROUP_AGG_NAMES = [
  'count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum',
  'avg', 'min', 'max', 'median', 'percentile', 'earliest', 'latest',
]
const aggregateOf = (m) => GROUP_AGG_NAMES.find(a => m && a in m) || null

export async function resolveGroup(selector, { group, scope, asOf } = {}) {
  // Strict validation, because this function forwards a SUBSET of its input and
  // everything it drops used to be dropped silently — the caller got a
  // plausible number for a different question. Each check below converts one
  // such silent drop into an error that names the working alternative.
  const unknownGroup = Object.keys(group || {}).filter(k => !GROUP_KEYS.includes(k))
  if (unknownGroup.length) {
    throw new Error(
      `selector.group: unknown key "${unknownGroup[0]}" (allowed: ${GROUP_KEYS.join('/')}). ` +
      `Time-grain bucketing is chosen by \`by\` (hour/day/week/month), not a separate \`grain\`; ` +
      `\`band\` groups a numeric \`fact:<key>\` into ranges (e.g. band: 5 → 20-24, 25-29); ` +
      `\`cohortSize: true\` returns { series, cohortSize, aggregate } so a reach % needs no second call; ` +
      `\`use\` picks which of a passport's values a \`fact:<key>\` bucket reads (last/first/max/min); ` +
      `\`by\` may be TWO dimensions to cross-tabulate, and \`seriesLimit\` caps the second one.`,
    )
  }

  const selKeys = Object.keys(selector || {}).filter(k => k !== 'filter')
  if (selKeys.length) {
    throw new Error(`selector.group: \`${selKeys[0]}\` is not applied when grouping — only \`filter.metric\` is. Remove it, or scope the query instead.`)
  }

  const at = asOf ? new Date(asOf) : null
  let scopeArr = scope == null ? null : [].concat(scope)

  // A grouped query takes ONE aggregate to bucket, plus — now — any cohort clauses
  // beside it. Two shapes reach here:
  //
  //   { filter: { metric: … } }                        the aggregate alone
  //   { filter: { all: [ { metric: … }, { fact: … } ] } }   aggregate AND a cohort
  //
  // The second used to throw, telling the caller to move the cohort into
  // `scope.filter`. That was honest — it never silently dropped anything — but it
  // refused the shape everybody writes, and "breakdown of THIS cohort" is the
  // commonest chart there is. The clauses beside the metric are now resolved as a
  // people cohort and intersected into `scope`, which is exactly what moving them
  // to `scope.filter` by hand would have done.
  //
  // `{ metric, fact }` as siblings in ONE clause is still invalid, and rejected by
  // filter.js — a clause carries exactly one of all/any/not/fact/metric. `all` is
  // how you say AND, and that is the form accepted here.
  let m = selector?.filter?.metric
  if (m) {
    // The grouped path reads `filter.metric` straight out of the tree, so
    // filter.js's assertClause never runs and cannot catch this for us. Without the
    // check the sibling is taken as the metric and the rest DROPPED — the exact
    // silent-cohort bug that `all` support exists to make expressible. Same message
    // as assertClause, because it is the same rule.
    const siblings = Object.keys(selector.filter).filter(k => k !== 'metric')
    if (siblings.length) {
      throw new Error(
        `selector.filter: a clause takes exactly one of all/any/not/fact/metric — got metric + ${siblings.join(' + ')}. ` +
        `Combine them explicitly: { all: [{ metric: … }, { ${siblings[0]}: … }] }.`,
      )
    }
  }
  if (!m && Array.isArray(selector?.filter?.all)) {
    const metrics = selector.filter.all.filter(c => c && c.metric)
    if (metrics.length > 1) {
      throw new Error('selector.group: `all` holds more than one `metric` — a grouped query buckets exactly one aggregate')
    }
    if (metrics.length === 1) {
      m = metrics[0].metric
      const rest = selector.filter.all.filter(c => !(c && c.metric))
      if (rest.length) {
        // Resolve the cohort half and AND it into scope. An empty result is a real
        // answer — nobody matched — and must NOT fall through to an unscoped query,
        // which is what an empty array means downstream (`if (scope?.length)`).
        // An empty cohort answers in the shape the caller asked for. Returning a bare
        // [] to a caller that requested `cohortSize` would make them read `.series`
        // off an array and get undefined — an empty chart that looks like a bug in
        // their code rather than a real "nobody matched".
        const empty = () => (group?.cohortSize
          ? { series: [], cohortSize: 0, aggregate: aggregateOf(m) }
          : [])
        const ids = await filter.evaluate(rest.length === 1 ? rest[0] : { all: rest }, baseCtx(at))
        if (!ids.length) return empty()
        scopeArr = scopeArr ? scopeArr.filter(id => new Set(ids).has(id)) : ids
        if (!scopeArr.length) return empty()
      }
    }
  }
  if (!m) {
    throw new Error(
      'selector: `group` requires a `metric` to bucket — either `filter.metric`, or one `{ metric: … }` inside `filter.all`',
    )
  }

  return metric.group(rt.db, m, {
    by: group?.by, limit: group?.limit, band: group?.band, cohortSize: group?.cohortSize,
    use: group?.use, seriesLimit: group?.seriesLimit, at, scope: scopeArr,
  })
}

// A minimal ctx for evaluating a `filter` over the whole base (knowledge cohort).
// scope null ⇒ universe() is a full population read (a positive filter anchor
// avoids it; a pure-negative filter falls back to it — same rule as §5).
function baseCtx(at) {
  let cache
  return {
    at,
    scope: null,
    db: rt.db,
    universe: async () => {
      if (!cache) cache = (await rt.db('whitebox_passports').select('id')).map(r => r.id)
      return cache
    },
  }
}

// Normalize a memory chunk (recall / population / sampleContent all differ
// slightly) into one evidence shape, dropping absent fields.
function asEvidence(rows) {
  return (rows || []).map(r => prune({
    passport_id: r.passport_id,
    channel: r.channel,
    direction: r.direction,
    content: r.chunk_text ?? r.content ?? r.text,
    similarity: r.similarity,
    observed_at: r.ts ?? r.observed_at,
    source: r.source,
    reach: r.customers,                 // sampleContent: how many people the content reached
  }))
}

const prune = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
