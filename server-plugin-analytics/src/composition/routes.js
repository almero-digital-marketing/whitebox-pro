// Composition HTTP surface — reports, widgets, query resolution, and the AI
// compose loop. Mounted on /analytics alongside the existing recall/ask routes
// (separate router, no path collisions). All auth-gated. The frontend three-pane
// console talks to these.
//
//   GET    /analytics/reports                 list reports (newest first)
//   POST   /analytics/reports                 { name, layout? }            → report
//   GET    /analytics/reports/:id             report + its widgets
//   PATCH  /analytics/reports/:id             { name?, layout? }
//   DELETE /analytics/reports/:id             (cascades widgets)
//   POST   /analytics/reports/:id/widgets     { kind, query, title?, presentation?, position?, provenance?, sort? }
//   PATCH  /analytics/widgets/:id             partial widget
//   DELETE /analytics/widgets/:id
//   POST   /analytics/resolve                 run an INLINE query def (live preview, no persistence)
//   POST   /analytics/widgets/:id/resolve     run a persisted widget's stored query
//   POST   /analytics/compose                 { question, report_id? } → AI assembles widgets + data
//   GET    /analytics/schema                  the queryable vocabulary (fact keys, tags) — debug
//
// A "query def" is the inline shape a widget stores (docs/analytics-concept.md §2):
//   { selector?, group?, projection?, scope?, passport?, asOf?, limit?,   // selector path
//     funnel?, named?,                                                    // funnel path
//     breakdownFact?: { key, values[] },                                  // fact-value split
//     question? }                                                         // grounded answer

import express from 'express'
import * as store from './store.js'
import * as compose from './compose.js'
import { buildHistogram } from './histogram.js'
import { maskIdentity, maskEmail, maskPhone, CONTACT_KEYS } from './mask.js'

// donut/radar render a breakdown differently (pie / polygon, same query shape); distribution is a
// histogram of one numeric variable; scatter plots two numeric facts per person; pivot/heatmap render
// a 2-D compare matrix; cohort is a retention grid.
export const KINDS = new Set(['stat', 'timeseries', 'breakdown', 'donut', 'radar', 'distribution', 'scatter', 'pivot', 'heatmap', 'cohort', 'funnel', 'dropoff', 'table', 'answer'])

// Pick the best contact identity to fall back on (email > phone > user > any non-opaque) —
// only ever returned MASKED. Null when a passport has only opaque identities (fingerprint).
function bestIdentity(ids = []) {
  for (const t of ['email', 'phone', 'user']) {
    const m = ids.find((i) => i.type === t)
    if (m) return { value: m.value, type: t }
  }
  const other = ids.find((i) => i.type !== 'fingerprint')
  return other ? { value: other.value, type: other.type } : null
}

// Attach SAFE display fields to the first `limit` passports (the table renders one page).
// PII boundary: raw email/phone must never cross into the analytics app. Each row gets:
//   · label      — the person's name when known, else a masked identity, else (client) short id
//   · contacts   — { email, phone } MASKED (m•••@…, +359•••89) for the table's contact columns
// The raw identity values are never serialized. Names come from one batched query; identities
// are fetched per row (one page) and masked here before anything leaves the server.
export async function enrichPeople(result, passports, limit = 100) {
  if (!Array.isArray(result?.passports)) return result
  const page = result.passports.slice(0, limit)
  const names = await store.namesByPassports(page.map((p) => p.id)).catch(() => ({}))
  await Promise.all(page.map(async (p) => {
    let ids = []
    if (passports?.identities) { try { ids = await passports.identities(p.id) } catch { /* best-effort */ } }
    const email = ids.find((i) => i.type === 'email')
    const phone = ids.find((i) => i.type === 'phone')
    if (email || phone) p.contacts = {
      ...(email ? { email: maskEmail(email.value) } : {}),
      ...(phone ? { phone: maskPhone(phone.value) } : {}),
    }
    const name = names[p.id]
    if (name) { p.label = name; p.label_type = 'name' }
    else { const best = bestIdentity(ids); if (best) { p.label = maskIdentity(best.type, best.value); p.label_type = best.type } }
  }))
  return result
}

// Resolve a list of named sub-queries into a multi-series result. Each sub-query
// goes through the full runQuery, so a series can be a cohort count, a breakdown,
// a timeseries, … whatever it returns is normalised to {bucket,value}[]. This is
// what powers "compare A vs B" (multi-line, grouped bars, overlaid radar).
async function resolveSeries(deps, subs) {
  const series = []
  for (const { name, query } of subs) {
    const r = await runQuery(deps, query || {})
    let points
    if (Array.isArray(r)) points = r
    else if (Array.isArray(r?.series)) points = r.series
    else if (r?.count != null) points = [{ bucket: String(name ?? ''), value: r.count }]
    else points = []
    series.push({ name: String(name ?? ''), points: points.map((p) => ({ bucket: String(p.bucket), value: Number(p.value) || 0 })) })
  }
  return { multi: true, series }
}

// Which projection a widget kind actually needs, when the query does not say.
//
// A `stat` asks "how many?" and used to be answered with `{count, passports:[…]}`
// — 153,245 ids, 9.4 MB, for a number sitting in the first field. Enough to
// exceed an MCP client's budget outright, and pure waste over REST.
//
// `table` genuinely wants the rows. Everything else (breakdown, distribution,
// scatter, funnel, cohort) returns its own shape and never reaches the selector's
// projection path at all.
//
// An explicit `projection` in the query still wins — this only fills the gap.
const PROJECTION_FOR = { stat: 'count', table: 'people' }

// Every key a query def may carry. A key outside this set was accepted and
// ignored, and an ignored key is worse than a rejected one: the caller gets a
// confident answer to a question they did not ask, with nothing in the payload
// to say so. An LLM driving these tools cannot detect that without issuing a
// second query to cross-check, and a human reading a Reports widget cannot
// detect it at all.
//
// The set is the whole DEF, not the subset runQuery reads. A widget's query def
// outlives this call — the chart renderer reads `stack` off it (analytics_chart)
// and the console reads `target` (WidgetCard's goal line). Neither reaches
// resolution, and an allowlist built from what runQuery touches would 400 both.
const QUERY_KEYS = new Set([
  'selector', 'scope', 'group', 'projection', 'passport', 'limit', 'asOf',
  'breakdownFact', 'distribution', 'scatter', 'cohort', 'funnel', 'named',
  'series', 'splitBy', 'question', 'last', 'from',
  'stack', 'target',                                 // presentation — read downstream, not here
])

