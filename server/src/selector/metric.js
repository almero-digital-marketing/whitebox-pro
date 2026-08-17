// Evaluate a `metric` over the awareness exposure stream. Two modes:
//   · evaluate(db, spec, …) → the passports whose per-passport aggregate satisfies
//                             a bound (the *gate*, used by filter.metric — §5)
//   · group(db, spec, { by }) → the TOTAL aggregate bucketed by a time grain or a
//                             dimension → [{ bucket, value }] (the *chart* — §7)
// Both share the same event filters; they differ only in what they GROUP BY.
//
// Dimensions reach their natural typed home (see docs/event-attributes.md):
//   · exposure columns   channel / direction / source            (low-cardinality, indexed)
//   · session columns    session: { utm_campaign: … }            (LEFT JOIN whitebox_sessions)
//   · open per-event dims attrs: { event: 'email_open', … }      (meta jsonb)
// `content` (substring on content_id) is DEPRECATED — content_id is untrusted/opaque
// and nothing structural may depend on it. It keeps resolving for now; nothing new
// uses it; it is removed once analytics migrates off (docs/event-attributes.md §4/§7).

import { whereScope } from '../db.js'
import * as computed from '../facts/computed.js'

const EXPOSURES = 'whitebox_awareness_exposures'
const SESSIONS = 'whitebox_sessions'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'channel', 'direction', 'last', 'since', 'until', 'session', 'attrs']
const GATE_AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
const GROUP_AGGS = [
  'count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum',
  'avg', 'min', 'max', 'median', 'percentile', 'earliest', 'latest',
]

// The numeric column an aggregate may read directly. An allowlist because the name
// is interpolated: `dwell_ms` is the only numeric measure on an exposure, and `ts`
// is deliberately absent — "avg of a timestamp" is a question about buckets, not
// values, and `by` already answers it.
const AGG_COLS = ['dwell_ms']

// The session columns reachable via exposures.session_id → whitebox_sessions. A
// FIXED ALLOWLIST — safe to reference a column by name; values are always bound.
const SESSION_COLS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer']
function sessionCol(col) {
  if (!SESSION_COLS.includes(col)) throw new Error(`selector.metric: unknown session column "${col}" (allowed: ${SESSION_COLS.join('/')})`)
  return col
}

function windowMs(w) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(w ?? '').trim())
  if (!m) throw new Error(`selector.metric: bad window "${w}" (use 7d, 24h, 2w)`)
  return Number(m[1]) * MS[m[2]]
}

// Split a spec into { filters, agg, bounds }, validating the aggregate against the
// set valid for this mode (gate vs group).
function split(spec, validAggs) {
  const filters = {}
  let agg, bounds
  for (const [k, v] of Object.entries(spec || {})) {
    if (FILTER_KEYS.includes(k)) filters[k] = v
    else if (validAggs.includes(k)) { agg = k; bounds = v || {} }
    else throw new Error(`selector.metric: unknown key "${k}"`)
  }
  if (!agg) throw new Error(`selector.metric: needs one aggregate (${validAggs.join('/')})`)
  return { filters, agg, bounds }
}

// The exposures query, aliased `e`; sessions joined as `s` only when needed (a
// `session:` filter/group). With the join, exposure columns MUST be qualified
// (`e.…`) — whitebox_sessions also has passport_id.
const needsSession = (filters, by) =>
  (filters.session && Object.keys(filters.session).length > 0) ||
  (typeof by === 'string' && by.startsWith('session:'))

// `fact:<key>` — the bucket comes from whitebox_facts, not from the exposure row,
// so it needs its own join. Core could not group by a fact at all: the analytics
// layer intercepted `fact:` and answered it with a separate per-key query, which is
// why a fact breakdown could not be combined with an event window or aggregate.
//
// Joined at CURRENT-value-per-passport, the same rule the fact predicate uses, so a
// breakdown and a `{ fact: { k: { eq: v } } }` filter agree about which bucket
// someone is in. LEFT, so a passport with no such fact lands in a null bucket
// rather than vanishing — an absent value is information, and dropping those rows
// would silently change the total.
const FACT_PREFIX = 'fact:'
const factKeyOf = (by) => (typeof by === 'string' && by.startsWith(FACT_PREFIX) ? by.slice(FACT_PREFIX.length) : null)

