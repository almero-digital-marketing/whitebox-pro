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

const EXPOSURES = 'whitebox_awareness_exposures'
const SESSIONS = 'whitebox_sessions'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'channel', 'direction', 'last', 'session', 'attrs']
const GATE_AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
const GROUP_AGGS = ['count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum']

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

function base(db, joinSession) {
  let q = db(`${EXPOSURES} as e`)
  if (joinSession) q = q.leftJoin(`${SESSIONS} as s`, 's.id', 'e.session_id')
  return q
}

// Apply the shared event filters to a knex query (all exposure cols qualified `e.`).
function applyFilters(db, q, { content, channel, direction, last, session, attrs }, { at, scope, now }) {
  if (scope?.length) q = q.whereIn('e.passport_id', scope)
  if (content && content !== '*') q = q.whereILike('e.content_id', `%${content}%`)   // DEPRECATED — do not extend
  if (channel) q = q.where('e.channel', channel)
  if (direction) q = q.where('e.direction', direction)
  if (at) q = q.where('e.ts', '<=', now)                                    // as-of: ignore the future
  if (last) q = q.where('e.ts', '>=', new Date(now.getTime() - windowMs(last)))   // lookback window

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
export async function evaluateTimed(db, spec, { at, scope } = {}) {
  const ids = await evaluate(db, spec, { at, scope })
  if (!ids.length) return new Map()

  const { filters, agg, bounds } = split(spec, GATE_AGGS)
  const { field, gte } = bounds
  if (agg === 'recency_days' || gte == null) return new Map(ids.map(id => [id, null]))

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

  const inner = applyFilters(db, base(db, needsSession(filters)), filters, { at, scope: ids, now })
    .select('e.passport_id as passport_id', 'e.ts as ts', inc.wrap('', ' as inc'))

  const rows = await db
    .from(
      db.from(inner.as('i'))
        .select(
          'passport_id',
          'ts',
          db.raw('sum(inc) over (partition by passport_id order by ts rows between unbounded preceding and current row) as running'),
        )
        .as('r'),
    )
    .where('running', '>=', gte)
    .groupBy('passport_id')
    .select('passport_id', db.raw('min(ts) as matched_at'))

  const times = new Map(rows.map(r => [r.passport_id, r.matched_at]))
  return new Map(ids.map(id => [id, times.get(id) ?? null]))
}

// ── the chart (group) — total aggregate bucketed by time grain or dimension ──
const TIME_FMT = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD', week: 'IYYY"-W"IW', month: 'YYYY-MM' }
const DIM_COL = { channel: 'e.channel', direction: 'e.direction', source: 'e.source', content: 'e.content_id' }

// A bucket → { sql, binds }. Time grains (to_char of ts) and exposure/session
// columns carry no binds (allowlisted names); `attr:<key>` binds the key.
//   "day" | "channel" | "session:utm_campaign" | "attr:event"
function bucketSql(by) {
  if (TIME_FMT[by]) return { sql: `to_char(e.ts, '${TIME_FMT[by]}')`, binds: [] }
  if (DIM_COL[by]) return { sql: DIM_COL[by], binds: [] }            // `content` here is DEPRECATED (opaque id)
  if (typeof by === 'string' && by.startsWith('session:')) return { sql: `s.${sessionCol(by.slice(8))}`, binds: [] }
  if (typeof by === 'string' && by.startsWith('attr:')) return { sql: 'e.meta ->> ?', binds: [by.slice(5)] }
  throw new Error(`selector.group: unknown bucket "${by}" (time: ${Object.keys(TIME_FMT).join('/')}; column: ${Object.keys(DIM_COL).join('/')}; session:<utm…>; attr:<key>)`)
}

function aggSql(agg, field) {
  switch (agg) {
    case 'count': return { sql: 'count(*)', bindings: [] }
    case 'distinct_sessions': return { sql: 'count(distinct e.session_id)', bindings: [] }
    case 'distinct_passports': return { sql: 'count(distinct e.passport_id)', bindings: [] }
    case 'sum_dwell_ms': return { sql: 'coalesce(sum(e.dwell_ms), 0)', bindings: [] }
    case 'sum':
      if (!field) throw new Error('selector.group: `sum` needs a `field`')
      return { sql: 'coalesce(sum((e.meta->>?)::numeric), 0)', bindings: [field] }
    default: throw new Error(`selector.group: aggregate "${agg}" not supported for grouping`)
  }
}

// group(db, spec, { by, at, scope, limit }) → [{ bucket, value }].
// Default: ordered by bucket (chronological for time grains). `limit` is the
// HIGH-CARDINALITY GUARDRAIL — an open key (attr:<key>, session:<utm>) can have
// thousands of buckets, so `limit` returns the top-N by value (desc) instead.
export async function group(db, spec, { by, at, scope, limit } = {}) {
  if (!by) throw new Error('selector.group: needs `by` (a time grain, column, session:<utm>, or attr:<key>)')
  const { filters, agg, bounds } = split(spec, GROUP_AGGS)
  const now = at ? new Date(at) : new Date()
  const bucket = bucketSql(by)
  const value = aggSql(agg, bounds.field)

  let q = applyFilters(db, base(db, needsSession(filters, by)), filters, { at, scope, now })
    .select(db.raw(`${bucket.sql} as bucket`, bucket.binds), db.raw(`${value.sql} as value`, value.bindings))
    .groupByRaw('1')                                          // group by the bucket (output position)
  q = (limit != null)
    ? q.orderByRaw('2 desc').limit(limit)                     // top-N by value (the guardrail)
    : q.orderByRaw('1')                                       // by bucket (chronological for time grains)

  return (await q).map(r => ({ bucket: r.bucket, value: Number(r.value) }))
}