// Near-misses worth naming explicitly — each is a real shape a caller (or the
// compose model) reaches for, where the generic "unknown key" message would not
// say where the clause belongs.
const QUERY_HINTS = {
  filter: 'put it in `selector.filter` (or `scope.filter` to confine a grouped query to a cohort)',
  metric: 'put it in `selector.filter.metric`',
  fact: 'put it in `selector.filter.fact`, or `scope.filter.fact` when grouping',
  about: 'put it in `selector.about`',
  grain: '`group.by` chooses the time grain (hour/day/week/month)',
  // Both windows live INSIDE the metric, beside the aggregate — `last` relative,
  // `since`/`until` absolute. The old hints here sent people to `asOf`, which is a
  // different thing entirely: it moves the whole query's clock backwards (time
  // travel — "what did this look like in March"), it does not bound a range inside
  // the present.
  window: 'a window belongs in the metric — `filter.metric.last` (relative, e.g. 30d) or `since`/`until` (absolute dates)',
  since: 'put it in the metric — `filter.metric: { count: {...}, since: "2026-02-16" }` (and `until` for a closed range)',
  until: 'put it in the metric — `filter.metric: { count: {...}, until: "2026-02-16" }`',
  last: 'put it in the metric — `filter.metric: { count: {...}, last: "30d" }`',
  held: 'put it in the fact — `filter.fact.<key>: { held: "value" }` (ever held, not just current)',
  distinct: 'put it in the fact — `filter.fact.<key>: { distinct: { gte: 2 } }` (how many different values held)',
  by: 'put it in `group.by`',
  key: 'put it in `breakdownFact.key` (or `distribution.key`)',
}

// `grain` is accepted here but NOT on the core selector `group` (server's
// /query envelope rejects it): a grain only applies to a `fact:<key>` bucket,
// which is resolved in this layer, and the engine's own time grains are chosen
// by `by` instead.
const GROUP_KEYS = new Set(['by', 'limit', 'grain', 'band', 'cohortSize', 'use', 'seriesLimit'])

const GROUP_HINTS = {
  // `group: { by: "day", key: "first_booked_at" }` read as "people by the day of
  // first_booked_at" but resolved as "event rows per calendar day" — off by ~100x.
  key: 'to bucket people by a date fact, use `group: { by: "fact:<key>", grain: "day" }`',
}

// A key being ALLOWED is not the same as it being usable. The allowlist above caught
// typos from the start; what it could not catch is a real key carrying the wrong
// shape, which the resolver then skips over a `?.` guard and drops in silence.
//
// `{"splitBy": "attr:location"}` was the reported case: splitBy is a legitimate key,
// so it passed, and `q.splitBy?.key` is undefined for a string, so the query resolved
// as though it had never been written — a month series with no split and no complaint.
// Same silent-ignore class as breakdownFact on a removed key and group.by:"content_url".
const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e }

function assertQueryShapes(q) {
  if (q.splitBy !== undefined) {
    const v = q.splitBy
    if (typeof v !== 'object' || Array.isArray(v) || v === null) {
      // A string here is someone reaching for a second dimension. Say what splitBy is
      // AND where a second dimension actually lives, because the two are different
      // questions: splitBy compares values of one FACT, group.by takes the dimensions.
      bad(`splitBy must be an object { key: "<factKey>", values: [...] } — got ${JSON.stringify(v)}. ` +
          `It splits one series per value of a FACT. To break down by an event attribute ` +
          `or a second dimension, use \`group.by\` (e.g. { by: ["month", "attr:location"] }).`)
    }
    if (typeof v.key !== 'string' || !v.key) {
      bad(`splitBy needs a \`key\` naming a fact — got ${JSON.stringify(v.key)}`)
    }
    if (v.key.startsWith('attr:') || v.key.startsWith('session:')) {
      bad(`splitBy splits by a FACT's values, and "${v.key}" is an event dimension. ` +
          `Use \`group.by: ["<time or dim>", "${v.key}"]\` for a second dimension.`)
    }
    if (!Array.isArray(v.values) || !v.values.length) {
      bad(`splitBy needs a non-empty \`values\` array — the values of "${v.key}" to compare. ` +
          `Got ${JSON.stringify(v.values)}.`)
    }
  }

  if (q.series !== undefined) {
    if (!Array.isArray(q.series) || !q.series.length) {
      bad(`series must be a non-empty array of { name, query } — got ${JSON.stringify(q.series)}`)
    }
    q.series.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        bad(`series[${i}] must be { name, query } — got ${JSON.stringify(entry)}`)
      }
      if (!entry.query || typeof entry.query !== 'object') {
        bad(`series[${i}] needs a \`query\` — got ${JSON.stringify(entry.query)}`)
      }
    })
  }

  if (q.breakdownFact !== undefined) {
    const v = q.breakdownFact
    if (typeof v !== 'object' || Array.isArray(v) || v === null || typeof v.key !== 'string' || !v.key) {
      bad(`breakdownFact must be { key: "<factKey>", values?: [...] } — got ${JSON.stringify(v)}`)
    }
  }

  if (q.distribution !== undefined) {
    const v = q.distribution
    if (typeof v !== 'object' || Array.isArray(v) || v === null || typeof v.key !== 'string' || !v.key) {
      bad(`distribution must be { source, key } — got ${JSON.stringify(v)}`)
    }
  }
}