// A COMPUTED key (see facts/computed.js) reads its source key's rows and derives
// the value in SQL — the same expression the fact predicate uses, so
// `{ by: 'fact:age', band: 5 }` and `{ fact: { age: { gte: 30 } } }` cannot
// disagree about how old anybody is.
function joinFact(db, q, key, now, alias = 'f') {
  const d = computed.derivedSql(key, { now })
  const valueSql = d ? `${d.sql} as value` : 'value'
  return q.joinRaw(
    `left join (
       select distinct on (passport_id) passport_id, ${valueSql}
         from whitebox_facts where key = ?
        order by passport_id, observed_at desc, id desc
     ) ${alias} on ${alias}.passport_id = e.passport_id`, [...(d ? d.binds : []), d ? d.from : key])
}

function base(db, joinSession) {
  let q = db(`${EXPOSURES} as e`)
  if (joinSession) q = q.leftJoin(`${SESSIONS} as s`, 's.id', 'e.session_id')
  return q
}

// Apply the shared event filters to a knex query (all exposure cols qualified `e.`).
// A bound date, or a named error. `new Date('last week')` is Invalid Date, and an
// Invalid Date in a WHERE silently matches NOTHING — an empty chart that looks
// like an honest zero.
function asDate(v, key) {
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) {
    throw new Error(`selector.metric: \`${key}\` is not a date — got ${JSON.stringify(v)} (use an ISO date like 2026-02-16)`)
  }
  return d
}

function applyFilters(db, q, { content, channel, direction, last, since, until, session, attrs }, { at, scope, now }) {
  if (scope?.length) q = whereScope(q, 'e.passport_id', scope)
  if (content && content !== '*') q = q.whereILike('e.content_id', `%${content}%`)   // DEPRECATED — do not extend
  if (channel) q = q.where('e.channel', channel)
  if (direction) q = q.where('e.direction', direction)
  if (at) q = q.where('e.ts', '<=', now)                                    // as-of: ignore the future
  if (last) q = q.where('e.ts', '>=', new Date(now.getTime() - windowMs(last)))   // lookback window

  // Absolute window, beside the relative one. `last: '30d'` answers "in the last
  // month" and moves with the clock; `since: '2026-02-16'` answers "since the
  // campaign launched" and does not. Both are lower bounds, so given together the
  // later one wins — which is what AND means and needs no special case.
  //
  // `since` used to be rejected as an unknown key, with the hint pointing at
  // `asOf`. That hint was wrong: `asOf` moves the whole query's clock backwards
  // (time travel — "what did this look like in March"), it does not bound a range
  // inside the present. There was no way to express a fixed-date window at all.
  if (since) q = q.where('e.ts', '>=', asDate(since, 'since'))
  if (until) q = q.where('e.ts', '<=', asDate(until, 'until'))

  // Session-joined typed dimensions (allowlisted column name, bound value).
  //
  // `{ present: true }` mirrors what `attrs` accepts below, and exists for the
  // grouped case rather than the gate. A `session:` breakdown puts everyone whose
  // session carries no UTM into a null bucket (§7), and on a site where most
  // traffic is direct that bucket is both the largest bar and the least
  // informative — it is "we don't know", drawn at the same weight as an answer.
  // Without this the only way to exclude it was to enumerate every source you did
  // want, which is a list that goes stale the first time a campaign adds one.
  //
  // The LEFT JOIN means a row with no session at all also has NULL here, so this
  // reads as "attributable traffic" — sessions we have, carrying a value.
  for (const [col, val] of Object.entries(session || {})) {
    const c = `s.${sessionCol(col)}`
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.present === true) q = q.whereNotNull(c)
      else if (val.present === false) q = q.whereNull(c)
      else if (Array.isArray(val.in)) q = q.whereIn(c, val.in)
      else throw new Error(`selector.metric: session "${col}" needs a value, { in: [...] }, or { present: true|false }`)
    } else q = Array.isArray(val) ? q.whereIn(c, val) : q.where(c, val)
  }

  // Open per-event dims in `meta` jsonb — key AND value are bind params (injection-safe).
  for (const [key, cond] of Object.entries(attrs || {})) {
    const lhs = db.raw('e.meta ->> ?', [key])
    if (Array.isArray(cond)) q = q.whereIn(lhs, cond.map(String))
    else if (cond && typeof cond === 'object') {
      if (cond.present === true) q = q.whereRaw('jsonb_exists(e.meta, ?)', [key])   // not `meta ? k` — `?` collides with knex binds
      else if (Array.isArray(cond.in)) q = q.whereIn(lhs, cond.in.map(String))
      else throw new Error(`selector.metric: attr "${key}" needs a value, { in: [...] }, or { present: true }`)
    } else q = q.where(lhs, String(cond))
  }
  return q
}