// Every fact key a query def rests on, from every shape that can name one.
//
// Needed because a warning about "the fact this answer depends on" has to know which
// facts those are, and they hide in eight different places — a filter tree that
// recurses through all/any/not, a window anchor, an aggregate source, a bucket prefix,
// a breakdown, a distribution, a scatter axis, a splitBy, and a nested series query.
// Missing one means a silent-default question goes unwarned, which is the whole point.
export function factKeysOf(q, out = new Set()) {
  if (!q || typeof q !== 'object') return out
  const FACT_PREFIX = 'fact:'

  const walkFilter = (node) => {
    if (!node || typeof node !== 'object') return
    for (const combinator of ['all', 'any']) {
      if (Array.isArray(node[combinator])) node[combinator].forEach(walkFilter)
    }
    if (node.not) walkFilter(node.not)
    if (node.fact && typeof node.fact === 'object') {
      for (const k of Object.keys(node.fact)) out.add(k)
    }
    const m = node.metric
    if (m && typeof m === 'object') {
      // The window ANCHOR is a fact, and it is the shape most likely to rest on an
      // ambiguous one — "before they first booked" is exactly the question where
      // which-value-do-you-mean changes the answer.
      const w = m.window
      if (w && typeof w === 'object') {
        for (const side of ['before', 'after', 'between']) {
          const spec = w[side]
          for (const one of [].concat(spec ?? [])) {
            if (one && typeof one === 'object' && typeof one.fact === 'string') out.add(one.fact)
          }
        }
      }
      // An aggregate reading a fact rather than an event attribute.
      for (const v of Object.values(m)) {
        if (v && typeof v === 'object' && typeof v.fact === 'string') out.add(v.fact)
      }
    }
  }

  for (const side of ['selector', 'scope']) {
    const sel = q[side]
    if (sel && typeof sel === 'object') walkFilter(sel.filter)
  }
  const by = q.group?.by
  for (const one of [].concat(by ?? [])) {
    if (typeof one === 'string' && one.startsWith(FACT_PREFIX)) out.add(one.slice(FACT_PREFIX.length))
  }
  if (typeof q.breakdownFact?.key === 'string') out.add(q.breakdownFact.key)
  if (q.distribution?.source === 'fact' && typeof q.distribution.key === 'string') out.add(q.distribution.key)
  for (const axis of ['x', 'y', 'colorBy']) {
    if (typeof q.scatter?.[axis] === 'string') out.add(q.scatter[axis])
  }
  if (typeof q.splitBy?.key === 'string') out.add(q.splitBy.key)
  if (Array.isArray(q.series)) q.series.forEach(e => factKeysOf(e?.query, out))
  return out
}

// The fact keys a query ANCHORS on — the `window` boundaries specifically, not every
// fact it touches.
//
// Separated from factKeysOf because the two warrant different warnings. A declaration
// settles what a key MEANS, which is enough for a filter: "clients whose first booking
// was after January" has one answer once you have said which value counts. An anchor is
// not settled by the same statement — each person's boundary is still one of several
// dates, and moving it moves which events fall inside the window, so a caller comparing
// "what they watched before booking" against "after" should know the line was drawn
// among candidates even when the rule for drawing it is declared.
export function anchorKeysOf(q, out = new Map()) {
  if (!q || typeof q !== 'object') return out
  // Map, not Set: the anchor's own `use` has to travel with the key. Reporting the
  // DECLARED rule for an anchor the caller overrode is worse than reporting nothing —
  // it asserts, on the response's own authority, that a number came from semantics it
  // did not come from.
  const note = (key, use) => {
    const prev = out.get(key)
    // First writer wins only if it named a rule: an occurrence with an explicit `use`
    // is more specific than one without, and one query can anchor twice.
    if (prev === undefined || (prev === null && use != null)) out.set(key, use ?? null)
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    for (const c of ['all', 'any']) if (Array.isArray(node[c])) node[c].forEach(walk)
    if (node.not) walk(node.not)
    const w = node.metric?.window
    if (w && typeof w === 'object') {
      for (const side of ['before', 'after', 'between']) {
        for (const one of [].concat(w[side] ?? [])) {
          if (one && typeof one === 'object' && typeof one.fact === 'string') {
            note(one.fact, typeof one.use === 'string' ? one.use : undefined)
          }
        }
      }
    }
  }
  for (const side of ['selector', 'scope']) walk(q[side]?.filter)
  if (Array.isArray(q.series)) q.series.forEach(e => anchorKeysOf(e?.query, out))
  return out
}

// Every place a query can OVERRIDE which value a fact key means, as key → the rule it
// asked for. The engine's precedence is query `use` > declaration > `last`, and the
// provenance fields have to follow the same order or they describe a different query
// than the one that ran.
export function factUsesOf(q, out = new Map()) {
  if (!q || typeof q !== 'object') return out
  const note = (key, use) => { if (typeof key === 'string' && typeof use === 'string') out.set(key, use) }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    for (const c of ['all', 'any']) if (Array.isArray(node[c])) node[c].forEach(walk)
    if (node.not) walk(node.not)
    // A fact predicate: { key: { gte: …, use: 'min' } }
    if (node.fact && typeof node.fact === 'object') {
      for (const [key, pred] of Object.entries(node.fact)) {
        if (pred && typeof pred === 'object' && !Array.isArray(pred)) note(key, pred.use)
      }
    }
    const m = node.metric
    if (m && typeof m === 'object') {
      // An aggregate over a fact: { avg: { fact: 'ltv', use: 'max' } }
      for (const v of Object.values(m)) {
        if (v && typeof v === 'object' && typeof v.fact === 'string') note(v.fact, v.use)
      }
      const w = m.window
      if (w && typeof w === 'object') {
        for (const side of ['before', 'after', 'between']) {
          for (const one of [].concat(w[side] ?? [])) {
            if (one && typeof one === 'object') note(one.fact, one.use)
          }
        }
      }
    }
  }
  for (const side of ['selector', 'scope']) walk(q[side]?.filter)

  // A `fact:<key>` bucket takes its rule from group.use.
  if (typeof q.group?.use === 'string') {
    for (const one of [].concat(q.group?.by ?? [])) {
      if (typeof one === 'string' && one.startsWith('fact:')) note(one.slice(5), q.group.use)
    }
  }
  if (Array.isArray(q.series)) q.series.forEach(e => factUsesOf(e?.query, out))
  return out
}

function assertQueryKeys(q) {
  for (const k of Object.keys(q)) {
    if (QUERY_KEYS.has(k)) continue
    const hint = QUERY_HINTS[k]
    const e = new Error(`query: unknown key "${k}"${hint ? ` — ${hint}` : ` (allowed: ${[...QUERY_KEYS].sort().join(', ')})`}`)
    e.status = 400
    throw e
  }
  assertQueryShapes(q)
  if (q.group && typeof q.group === 'object') {
    for (const k of Object.keys(q.group)) {
      if (GROUP_KEYS.has(k)) continue
      const hint = GROUP_HINTS[k]
      const e = new Error(`group: unknown key "${k}"${hint ? ` — ${hint}` : ` (allowed: ${[...GROUP_KEYS].sort().join(', ')})`}`)
      e.status = 400
      throw e
    }
  }
}