// ── the gate (filter.metric) — passports whose aggregate satisfies the bound ──
export async function evaluate(db, spec, { at, scope } = {}) {
  const { filters, agg, bounds } = split(spec, GATE_AGGS)
  const { field, gte, lte } = bounds
  const now = at ? new Date(at) : new Date()

  let q = applyFilters(db, base(db, needsSession(filters)), filters, { at, scope, now })
  q = q.groupBy('e.passport_id').select('e.passport_id as passport_id')

  if (agg === 'recency_days') {
    // recency = days since the most recent matching exposure, relative to `now`.
    if (gte != null) q = q.havingRaw('max(e.ts) <= ?', [new Date(now.getTime() - gte * MS.d)])  // gone quiet ≥ N days
    if (lte != null) q = q.havingRaw('max(e.ts) >= ?', [new Date(now.getTime() - lte * MS.d)])  // active within N days
  } else {
    if (agg === 'sum' && !field) throw new Error('selector.metric: `sum` needs a `field`')
    const expr = {
      count: 'count(*)',
      distinct_sessions: 'count(distinct e.session_id)',
      sum_dwell_ms: 'coalesce(sum(e.dwell_ms), 0)',
      sum: 'coalesce(sum((e.meta->>?)::numeric), 0)',   // sums meta.<field>; currency-naive (see spec)
    }[agg]
    const fp = agg === 'sum' ? [field] : []
    if (gte != null) q = q.havingRaw(`${expr} >= ?`, [...fp, gte])
    if (lte != null) q = q.havingRaw(`${expr} <= ?`, [...fp, lte])
  }

  return (await q).map(r => r.passport_id)
}

// ── the gate, with the moment it was passed (filter.metric → funnel anchor) ───
//
// evaluate() answers *whether* a passport's aggregate satisfies the bound. A
// funnel also needs *when*, because a windowed step measures from the previous
// step's matched_at (§14). Without it a metric step contributed `null`, and
// funnel.js skips any passport whose anchor is null — so every funnel entered
// on behaviour reported its second step as 0, identically for every window,
// which reads as "nobody converted" rather than "this cannot be computed".
//
// Membership is NOT recomputed here: evaluate() stays the single authority on
// who matches, and this only attaches times to the ids it returned. Scoping the
// window query to those ids also keeps it cheap.
//
// A crossing time only exists for a monotone lower bound. `gte` on count /
// sum_dwell_ms / distinct_sessions / non-negative sum rises and stays risen, so
// "the first row at which the running total reached it" is well defined. `lte`
// is satisfied at the start and lost later, and recency_days is measured from
// now rather than accumulated, so neither has one — those stay null and behave
// exactly as they do today.
// `anchors` — Map(passport_id → Date|ms), supplied by a funnel for step 2 and
// beyond. With it, the crossing is measured from that passport's own anchor
// instead of from the beginning of its history, and exposures at or before the
// anchor are not counted toward the bound at all.
//
// This is the difference between "has this person ever booked" and "did this
// person book AFTER the visit", and only the second is a funnel. Without it a
// repeat customer's crossing is their first booking years ago, which precedes
// the web session the funnel is measuring from, so funnel.js drops them on
// `ev > prior.anchor` — and a site-to-booking funnel reports the acquisition
// rate of brand-new customers while being read as a conversion rate.
//
// Membership still comes from evaluate(), unanchored. A passport whose only
// qualifying activity predates its anchor therefore appears in `ids` with a
// null time, and a windowed step drops it — the right answer, reached without
// a second membership query.
// One query, not two.
//
// This ran `evaluate()` for MEMBERSHIP and then a second anchored query for the
// crossing TIME. The two ask different questions and both are needed — membership
// ignores the anchor (an un-windowed funnel step keeps a passport that qualifies
// but has no post-anchor crossing, carrying its prior anchor forward), while the
// time counts only what came after it. That is why they were separate, and it is
// also why they can be one: both are aggregates over the SAME filtered rows, so
// the second pass re-read what the first had already touched.
//
// Two running sums over one scan do it: `running_all` over every row for the
// membership test, `running_post` over anchored rows only for the crossing. The
// three levels are forced, not stylistic — `inc` is itself a window expression
// for distinct_sessions, and Postgres will not nest a window inside a window in
// one SELECT, so inc, the running sums, and the aggregate each need their own.
export async function evaluateTimed(db, spec, { at, scope, anchors } = {}) {
  const { filters, agg, bounds } = split(spec, GATE_AGGS)
  const { field, gte } = bounds

  // No bound to cross, or a recency gate — there is no crossing time to compute,
  // so membership is the whole answer and the single query buys nothing.
  if (agg === 'recency_days' || gte == null) {
    const ids = await evaluate(db, spec, { at, scope })
    return new Map(ids.map(id => [id, null]))
  }

  const now = at ? new Date(at) : new Date()
  // Per-row increment. distinct_sessions counts a session once, at its first
  // exposure — a window function, hence the inner level: Postgres will not
  // nest one window expression inside another in the same SELECT.
  const inc = {
    count: db.raw('1'),
    sum_dwell_ms: db.raw('coalesce(e.dwell_ms, 0)'),
    sum: db.raw('coalesce((e.meta->>?)::numeric, 0)', [field]),
    distinct_sessions: db.raw(
      'case when row_number() over (partition by e.passport_id, e.session_id order by e.ts) = 1 then 1 else 0 end',
    ),
  }[agg]
  if (agg === 'sum' && !field) throw new Error('selector.metric: `sum` needs a `field`')

  // Anchored passports only, and only where the anchor is a real time. A funnel
  // step whose predecessor produced no clean time hands us null; that passport
  // still counts for MEMBERSHIP (its rows are all un-anchored below, so
  // running_post stays 0 and it gets no crossing) — which is what the windowed
  // step would have done with the null anyway.
  const anchored = anchors
    ? [...(anchors instanceof Map ? anchors : Object.entries(anchors))]
        .filter(([, at_]) => at_ != null)
        .map(([id, at_]) => [id, new Date(at_)])
    : []

  let inner = applyFilters(db, base(db, needsSession(filters)), filters, { at, scope, now })

  if (anchors) {
    // LEFT join, where the old two-pass code inner-joined. The anchor decides the
    // crossing, never membership: an inner join here would drop the un-anchored
    // from the result entirely, and an un-windowed step needs them kept.
    //
    // unnest over two parallel arrays rather than a VALUES literal: a funnel's
    // surviving cohort runs to tens of thousands, and that is a query text of
    // tens of thousands of tuples versus two bind parameters.
    inner = inner.joinRaw(
      'left join (select * from unnest(?::uuid[], ?::timestamptz[]) as t(passport_id, anchor)) a on a.passport_id = e.passport_id',
      [anchored.map(([id]) => id), anchored.map(([, at_]) => at_)],
    )
  }

  inner = inner.select(
    'e.passport_id as passport_id',
    'e.ts as ts',
    'e.session_id as session_id',
    inc.wrap('', ' as inc'),
    // Strictly after. An exposure AT the anchor is the thing that produced it —
    // counting it would let a step satisfy itself. Un-anchored ⇒ every row counts,
    // which is exactly the no-funnel case.
    anchors ? db.raw('(a.anchor is not null and e.ts > a.anchor) as post') : db.raw('true as post'),
  )

  const running = db.from(inner.as('i')).select(
    'passport_id',
    'ts',
    'post',
    'session_id',
    'inc',
    db.raw('sum(case when post then inc else 0 end) over (partition by passport_id order by ts rows between unbounded preceding and current row) as running_post'),
  )

  // MEMBERSHIP is `evaluate()`'s gate, expression for expression — not a running
  // total. The two are not the same for distinct_sessions: `count(distinct
  // session_id)` ignores NULLs, while `inc`'s row_number trick puts every
  // NULL-session row in ONE partition and counts it as a session. Gating on the
  // running total therefore admitted passports whose only "second session" was a
  // group of rows carrying no session at all — 663 where the old code returns 371.
  //
  // For the other aggregates sum(inc) is the same expression as evaluate's
  // (`inc` is 1, coalesce(dwell_ms,0), or the meta field), so they share one branch.
  const memberExpr = agg === 'distinct_sessions'
    ? db.raw('count(distinct session_id) >= ?', [gte])
    : db.raw('sum(inc) >= ?', [gte])

  // `having <evaluate's gate>` IS the old first pass, and `min(ts) filter (…)` IS
  // the old second pass — the same two answers, off one scan. The crossing still
  // uses the running total, unchanged, so a step's matched_at is what it always was.
  const rows = await db
    .from(running.as('r'))
    .groupBy('passport_id')
    .having(memberExpr)
    .select(
      'passport_id',
      db.raw('min(ts) filter (where post and running_post >= ?) as matched_at', [gte]),
    )

  return new Map(rows.map(r => [r.passport_id, r.matched_at ?? null]))
}