// Resolve one query def. Branches by shape so a widget can be a cohort count, a
// time-series, a fact-value breakdown, a funnel, a grounded answer, or a multi-
// series comparison (series[] / splitBy). Exported so mcp.js can run the exact
// same live-preview/widget-resolve logic the REST routes below use.
// A stored or transmitted query def, or an error. Never `{}` — see runQuery.
function parseQueryString(query) {
  const s = query.trim()
  if (!s) bad('query is empty')
  try {
    return JSON.parse(s)
  } catch (err) {
    const at = /position (\d+)/.exec(err.message)
    const pos = at ? Number(at[1]) : null
    const near = pos == null ? '' :
      ` near: …${s.slice(Math.max(0, pos - 40), pos)}<<HERE>>${s.slice(pos, pos + 40)}…`
    bad(`query is not valid JSON: ${err.message}.${near}`)
  }
}

export async function runQuery(deps, query = {}, kind) {
  // A query def stored or passed as a JSON STRING is still a query def.
  //
  // Belt as well as the braces at the MCP boundary: widgets persisted before
  // that fix hold a string in `query`, and reading `.selector` off a string
  // yields undefined — which lands on the unfiltered resolve below and answers
  // with the entire population. Silently, and on every view. Coercing here
  // repairs those rows without a migration; anything already an object passes
  // straight through.
  //
  // UNPARSEABLE is refused, not defaulted. This used to `return {}`, which is the
  // whole base — the same "invalid request answered with a plausible number" this
  // coercion exists to prevent, reintroduced by its own error branch. A stored widget
  // holding broken JSON should show an error, not a total.
  const q = typeof query === 'string' ? parseQueryString(query) : (query || {})
  if (typeof q !== 'object' || Array.isArray(q)) {
    bad(`query must be an object — got ${Array.isArray(q) ? 'an array' : typeof q}`)
  }
  assertQueryKeys(q)
  const { selector, awareness } = deps
  // `scope` confines a query to a cohort: an explicit passport-id array, OR a people
  // sub-selector (a cohort filter) resolved to ids here — so an aggregate (group/
  // timeseries), a people query, OR a grounded answer can be scoped to "active
  // customers", "VIPs", … without the caller enumerating them.
  // THE EFFECTIVE COHORT: `scope` AND `selector.filter`, intersected.
  //
  // This read `q.scope` alone, and every kind that resolves through it —
  // breakdownFact, distribution, scatter, cohort — therefore discarded
  // `selector.filter` in silence. A breakdown by studio with a
  // `booking = noshow` filter returned the same numbers as `booking = attended`,
  // because neither was applied and both were the unfiltered base. On the GPoint
  // data that reads as 283,087 customers against a base of 284,176 — a plausible
  // enough figure to publish, and the reason this went unnoticed.
  //
  // The `selector` path below never had the bug (it passes q.selector to the
  // engine), so the two halves of the same query object disagreed about whether
  // filters count, depending on which widget kind you asked for.
  //
  // Resolved to ids rather than composed into each branch's own filter because the
  // branches take a scope ARRAY (store.factBreakdown, factValues, factPairs,
  // cohortRows) — an id list is the shape they all already accept.
  const cohortScope = async () => {
    const parts = []
    if (q.scope) {
      parts.push(Array.isArray(q.scope)
        ? q.scope
        : (await selector.resolve(q.scope, { projection: 'people', asOf: q.asOf })).passports.map((p) => p.id))
    }
    if (q.selector?.filter) {
      parts.push((await selector.resolve({ filter: q.selector.filter }, { projection: 'people', asOf: q.asOf })).passports.map((p) => p.id))
    }
    if (!parts.length) return undefined                    // genuinely unscoped
    if (parts.length === 1) return parts[0]

    const [a, b] = parts
    const keep = new Set(b)
    return a.filter((id) => keep.has(id))
  }

  // A cohort that matched NOBODY is not the same as no cohort, and every consumer
  // of a scope array treats an empty one as "unscoped" (`if (scope?.length)`) — so
  // an empty result would silently widen back to the whole base, which is the
  // exact failure this whole change exists to remove. Callers check this.
  const emptyCohort = (scope) => Array.isArray(scope) && scope.length === 0

  // ── multi-series (compare A vs B) ─────────────────────────────────────────────
  // `series`: explicit named sub-queries — compare anything vs anything.
  // `splitBy`: sugar — split the base query into one series per value of a fact,
  //   each scoped to that value (active vs lapsed, gold vs silver). Capped at 6.
  if (Array.isArray(q.series) && q.series.length) {
    return resolveSeries(deps, q.series.slice(0, 6))
  }
  if (q.splitBy?.key && Array.isArray(q.splitBy.values) && q.splitBy.values.length) {
    const { key, values } = q.splitBy
    const base = { ...q }; delete base.splitBy
    const subs = values.slice(0, 6).map((v) => ({
      name: v,
      query: { ...base, scope: { filter: { fact: { [key]: { eq: v } } } } },
    }))
    return resolveSeries(deps, subs)
  }

  if (q.question) {
    if (!awareness?.askPopulation) return { answer: 'Answers are unavailable (awareness not wired).' }
    // scope + last/from ground the generative answer in the structured cohort + window
    return awareness.askPopulation({ question: q.question, scope: await cohortScope(), last: q.last, from: q.from })
  }
  // A fact-valued group bucket is NOT a core group dimension (the engine groups by a
  // time grain, a column, session:<utm>, or attr:<key>). Resolve it the breakdownFact
  // way — one people-count per fact value. This also rescues the compose model, which
  // emits the fact key as the bucket in several forms ("fact:status", or a bare
  // "status") instead of the breakdownFact shape.
  // MUST list every bucket the engine understands. `content_url`/`content_hash`
  // were missing, and the else-branch below reads an unlisted token as a FACT KEY —
  // so `by: 'content_url'` ran a breakdown of a fact nobody has ever recorded and
  // returned `{ series: [], total: 0 }`. An empty chart, no error, and the bucket
  // had been supported by the engine the whole time.
  const CORE_BUCKETS = new Set([
    'hour', 'day', 'week', 'month',
    'channel', 'direction', 'source', 'content', 'content_url', 'content_hash',
  ])
  const by = typeof q.group?.by === 'string' ? q.group.by : null
  // An explicit `fact:` prefix is unambiguous, so it is taken at its word. Only a
  // BARE token is a guess, and only a guess gets checked against the vocabulary.
  const explicitFact = by != null && by.startsWith('fact:')
  const factGroup = !by ? null
    : by.startsWith('fact:') ? by.slice(5)
      : (by.startsWith('session:') || by.startsWith('attr:') || CORE_BUCKETS.has(by)) ? null
        : by   // a bare token that isn't a core bucket → treat it as a fact key
  if (q.breakdownFact || factGroup) {
    const scope = await cohortScope()
    if (emptyCohort(scope)) return { series: [], total: 0 }
    const key = q.breakdownFact?.key || factGroup
    // An unknown key has no rows, and no rows renders as a legitimately empty chart —
    // so a typo, a renamed key and a DELETED key all come back as {series:[],total:0},
    // indistinguishable from "nobody matched". Same silent-empty class as the
    // group.by:"content_url" case.
    //
    // Checked for EVERY spelling of a fact bucket, not just the bare-token fallback.
    // It was guarded by `!q.breakdownFact && !explicitFact` on the reasoning that a
    // caller naming a fact explicitly meant it — but meaning it is not the same as
    // being right, and those two spellings are the ones dashboards actually store.
    // The six booking_* keys were removed on 2026-08-18, so every widget still
    // breaking down by them was reading an empty chart as a real answer.
    //
    // A key that EXISTS but matches nothing still returns an empty series: usedKeys()
    // is the keys present in the log, so a real key with no matching rows is a
    // legitimate zero and only a key nobody has ever written is an error.
    {
      // The vocabulary is what has been WRITTEN plus what the deployment DECLARES.
      // usedKeys() alone cannot tell a typo from a key that is declared and simply has
      // no rows yet, and that ambiguity is why the explicit spellings were exempted
      // from this check in the first place. With declarations in it the rule is exact:
      //
      //   declared, no rows yet  → empty series (nobody has a value yet IS an answer)
      //   never declared, no rows → error (a typo, or a key that has been removed)
      //
      // The six booking_* keys were deliberately undeclared and were deleted on
      // 2026-08-18, so they land in the second case — which is the reported bug.
      let known = null
      try {
        const used = (await deps.facts?.usedKeys?.()) ?? null
        if (Array.isArray(used)) {
          const declared = (deps.facts?.declaredKeys?.() ?? []).map(d => d.key ?? d)
          known = [...new Set([...used, ...declared])]
        }
      } catch { known = null }
      if (Array.isArray(known) && !known.includes(key)) {
        const named = !!q.breakdownFact || explicitFact
        const e = new Error(
          (named
            ? `unknown fact key "${key}" — nothing has ever been recorded under it. `
            : `unknown group bucket "${key}" — not a fact key and not a core bucket ` +
              `(${[...CORE_BUCKETS].join('/')}, session:<utm>, attr:<key>, fact:<key>). `) +
          `Known facts: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''}`)
        e.status = 400
        throw e
      }
    }
    // never break a chart down by a contact identifier — its bucket labels would be raw PII
    if (CONTACT_KEYS.has(key)) { const e = new Error(`cannot group by the identity field "${key}"`); e.status = 400; throw e }
    const values = q.breakdownFact?.values

    // An explicit value list still resolves one bucket at a time, because the
    // caller may be asking about values that no longer occur (a plan tier
    // nobody is on is a legitimate zero, and a GROUP BY cannot produce a row
    // for something absent from the data).
    if (values?.length) {
      const series = []
      for (const v of values) {
        const r = await selector.resolve({ filter: { fact: { [key]: { eq: v } } } }, { projection: 'count', asOf: q.asOf, scope })
        series.push({ bucket: String(v), value: r.count })
      }
      return { series }
    }

    // Discovered buckets: ONE aggregation rather than one resolve per value.
    //
    // The loop this replaces asked "how many people have key = v" once per
    // value, each time re-deriving current-value-per-passport across the whole
    // key partition — N full passes to answer N slices of a single GROUP BY.
    // It also took its values from factDistinctValues, which returns an
    // arbitrary twelve with no ORDER BY, so the chart was neither complete nor
    // the top of anything: gpoint has 56 services and the two most used did not
    // appear at all.
    //
    // `total` rides along so a caller can say "top 12 of 56" instead of
    // implying twelve is all there is.
    //
    // `grain`/`limit` are honoured from EITHER spelling — `group: { by: "fact:k",
    // grain, limit }` or `breakdownFact: { key, grain, limit }`. Both land here,
    // and both used to reach factBreakdown with neither, so a `limit: 400` came
    // back as twelve raw-timestamp buckets ranked by value. A date-typed fact with
    // a grain now gives day/week/month buckets in chronological order, counting
    // DISTINCT PEOPLE.
    const grain = q.group?.grain ?? q.breakdownFact?.grain
    const factLimit = q.group?.limit ?? q.breakdownFact?.limit
    const out = await store.factBreakdown(key, scope, { grain, ...(factLimit != null ? { limit: factLimit } : {}) })
    return out
  }
  if (q.distribution) {
    // Histogram of a numeric fact's value per person, or of how many of an event
    // each person did. Binned in JS (auto, or explicit `bins` edges) — never via
    // the fact predicate (its comparator mis-orders numeric strings as dates).
    const { source = 'fact', key, bins, maxBins } = q.distribution
    if (!key) throw new Error('distribution requires a key')
    const scope = await cohortScope()
    if (emptyCohort(scope)) return buildHistogram([], { bins, maxBins })
    const values = source === 'event'
      ? await store.eventCounts(key, scope)
      : await store.factValues(key, scope)
    return buildHistogram(values, { bins, maxBins })
  }
  if (q.scatter) {
    // One dot per person at (factX, factY); optional colorBy groups the dots.
    // Two numeric facts read raw + cast (never via the fact predicate).
    const { x, y, colorBy, limit } = q.scatter
    if (!x || !y) throw new Error('scatter requires x and y fact keys')
    const sScope = await cohortScope()
    if (emptyCohort(sScope)) return { points: [], x, y, ...(colorBy ? { colorBy } : {}) }
    const points = await store.factPairs(x, y, { scope: sScope, colorBy, limit })
    return { points, x, y, ...(colorBy ? { colorBy } : {}) }
  }
  if (q.cohort) {
    // Retention grid: cohort = each person's FIRST active period; cell = % of that
    // cohort still active k periods later. Rendered as a matrix (rows × M0..Mn).
    const { event, grain = 'month', periods = 6 } = q.cohort
    const cScope = await cohortScope()
    const rows = emptyCohort(cScope) ? [] : await store.cohortRows(event, grain, cScope)
    const idxOf = (d) => grain === 'week'
      ? Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / (7 * 864e5))
      : d.getUTCFullYear() * 12 + d.getUTCMonth()
    const labelOf = (n) => grain === 'week' ? `wk ${n}` : `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
    const byId = new Map()
    for (const { id, p } of rows) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(idxOf(p)) }
    const cohorts = new Map()   // firstIdx → { size, active: Map(offset → count) }
    for (const idxs of byId.values()) {
      const first = Math.min(...idxs)
      let c = cohorts.get(first); if (!c) cohorts.set(first, c = { size: 0, active: new Map() })
      c.size++
      for (const off of new Set(idxs.map((i) => i - first))) {
        if (off >= 0 && off <= periods) c.active.set(off, (c.active.get(off) || 0) + 1)
      }
    }
    const cohortIdxs = [...cohorts.keys()].sort((a, b) => a - b)
    const offsets = Array.from({ length: periods + 1 }, (_, k) => k)
    const series = offsets.map((k) => ({
      name: `${grain === 'week' ? 'W' : 'M'}${k}`,
      points: cohortIdxs.map((ci) => {
        const c = cohorts.get(ci)
        return { bucket: labelOf(ci), value: c.size ? Math.round((c.active.get(k) || 0) / c.size * 100) : 0 }
      }),
    }))
    return { multi: true, cohort: true, unit: '%', series, sizes: cohortIdxs.map((ci) => ({ cohort: labelOf(ci), size: cohorts.get(ci).size })) }
  }
  if (q.funnel) {
    const f = await selector.funnel(q.funnel, { asOf: q.asOf, named: q.named })
    // shape the drop-off report into a chartable series (each step a bar)
    return { series: (f.report || []).map((s) => ({ bucket: s.name || `Step ${s.step}`, value: s.count })), report: f.report }
  }
  // `scope` ONLY — deliberately not cohortScope().
  //
  // This path hands `q.selector` straight to the engine, so the filter is already
  // applied where it belongs. Adding cohortScope() here would resolve that same
  // filter a second time, to a full id list, purely to pass it back as a scope the
  // engine then re-intersects — materialising the 153,245 ids / 9.4 MB that
  // PROJECTION_FOR above exists to avoid, to answer a `stat` that is one number.
  // Same result, twice the work, on the two commonest widget kinds.
  //
  // cohortScope() is for the branches that CANNOT do this: breakdownFact,
  // distribution, scatter and cohort read a scope array and never see
  // `selector.filter` at all, which is the bug it was added for.
  const plainScope = Array.isArray(q.scope) || !q.scope
    ? q.scope
    : (await selector.resolve(q.scope, { projection: 'people', asOf: q.asOf })).passports.map((p) => p.id)
  return selector.resolve(q.selector || {}, {
    projection: q.projection || PROJECTION_FOR[kind], scope: plainScope, passport: q.passport,
    asOf: q.asOf, limit: q.limit, group: q.group,
  })
}

// Reduce a widget's resolved data to the essentials the explainer needs (and a stable
// fingerprint to cache by). Keeps the AI prompt small and skips identity/PII rows.
const seriesOf = (d) => (Array.isArray(d) ? d : d?.series || [])
export function compactForExplain(kind, data) {
  if (data?.multi) {   // a comparison — give the explainer each named series so it can say which leads
    return { comparison: (data.series || []).map((s) => ({ name: s.name, points: s.points.slice(0, 40).map((p) => [p.bucket, p.value]) })) }
  }
  if (kind === 'stat') return { count: data?.count ?? 0, ...(data?.target ? { target: data.target, pctOfTarget: Math.round((data.count / data.target) * 100) } : {}) }
  if (kind === 'table') return { count: data?.count ?? data?.passports?.length ?? 0 }
  // A funnel gets its drops COMPUTED, exactly as a dropoff does.
  //
  // It used to hand over the step counts alone, while the explain prompt asks for
  // "the step with the biggest leak and how many people fell out there" — for a
  // funnel as well as a dropoff. So the model was asked for a figure the data did
  // not contain and had to subtract six-digit numbers itself. It got one wrong on
  // the GPoint board: 115,491 visited and 6,318 booked was reported as "108,173
  // visitors did not book", which is 1,000 short of 109,173.
  //
  // Arithmetic is not what a language model is for, and the failure is the worst
  // kind — a wrong number in confident prose, sitting beside the correct chart that
  // contradicts it. Everything the prompt asks the model to state is now something
  // it can read rather than derive.
  if (kind === 'funnel' || kind === 'dropoff') {
    const steps = (data?.report || seriesOf(data)).map((s) => [s.name ?? s.bucket, s.count ?? s.value])
    const drops = []
    for (let i = 0; i < steps.length - 1; i++) {
      const from = steps[i][1] || 0, lost = Math.max(0, from - (steps[i + 1][1] || 0))
      drops.push({ from: steps[i][0], to: steps[i + 1][0], lost, pct: from ? Math.round((lost / from) * 100) : 0 })
    }
    // A dropoff is ABOUT the loss, so it stays loss-only. A funnel is about the
    // passage and the loss both — it is drawn as the surviving cohorts — so it
    // keeps its steps and gains the drops beside them.
    return kind === 'dropoff' ? { drops } : { steps, drops }
  }
  if (kind === 'donut') {   // a donut is about SHARE — give the explainer each slice's percent, not just the count
    const s = seriesOf(data)
    const total = s.reduce((a, b) => a + (b.value || 0), 0) || 1
    return { total, slices: s.slice(0, 40).map((b) => [b.bucket, b.value, `${Math.round((b.value / total) * 100)}%`]) }
  }
  if (kind === 'scatter') {   // a scatter is about RELATIONSHIP — summarise ranges + correlation, not raw dots
    const pts = (Array.isArray(data) ? data : data?.points || data?.series) || []
    const n = pts.length
    const rng = (sel) => { const v = pts.map(sel); return n ? { min: Math.min(...v), max: Math.max(...v) } : null }
    let r = null
    if (n > 1) {
      const mean = (sel) => pts.reduce((a, p) => a + sel(p), 0) / n
      const mx = mean((p) => p.x), my = mean((p) => p.y)
      let sxy = 0, sx = 0, sy = 0
      for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy }
      if (sx > 0 && sy > 0) r = Math.round((sxy / Math.sqrt(sx * sy)) * 100) / 100   // Pearson, 2dp
    }
    return { n, x: data?.x, y: data?.y, xRange: rng((p) => p.x), yRange: rng((p) => p.y), correlation: r }
  }
  return { series: seriesOf(data).slice(0, 40).map((b) => [b.bucket, b.value]) }   // timeseries / breakdown / distribution
}
// fingerprint → explanation. In-memory: regenerate only when a widget's RESULT changes
// (the frontend re-requests on every resolve; unchanged data is a cache hit, no AI call).
const explainCache = new Map()
// report-state fingerprint → suggested questions (the compose "Try one:" chips).
const suggestCache = new Map()

// question → AI assembles widget specs → persisted into a (draft) report, each
// validated by actually resolving it (a widget whose query the selector rejects
// is dropped, never saved) → resolved data attached so the caller can render
// immediately. Exported so both the REST /compose route and the MCP
// analytics_compose tool run this exact same logic — one implementation, two
// transports, matching the rest of this codebase.
export async function composeReport({ selector, awareness, passports, logger }, { question, report_id } = {}) {
  if (!question || typeof question !== 'string') { const e = new Error('question is required'); e.status = 400; throw e }
  const deps = { selector, awareness }
  const specs = await compose.composeWidgets(question)

  let report = report_id ? await store.getReport(report_id) : null
  if (!report) report = await store.createReport({ name: question.slice(0, 80) })
  let sort = report.widgets?.length || 0

  const widgets = []
  for (const s of specs) {
    let data
    try { data = await runQuery(deps, s.query) }
    catch (e) {
      logger?.warn?.({ err: e.message, title: s.title, kind: s.kind }, 'compose: dropping widget whose query failed to resolve')
      continue
    }
    // Guarded like the resolve above, and for the same reason: the contract is
    // that a widget the pipeline rejects is dropped and never saved — not that
    // one bad widget costs the user every good one in the batch. The store
    // validates the query now, so this can throw where it previously could not.
    let row
    try { row = await store.addWidget(report.id, { ...s, provenance: 'ai', sort: sort++ }) }
    catch (e) {
      logger?.warn?.({ err: e.message, title: s.title, kind: s.kind }, 'compose: dropping widget the store rejected')
      continue
    }
    if (row.kind === 'table') { try { data = await enrichPeople(data, passports) } catch { /* keep raw */ } }
    widgets.push({ ...row, data, error: null })
  }
  return { report: { id: report.id, name: report.name }, widgets }
}

// The widget summary = the AI's plain-language reading of the query (the same text
// the Agent tab shows). Generated lazily on first request and persisted, so the AI
// runs ONCE per query version — re-runs only after a query edit (which clears the
// stored summary). Exported for the same one-implementation-two-transports reason
// as composeReport above.
export async function widgetSummary(logger, id) {
  const w = await store.getWidget(id)
  if (!w) { const e = new Error('widget not found'); e.status = 404; throw e }
  if (w.summary) return { summary: w.summary, cached: true }
  let summary = null
  try { summary = await compose.describeQuery(w.query) }
  catch (err) { logger?.warn?.({ err }, 'describe (widget summary) failed') }
  if (summary) await store.updateWidget(id, { summary })
  return { summary }
}

export function mountComposition(app, { requireRead, requireWrite, selector, awareness, passports, logger }) {
  const router = express.Router()
  const deps = { selector, awareness }
  // A client error carries its own status and message — a malformed query is a
  // 422 with a path per problem — and flattening that to a generic 500 would
  // discard the only part the caller can act on, while logging our own noise as
  // if it were a fault. Anything without a sub-500 status is still ours: still
  // logged, still opaque to the caller.
  const fail = (res, err, msg) => {
    if (err?.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) })
    }
    logger.error({ err }, msg)
    res.status(500).json({ error: msg })
  }

  // ── reports ────────────────────────────────────────────────────────────────
  router.get('/reports', requireRead, async (req, res) => {
    try { res.json({ data: await store.listReports() }) }
    catch (err) { fail(res, err, 'list reports failed') }
  })

  router.post('/reports', requireWrite, async (req, res) => {
    const { name, layout } = req.body || {}
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' })
    try { res.status(201).json(await store.createReport({ name, layout })) }
    catch (err) { fail(res, err, 'create report failed') }
  })

  router.get('/reports/:id', requireRead, async (req, res) => {
    try {
      const report = await store.getReport(req.params.id)
      if (!report) return res.status(404).json({ error: 'report not found' })
      res.json(report)
    } catch (err) { fail(res, err, 'get report failed') }
  })

  router.patch('/reports/:id', requireWrite, async (req, res) => {
    try {
      const row = await store.updateReport(req.params.id, req.body || {})
      if (!row) return res.status(404).json({ error: 'report not found' })
      res.json(row)
    } catch (err) { fail(res, err, 'update report failed') }
  })

  router.delete('/reports/:id', requireWrite, async (req, res) => {
    try { res.json({ deleted: await store.deleteReport(req.params.id) }) }
    catch (err) { fail(res, err, 'delete report failed') }
  })

  // ── widgets ──────────────────────────────────────────────────────────────────
  router.post('/reports/:id/widgets', requireWrite, async (req, res) => {
    const w = req.body || {}
    if (!KINDS.has(w.kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(', ')}` })
    if (!w.query || typeof w.query !== 'object') return res.status(400).json({ error: 'query (object) is required' })
    try {
      const report = await store.getReport(req.params.id)
      if (!report) return res.status(404).json({ error: 'report not found' })
      const row = await store.addWidget(req.params.id, w)
      res.status(201).json(row)
    } catch (err) { fail(res, err, 'add widget failed') }
  })

  router.patch('/widgets/:id', requireWrite, async (req, res) => {
    if (req.body?.kind && !KINDS.has(req.body.kind)) return res.status(400).json({ error: 'invalid kind' })
    try {
      // store.updateWidget nulls the summary when the query changes, so the next view
      // re-summarises (AI runs once per query version, not on every save).
      const row = await store.updateWidget(req.params.id, req.body || {})
      if (!row) return res.status(404).json({ error: 'widget not found' })
      res.json(row)
    } catch (err) { fail(res, err, 'update widget failed') }
  })

  // The widget summary = the AI's plain-language reading of the query (the same text
  // the Agent tab shows). Generated lazily on first request and persisted, so the AI
  // runs ONCE per query version — keeping add/compose/save fast. Re-runs only after a
  // query edit (which clears the stored summary).
  // Read-gated despite internally caching the summary onto the widget row —
  // that's an implementation detail (avoid re-asking the AI), not a
  // user-facing write action; viewing a widget shouldn't need edit rights.
  router.post('/widgets/:id/summary', requireRead, async (req, res) => {
    try { res.json(await widgetSummary(logger, req.params.id)) }
    catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message })
      res.status(502).json({ error: `summary failed: ${err.message}` })
    }
  })

  router.delete('/widgets/:id', requireWrite, async (req, res) => {
    try { res.json({ deleted: await store.deleteWidget(req.params.id) }) }
    catch (err) { fail(res, err, 'delete widget failed') }
  })

  // Drag-to-reorder: body { order: [widgetId, …] } → sort follows the array.
  router.patch('/reports/:id/reorder', requireWrite, async (req, res) => {
    const order = req.body?.order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array of widget ids) is required' })
    try { await store.reorderWidgets(req.params.id, order); res.json({ ok: true }) }
    catch (err) { fail(res, err, 'reorder widgets failed') }
  })

  // ── resolve ──────────────────────────────────────────────────────────────────
  router.post('/resolve', requireRead, async (req, res) => {
    try {
      let data = await runQuery(deps, req.body || {}, req.body?.kind)
      if (req.body?.kind === 'table') data = await enrichPeople(data, passports)   // live preview of a people table
      res.json(data)
    } catch (err) { res.status(400).json({ error: err.message }) }
  })

  router.post('/widgets/:id/resolve', requireRead, async (req, res) => {
    try {
      const w = await store.getWidget(req.params.id)
      if (!w) return res.status(404).json({ error: 'widget not found' })
      let data = await runQuery(deps, w.query, w.kind)   // w.query is parsed jsonb
      if (w.kind === 'table') data = await enrichPeople(data, passports)   // label the rows people see
      res.json(data)
    } catch (err) { res.status(400).json({ error: err.message }) }
  })

  // ── compose (the "just ask" loop) ─────────────────────────────────────────────
  // question → AI assembles widgets → persisted into a (draft) report → each
  // resolved so the board can render immediately.
  // write-gated: the "just ask" loop persists a (draft) report + widgets, not
  // just a read — see analytics:write's catalog description.
  router.post('/compose', requireWrite, async (req, res) => {
    try { res.json(await composeReport({ selector, awareness, passports, logger }, req.body || {})) }
    catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message })
      logger.error({ err }, 'compose failed')
      res.status(502).json({ error: `compose failed: ${err.message}` })
    }
  })

  // ── describe — query def → plain-language question (inverse of compose) ────────
  router.post('/describe', requireRead, async (req, res) => {
    try { res.json({ summary: await compose.describeQuery(req.body?.query || {}) }) }
    catch (err) { res.status(502).json({ error: `describe failed: ${err.message}` }) }
  })

  // ── explain — a widget's RESULT → a 1–2 sentence plain insight (the left column) ─
  // Stateless: the frontend posts the data it already rendered, so we don't re-resolve.
  // Cached by a result fingerprint → only regenerates when the data actually changes.
  router.post('/explain', requireRead, async (req, res) => {
    const { id, title, kind, data } = req.body || {}
    if (!kind || kind === 'answer') return res.json({ explanation: null })   // answers are already prose
    try {
      const compact = compactForExplain(kind, data)
      // Key by widget id (not just title): two distinct widgets that reduce to the same
      // compacted numbers — common for empty/zero results, or stat/table → just {count} —
      // must not share a cached insight. id still lets the SAME widget re-cache on data change.
      const fp = `${id || title || ''}::${kind}::${JSON.stringify(compact)}`
      if (explainCache.has(fp)) return res.json({ explanation: explainCache.get(fp), cached: true })
      const explanation = await compose.explainWidget({ title, kind, data: compact })
      if (explainCache.size > 500) explainCache.clear()                       // bounded
      explainCache.set(fp, explanation)
      res.json({ explanation })
    } catch (err) { res.status(502).json({ error: `explain failed: ${err.message}` }) }
  })

  // ── person insight — ONE selected list row → a 1–2 sentence profile of them ────
  // Drives the list widget's insight column when a client is selected. Gathers the
  // person's facts + recent activity here, then the AI profiles them. Cached by
  // passport id (+ list context), bounded.
  const personCache = new Map()
  router.post('/people/:id/insight', requireRead, async (req, res) => {
    const id = req.params.id
    const { context } = req.body || {}   // the client-sent label is ignored — `who` is derived server-side
    try {
      const ck = `${id}::${context || ''}`
      if (personCache.has(ck)) return res.json({ explanation: personCache.get(ck), cached: true })
      const [facts, activity] = await Promise.all([store.personFacts(id), store.personActivity(id)])
      // PII boundary: never put a raw contact identifier in the LLM prompt. Name is allowed.
      const safeFacts = Object.fromEntries(Object.entries(facts).filter(([k]) => !CONTACT_KEYS.has(k)))
      const who = safeFacts.full_name || id.slice(0, 8)
      const explanation = await compose.explainPerson({ who, facts: safeFacts, activity, context })
      if (personCache.size > 500) personCache.clear()
      personCache.set(ck, explanation)
      res.json({ explanation })
    } catch (err) { res.status(502).json({ error: `person insight failed: ${err.message}` }) }
  })

  // ── suggestions — the compose box "Try one:" chips, grounded in the report ─────
  // Clue hierarchy (see compose.suggestQuestions): existing widgets → meaningful
  // name → just the data vocabulary. ?report_id scopes to that report's state; no
  // report_id → generic starters. Cached by report-state fingerprint. On any
  // failure we 200 with an empty list so the frontend keeps its static defaults.
  router.get('/suggestions', requireRead, async (req, res) => {
    try {
      let name = '', widgets = []
      if (req.query.report_id) {
        const report = await store.getReport(req.query.report_id)
        if (report) {
          name = report.name || ''
          widgets = (report.widgets || []).map((w) => ({ title: w.title, kind: w.kind }))
        }
      }
      const fp = `${name}::${widgets.map((w) => `${w.kind}:${w.title}`).join('|')}`
      if (suggestCache.has(fp)) return res.json({ suggestions: suggestCache.get(fp), cached: true })
      const suggestions = await compose.suggestQuestions({ name, widgets })
      if (suggestCache.size > 200) suggestCache.clear()
      suggestCache.set(fp, suggestions)
      res.json({ suggestions })
    } catch (err) {
      logger.warn({ err }, 'suggestions failed')
      res.json({ suggestions: [] })   // soft-fail → frontend keeps its defaults
    }
  })

  // ── schema (debug — what the AI is grounded on) ───────────────────────────────
  router.get('/schema', requireRead, async (req, res) => {
    try { res.json(await compose.discoverSchema({ refresh: req.query.refresh === '1' })) }
    catch (err) { fail(res, err, 'schema discovery failed') }
  })

  app.use('/analytics', router)
}