// ── the chart (group) — total aggregate bucketed by time grain or dimension ──
const TIME_FMT = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD', week: 'IYYY"-W"IW', month: 'YYYY-MM' }
const DIM_COL = { channel: 'e.channel', direction: 'e.direction', source: 'e.source', content: 'e.content_id' }

// "Which content do people consume" is a first-class question for pages, video,
// email and SMS, and it was not expressible: `content_url` was not a bucket at all,
// so asking for one returned an empty series in silence.
//
// It cannot be bucketed raw. On the GPoint data 134,678 distinct content_url values
// collapse to 449 once the query string goes — a 300x fragmentation, and 35% of rows
// carry one. The cause is click IDs, which are unique per click BY DESIGN: gclid has
// 76,836 distinct values, fbclid 38,685, wbraid 11,008. Every click invents its own
// bucket, so the top of a content chart is 134k rows of one.
//
// The query string is dropped entirely rather than filtered against a deny-list of
// tracking params: wbraid and gbraid are recent Google inventions, so any list of
// "the tracking ones" is a list that goes stale. Nothing analytical is lost — the
// utm_* values are already typed columns on whitebox_sessions, where
// `session:utm_campaign` buckets them properly, and they are merely duplicated in
// the URL.
//
// It is also the safer default for a reason that has nothing to do with charts:
// these URLs were carrying `payment_intent_client_secret` across 2,386 rows. A
// bucket key is a value that gets logged, cached, put in a chart label and shipped
// to an LLM for summarising; a Stripe secret should be in none of those places.
//
// The cost, stated: `city` (21,592 rows, 60 values) is a genuine page dimension and
// becomes unreachable this way. If it is wanted back, the shape is an allowlist of
// params to KEEP, sorted, appended to the path — not a deny-list.
// The '?' separator is BOUND, not inline. knex scans raw SQL for `?` to count
// placeholders and cannot tell a quoted literal from a placeholder, so
// `split_part(e.content_url, '?', 1)` reads as one extra bind and either dies or
// silently splits on the wrong thing. This exact trap has now appeared three times
// in this file: a regex quantifier, the clock in `months`, and here.
const CONTENT_URL_CANON = { sql: 'split_part(e.content_url, ?, 1)', binds: ['?'] }

// A bucket → { sql, binds }. Time grains (to_char of ts) and exposure/session
// columns carry no binds (allowlisted names); `attr:<key>` binds the key.
//   "day" | "channel" | "session:utm_campaign" | "attr:event"
function bucketSql(by, band, factIsComputed = false) {
  if (TIME_FMT[by]) return { sql: `to_char(e.ts, '${TIME_FMT[by]}')`, binds: [] }
  if (DIM_COL[by]) return { sql: DIM_COL[by], binds: [] }            // `content` here is DEPRECATED (opaque id)
  if (typeof by === 'string' && by.startsWith('session:')) return { sql: `s.${sessionCol(by.slice(8))}`, binds: [] }
  if (typeof by === 'string' && by.startsWith('attr:')) return { sql: 'e.meta ->> ?', binds: [by.slice(5)] }
  // content_url is canonicalised (query stripped); content_hash and content_id are
  // opaque identifiers already and pass through as they are.
  if (by === 'content_url') return { ...CONTENT_URL_CANON }
  if (by === 'content_hash') return { sql: 'e.content_hash', binds: [] }
  if (factKeyOf(by) != null) {
    // BANDED, for a numeric fact: `{ by: 'fact:age', band: 5 }` gives 20-24, 25-29…
    // A per-year age breakdown is ninety buckets and answers nothing; the bands are
    // the question. Labelled as a RANGE rather than the floor, because a bucket
    // reading "40" beside one reading "45" invites being read as an exact age.
    //
    // Non-numeric values band to null rather than erroring: a key is not guaranteed
    // to hold numbers on every row, and one bad row should not empty the chart.
    if (band != null) {
      const n = Number(band)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`selector.group: \`band\` must be a positive number, got ${JSON.stringify(band)}`)
      // The numeric-looking test is a BOUND pattern, not a literal. knex scans raw
      // SQL for `?` to count bindings and does not know a quotedstring from an
      // operator, so `'^-?[0-9]+(\.[0-9]+)?$'` inline reads as two extra
      // placeholders and the query dies with "Expected 5 bindings, saw 7".
      const NUMERIC = '^-?[0-9]+(\\.[0-9]+)?$'
      // A STORED value is jsonb, so `#>> '{}'` unwraps the scalar; a DERIVED one is
      // already numeric. Using `::text` for both would render a stored string as
      // `"pro"`, quotes included, and a stored number as text that still parses —
      // so the bug would show up only on the string buckets.
      const col = factIsComputed ? 'f.value::text' : `f.value #>> '{}'`
      const num = `nullif(${col}, '')::numeric`
      return {
        sql: `case when (${col}) ~ ?
                   then (floor(${num} / ?) * ?)::bigint || '-' || (floor(${num} / ?) * ? + ? - 1)::bigint
              end`,
        binds: [NUMERIC, n, n, n, n, n],
      }
    }
    return { sql: factIsComputed ? 'f.value::text' : `f.value #>> '{}'`, binds: [] }
  }
  throw new Error(`selector.group: unknown bucket "${by}" (time: ${Object.keys(TIME_FMT).join('/')}; column: ${Object.keys(DIM_COL).join('/')}/content_url/content_hash; session:<utm…>; attr:<key>; fact:<key>)`)
}

// Where an aggregate reads its number from: a meta attribute (`field`) or an
// exposure column (`column`). Returns { sql, binds } for a NUMERIC expression.
//
// Rows where the source is absent or non-numeric contribute NOTHING rather than a
// zero — `avg` over "the events that carry a value" is the only reading that is not
// a lie, since counting a missing value as 0 drags the mean toward zero in
// proportion to how much data you are missing. Postgres's aggregates skip NULL,
// which is exactly the behaviour wanted, so the cast is guarded rather than
// coalesced.
function numericSource({ field, column, fact }, agg) {
  const given = [field && 'field', column && 'column', fact && 'fact'].filter(Boolean)
  if (given.length > 1) throw new Error(`selector.group: \`${agg}\` takes one of \`field\`/\`column\`/\`fact\`, not ${given.join(' + ')}`)
  // A fact source is aggregated in the OUTER level of a two-level query (see group),
  // where the per-passport dedup has already happened — by then the value is a plain
  // column on the subquery.
  if (fact) return { sql: 'v', binds: [] }
  if (field && column) throw new Error(`selector.group: \`${agg}\` takes either \`field\` (a meta attribute) or \`column\`, not both`)
  if (column) {
    if (!AGG_COLS.includes(column)) {
      throw new Error(`selector.group: \`column\` must be one of ${AGG_COLS.join('/')} — got "${column}"`)
    }
    return { sql: `e.${column}`, binds: [] }
  }
  if (!field) {
    throw new Error(`selector.group: \`${agg}\` needs a \`field\` (a meta attribute), a \`column\` (${AGG_COLS.join('/')}), or a \`fact\` (a fact key)`)
  }
  // NULL unless the text is entirely numeric — a stray "n/a" in one event must not
  // abort the whole query with an invalid-input-syntax error.
  return { sql: `case when (e.meta->>?) ~ ? then (e.meta->>?)::numeric end`, binds: [field, NUMERIC_TEXT, field] }
}

const NUMERIC_TEXT = '^-?[0-9]+(\\.[0-9]+)?$'

function aggSql(agg, bounds = {}) {
  const { field, column, p } = bounds
  switch (agg) {
    case 'count': return { sql: 'count(*)', bindings: [] }
    case 'distinct_sessions': return { sql: 'count(distinct e.session_id)', bindings: [] }
    case 'distinct_passports': return { sql: 'count(distinct e.passport_id)', bindings: [] }
    case 'sum_dwell_ms': return { sql: 'coalesce(sum(e.dwell_ms), 0)', bindings: [] }
    case 'sum': {
      const src = numericSource({ field, column, fact: bounds.fact }, 'sum')
      return { sql: `coalesce(sum(${src.sql}), 0)`, bindings: src.binds }
    }
    // avg/min/max are NOT coalesced to 0: a bucket where nothing carried the field
    // has no average, and reporting 0 would put it on the chart as a real low value
    // rather than an absent one. It comes back null and the caller can say so.
    case 'avg': case 'min': case 'max': {
      const src = numericSource({ field, column, fact: bounds.fact }, agg)
      return { sql: `${agg}(${src.sql})`, bindings: src.binds }
    }
    case 'median': case 'percentile': {
      const src = numericSource({ field, column, fact: bounds.fact }, agg)
      const frac = agg === 'median' ? 0.5 : Number(p)
      if (!(frac >= 0 && frac <= 1)) {
        throw new Error(`selector.group: \`percentile\` needs \`p\` between 0 and 1 (0.9 = the 90th) — got ${JSON.stringify(p)}`)
      }
      // percentile_cont is an ORDERED-SET aggregate, hence WITHIN GROUP; it
      // interpolates between neighbours, which is what a percentile of a continuous
      // measure means. It cannot be composed with the running-total path the gate
      // uses, which is why these are group-only.
      return { sql: `percentile_cont(?) within group (order by ${src.sql})`, bindings: [frac, ...src.binds] }
    }
    // Postgres has no first()/last() aggregate. array_agg with an explicit ORDER BY
    // is the standard substitute and, unlike min()/max(), answers "the value at the
    // earliest event" rather than "the smallest value" — a distinction that matters
    // for anything non-monotonic, which is most measures.
    // NAMED `earliest`/`latest`, not first/last: `last` is already the relative
    // lookback window in FILTER_KEYS, so `{ last: { field } }` parses as a window and
    // then reports "needs one aggregate" — a confusing error for a reasonable spec.
    // One word cannot be both, and the window came first.
    case 'earliest': case 'latest': {
      if (bounds.fact) {
        // A fact is current-value-per-passport: there is exactly one, so "the value at
        // the earliest event" is not a question about it. Its own history has the
        // temporal operators (facts/operators.js) if that is what is wanted.
        throw new Error(`selector.group: \`${agg}\` orders by event time, so it needs a \`field\` or \`column\` — a \`fact\` has one current value per passport`)
      }
      const src = numericSource({ field, column }, agg)
      const dir = agg === 'earliest' ? 'asc' : 'desc'
      return { sql: `(array_agg(${src.sql} order by e.ts ${dir}))[1]`, bindings: src.binds }
    }
    default: throw new Error(`selector.group: aggregate "${agg}" not supported for grouping (one of ${GROUP_AGGS.join('/')})`)
  }
}

// group(db, spec, { by, at, scope, limit }) → [{ bucket, value }].
// Default: ordered by bucket (chronological for time grains). `limit` is the
// HIGH-CARDINALITY GUARDRAIL — an open key (attr:<key>, session:<utm>) can have
// thousands of buckets, so `limit` returns the top-N by value (desc) instead.
export async function group(db, spec, { by, at, scope, limit, band } = {}) {
  if (!by) throw new Error('selector.group: needs `by` (a time grain, column, session:<utm>, attr:<key>, or fact:<key>)')
  const { filters, agg, bounds } = split(spec, GROUP_AGGS)
  const now = at ? new Date(at) : new Date()
  const factKey = factKeyOf(by)
  if (band != null && factKey == null) {
    throw new Error('selector.group: `band` only applies to a `fact:<key>` bucket (it bands a numeric fact into ranges)')
  }
  const bucket = bucketSql(by, band, factKey != null && computed.isComputed(factKey))
  const value = aggSql(agg, bounds)

  // ── aggregating a FACT: two levels, because a fact is PER PERSON ──────────────
  //
  // `avg: { fact: 'ltv_paid' }` cannot be one GROUP BY over the exposure stream.
  // Exposures are many-per-passport, so averaging the joined fact weights every
  // customer by how many events they have: someone with 40 visits counts 40 times in
  // their own average, and the result is an event-weighted mean masquerading as a
  // per-customer one. On the GPoint data that is the difference between "the average
  // customer's lifetime value" and "the lifetime value of the average VISIT", which
  // are not close.
  //
  // So the inner level reduces to one row per (passport, bucket) and the outer level
  // aggregates that. A passport legitimately appears in several buckets — active in
  // three months, they contribute their value to each of the three — but exactly once
  // per bucket, which is the reading anybody asking for "avg by month" means.
  if (bounds.fact) {
    let inner = base(db, needsSession(filters, by))
    if (factKey != null) inner = joinFact(db, inner, factKey, now)          // the BUCKET fact
    inner = joinFact(db, inner, bounds.fact, now, 'af')                     // the AGGREGATED fact
    const afCol = computed.isComputed(bounds.fact) ? 'af.value::text' : `af.value #>> '{}'`
    inner = applyFilters(db, inner, filters, { at, scope, now }).distinct(
      'e.passport_id',
      db.raw(`${bucket.sql} as bucket`, bucket.binds),
      // Guarded, not coalesced: a non-numeric fact value contributes nothing rather
      // than a zero, the same rule the event-attribute aggregates follow.
      db.raw(`case when (${afCol}) ~ ? then (${afCol})::numeric end as v`, [NUMERIC_TEXT]),
    )

    let outer = db.from(inner.as('d'))
      .select('bucket', db.raw(`${value.sql} as value`, value.bindings))
      .groupBy('bucket')
    outer = (limit != null) ? outer.orderByRaw('2 desc nulls last').limit(limit) : outer.orderBy('bucket')
    return (await outer).map(r => ({ bucket: r.bucket, value: r.value == null ? null : Number(r.value) }))
  }

  let q = base(db, needsSession(filters, by))
  if (factKey != null) q = joinFact(db, q, factKey, now)
  q = applyFilters(db, q, filters, { at, scope, now })
    .select(db.raw(`${bucket.sql} as bucket`, bucket.binds), db.raw(`${value.sql} as value`, value.bindings))
    .groupByRaw('1')                                          // group by the bucket (output position)
  q = (limit != null)
    ? q.orderByRaw('2 desc').limit(limit)                     // top-N by value (the guardrail)
    : q.orderByRaw('1')                                       // by bucket (chronological for time grains)

  // `value: null` is preserved deliberately. Number(null) is 0, and an avg/median of
  // a bucket where nothing carried the field would then plot as a real zero — the
  // same class of confident-wrong-number this engine keeps being bitten by.
  return (await q).map(r => ({ bucket: r.bucket, value: r.value == null ? null : Number(r.value) }))
}
