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
import { useFor as declaredUseFor } from '../facts/index.js'

const EXPOSURES = 'whitebox_awareness_exposures'
const SESSIONS = 'whitebox_sessions'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'source', 'channel', 'direction', 'last', 'since', 'until', 'window', 'session', 'attrs']
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
// Ordering for a non-`last` rule, kept identical to facts/store.js's USE_ORDER — the
// bucket, the aggregate and the fact PREDICATE have to agree about which of a
// passport's values they are talking about, or one query contradicts another about the
// same customer.
const USE_SQL = {
  first: 'observed_at asc, id asc',
  max: 'value desc, observed_at desc, id desc',
  min: 'value asc, observed_at asc, id asc',
}
// `last` has no entry because it needs no sort — it is the row the projection holds.
const USE_RULES = ['last', ...Object.keys(USE_SQL)]

/**
 * Join a passport's value for `key` as `<alias>.value`.
 *
 * `use` says WHICH value when a passport holds several — defaulting to whatever the
 * deployment declared for the key, then to `last`. Without this, `avg: { fact: 'ltv' }`
 * and `group.by: 'fact:first_booked_at'` silently took the latest write while a filter
 * on the same key honoured its declaration: two halves of one query disagreeing about
 * the same person.
 *
 * `last` reads the projection, which holds exactly that row — one per (passport_id,
 * key), no sort. Any other rule has to read the log, because the projection physically
 * does not contain the row being asked for.
 */
function joinFact(db, q, key, now, alias = 'f', use = undefined) {
  const d = computed.derivedSql(key, { now })
  const valueSql = d ? `${d.sql} as value` : 'value'
  const rule = use ?? declaredUseFor(key) ?? 'last'
  // Checked, not just looked up: anything absent from USE_SQL would otherwise fall
  // through to the projection and be answered as `last` — a misspelled rule silently
  // returning a confident number for a different question.
  if (rule !== 'last' && !USE_SQL[rule]) {
    throw new Error(`selector.group: \`use\` must be one of ${USE_RULES.join('/')} — got "${rule}"`)
  }
  const inner = USE_SQL[rule]
    ? `select distinct on (passport_id) passport_id, ${valueSql}
         from whitebox_facts where key = ?
        order by passport_id, ${USE_SQL[rule]}`
    : `select passport_id, ${valueSql} from whitebox_facts_current where key = ?`
  return q.joinRaw(
    `left join (${inner}) ${alias} on ${alias}.passport_id = e.passport_id`,
    [...(d ? d.binds : []), d ? d.from : key])
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

// An exposure column that is a low-cardinality label: one value, or a list. A list
// is `in`, which is what a caller means by ["video","page"] and previously threw.
function whereLabel(q, col, val) {
  if (val == null) return q
  if (Array.isArray(val)) return q.whereIn(col, val)
  if (typeof val === 'object') {
    if (Array.isArray(val.in)) return q.whereIn(col, val.in)
    if (val.present === true) return q.whereNotNull(col)
    if (val.present === false) return q.whereNull(col)
    throw new Error(`selector.metric: ${col.replace('e.', '')} needs a value, { in: [...] }, or { present: true|false }`)
  }
  return q.where(col, val)
}

// WHICH CONTENT, by identity rather than by guesswork.
//
// There was no predicate on content at all. For video the only handles were
// `attrs` (completion_pct, duration_s, muted — measurements OF the asset, none of
// which name it) and `about` semantic similarity, which is fuzzy and only as good
// as the transcript. So "was this person exposed to THIS video" was inexpressible,
// and the class question "…to video at all" was too, because `source` was not
// filterable either — `channel: 'web'` lumps video in with page views and text.
//
//   content: { url: { in: [...] } }        exact urls
//   content: { url: { prefix: '…/faq/' } } a folder / campaign of assets
//   content: { id: 'welcome-1' }           the emitter's own id
//   content: { hash: '…' }                 the same TEXT, wherever it appeared
//
// The url is canonicalised on BOTH sides — the stored value and the argument —
// with the same expression the `content_url` bucket uses. Otherwise a filter and a
// breakdown could disagree about one page: `?utm_source=…` made every share of a
// link a different string, so a filter written from a real address would silently
// miss most of its own traffic.
function applyContent(db, q, content) {
  if (typeof content === 'string') {
    // DEPRECATED substring form — do not extend. Kept resolving for callers that
    // still pass it (docs/event-attributes.md §4/§7).
    return content === '*' ? q : q.whereILike('e.content_id', `%${content}%`)
  }
  const { url, id, hash, prefix, ...rest } = content
  const unknown = Object.keys(rest)
  if (unknown.length) {
    throw new Error(`selector.metric: content has no "${unknown[0]}" (use url/id/hash/prefix). Measurements like completion_pct are \`attrs\`, not content.`)
  }
  if (prefix != null) q = q.whereRaw(`${CONTENT_URL_CANON.sql} like ?`, [...CONTENT_URL_CANON.binds, `${canonUrl(prefix)}%`])
  if (url != null) {
    if (typeof url === 'object' && !Array.isArray(url)) {
      if (url.prefix != null) q = q.whereRaw(`${CONTENT_URL_CANON.sql} like ?`, [...CONTENT_URL_CANON.binds, `${canonUrl(url.prefix)}%`])
      else if (Array.isArray(url.in)) q = q.whereRaw(`${CONTENT_URL_CANON.sql} = any(?)`, [...CONTENT_URL_CANON.binds, url.in.map(canonUrl)])
      else if (url.present === true) q = q.whereNotNull('e.content_url')
      else if (url.present === false) q = q.whereNull('e.content_url')
      else throw new Error('selector.metric: content.url needs a url, { in: [...] }, { prefix: … }, or { present: true|false }')
    } else if (Array.isArray(url)) {
      q = q.whereRaw(`${CONTENT_URL_CANON.sql} = any(?)`, [...CONTENT_URL_CANON.binds, url.map(canonUrl)])
    } else {
      q = q.whereRaw(`${CONTENT_URL_CANON.sql} = ?`, [...CONTENT_URL_CANON.binds, canonUrl(url)])
    }
  }
  if (id != null) q = whereLabel(q, 'e.content_id', id)
  if (hash != null) q = whereLabel(q, 'e.content_hash', hash)
  return q
}

// The argument canonicalised the way the stored column is, so both sides of the
// comparison mean the same thing.
const canonUrl = (u) => String(u).split('?')[0].split('#')[0]

// ── fact-anchored windows: a PER-PASSPORT time bound ─────────────────────────
//
// `since`/`until` take one date for everybody and `asOf` moves the whole query's
// clock. Neither can express "before THIS person's first booking", where the
// boundary is a different instant for every passport.
//
// A funnel already orders events per passport, but it answers with the surviving
// COHORT — it cannot hand back the subset of EXPOSURES that fall before the
// anchor as something groupable. So "which videos do people watch before they
// book" had no expression at all: you could get who booked, never what they
// watched first.
//
//   window: { before: { fact: 'first_booked_at' } }
//   window: { after:  { fact: 'churned_at' }, within: '7d' }     the week after
//   window: { before: { fact: 'churned_at' }, within: '7d' }     the week before
//   window: { between: [{ fact: 'signed_up_at' }, { fact: 'first_booked_at' }] }
//
// SEMANTICS, stated rather than left to the reader:
//   · The anchor is the fact's VALUE cast to a timestamp — not observed_at. When
//     the CRM backfills a booking made in March, the anchor is March, not the
//     night the row was written.
//   · `before` is STRICT (<) and `after` is INCLUSIVE (>=), so the two are an
//     exact partition of the same population: every exposure lands in one, none
//     in both, and the two counts sum to the unwindowed total.
//   · Comparison is in UTC, on timestamptz. A date-only fact value ('2026-08-07')
//     is midnight UTC.
//   · `use` picks among a fact's history: 'last' (default — the fact's CURRENT
//     value, the same rule every other fact read uses), 'first', 'min', 'max'.
//     For an "…_at" milestone that got corrected, 'min' is the earliest date ever
//     claimed and 'last' is the one the CRM currently stands behind.
const ANCHOR_USE = ['last', 'first', 'min', 'max']
// What to do with passports whose anchor fact is not set. `exclude` drops them
// (SQL's own answer to comparing against null); `only` returns just them; `include`
// treats "no anchor" as "no boundary"; `bucket` keeps them AND labels them, so one
// grouped call returns both cohorts.
//
// This matters more than a default usually does. "What do converters watch that
// non-converters don't" needs both sides, and the no-anchor side is usually the
// bigger one — on live data 494 of 911 video watchers have never booked. Dropping
// them silently answers a narrower question than the one asked.
const MISSING = ['exclude', 'include', 'only', 'bucket']
const NO_ANCHOR_BUCKET = '__no_anchor__'
const WINDOW_KEYS = ['before', 'after', 'between', 'offset', 'within', 'missingAnchor']

function anchorSql(db, spec, alias) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`selector.metric: window anchor must be { fact: '<key>' } — got ${JSON.stringify(spec)}`)
  }
  // Same precedence as a fact clause: the anchor's own `use` beats the key's
  // declaration, which beats 'last'. Without this a declared `first_booked_at: min`
  // would be honoured by every filter and silently ignored by the window that anchors
  // on it — the two disagreeing about the same key is the failure this exists to stop.
  const { fact, use = (declaredUseFor(spec?.fact) ?? 'last'), ...rest } = spec
  if (!fact || typeof fact !== 'string') throw new Error('selector.metric: window anchor needs `fact` (the key whose VALUE is the boundary)')
  if (Object.keys(rest).length) throw new Error(`selector.metric: window anchor has no "${Object.keys(rest)[0]}" (use fact/use)`)
  if (!ANCHOR_USE.includes(use)) throw new Error(`selector.metric: window anchor \`use\` must be one of ${ANCHOR_USE.join('/')} — got "${use}"`)
  if (computed.isComputed(fact)) {
    // A computed fact derives a NUMBER (age in years, days since a visit), not an
    // instant, so it cannot be a boundary. Naming its source is what was meant.
    throw new Error(`selector.metric: "${fact}" is a computed fact (a number), so it cannot anchor a window — use the stored date it derives from`)
  }
  // Same cast as facts/computed.js: `nullif` so an empty value is NULL rather than
  // an error that takes the whole query down.
  const VAL = `nullif(value #>> '{}', '')::timestamptz`
  // `last` is the CURRENT value, so it comes from the projection — one row per
  // passport, no sort over the key partition. `first`/`min`/`max` are questions about
  // the HISTORY and can only be answered from the log, which is the whole reason the
  // projection is a projection and not a replacement.
  const inner = (use === 'last')
    ? `select passport_id, ${VAL} as anchor from whitebox_facts_current where key = ?`
    : (use === 'min' || use === 'max')
      ? `select passport_id, ${use}(${VAL}) as anchor from whitebox_facts where key = ? group by passport_id`
      : `select distinct on (passport_id) passport_id, ${VAL} as anchor
           from whitebox_facts where key = ?
          order by passport_id, observed_at asc, id asc`
  return { sql: `left join (${inner}) ${alias} on ${alias}.passport_id = e.passport_id`, binds: [fact] }
}

// Seconds, signed — an offset may point either way ('-7d' moves the boundary a
// week earlier). Bound as a number into make_interval, never interpolated.
function offsetSecs(v, key) {
  if (v == null) return 0
  const m = /^(-?\d+)\s*(h|d|w)$/.exec(String(v).trim())
  if (!m) throw new Error(`selector.metric: bad \`${key}\` "${v}" (use 7d, -7d, 24h, 2w)`)
  return Number(m[1]) * MS[m[2]] / 1000
}

function applyWindow(db, q, win, now) {
  if (typeof win !== 'object' || Array.isArray(win)) throw new Error('selector.metric: `window` must be an object')
  const unknown = Object.keys(win).filter(k => !WINDOW_KEYS.includes(k))
  if (unknown.length) throw new Error(`selector.metric: window has no "${unknown[0]}" (use ${WINDOW_KEYS.join('/')})`)

  const { before, after, between, offset, within, missingAnchor = 'exclude' } = win
  const missing = missingAnchor
  if (!MISSING.includes(missing)) {
    throw new Error(
      `selector.metric: window \`missingAnchor\` must be one of ${MISSING.join('/')} — got "${missing}". ` +
      `"exclude" drops passports whose anchor fact is not set, "only" returns just them ` +
      `(the never-reached-the-milestone comparison group), "include" treats no anchor as no ` +
      `boundary, and "bucket" keeps them in their own "${NO_ANCHOR_BUCKET}" bucket so one ` +
      `grouped call returns both cohorts.`)
  }
  const given = ['before', 'after', 'between'].filter(k => win[k] != null)
  if (given.length !== 1) {
    throw new Error(`selector.metric: window takes exactly one of before/after/between — got ${given.length ? given.join(' + ') : 'none'}`)
  }
  if (within != null && between != null) {
    throw new Error('selector.metric: `within` bounds the far side of a before/after window; `between` already has two bounds')
  }

  const off = offsetSecs(offset, 'offset')
  const span = within == null ? null : offsetSecs(within, 'within')
  if (span != null && span < 0) throw new Error(`selector.metric: \`within\` must be positive — it is a distance from the anchor, and the direction comes from before/after`)

  // Composed as {sql, binds} rather than knex raws: `raw.toString()` INLINES its
  // bindings, so nesting raws to build a compound predicate would interpolate a
  // caller value into SQL text and reformat timestamps on the way through. Every
  // value below stays a bind.
  const bound = (alias, secs) => secs
    ? { sql: `${alias}.anchor + make_interval(secs => ?)`, binds: [secs] }
    : { sql: `${alias}.anchor`, binds: [] }
  const cmp = (op, alias, secs) => {
    const b = bound(alias, secs)
    return { sql: `e.ts ${op} ${b.sql}`, binds: b.binds }
  }
  const and = (parts) => ({
    sql: parts.map(p => p.sql).join(' and '),
    binds: parts.flatMap(p => p.binds),
  })
  const orNull = (nullSql, inner) => ({ sql: `(${nullSql} or (${inner.sql}))`, binds: inner.binds })

  if (between) {
    if (!Array.isArray(between) || between.length !== 2) {
      throw new Error('selector.metric: window `between` takes exactly two anchors: [{ fact: … }, { fact: … }]')
    }
    const a = anchorSql(db, between[0], 'awa')
    const b = anchorSql(db, between[1], 'awb')
    q = q.joinRaw(a.sql, a.binds).joinRaw(b.sql, b.binds)
    const missingSql = 'awa.anchor is null or awb.anchor is null'
    if (missing === 'only') return q.whereRaw(`(${missingSql})`)
    const pred = and([cmp('>=', 'awa', off), cmp('<', 'awb', off)])
    if (missing === 'include') {
      const w = orNull(missingSql, pred)
      return q.whereRaw(w.sql, w.binds)
    }
    q = q.whereNotNull('awa.anchor').whereNotNull('awb.anchor')
    return q.whereRaw(pred.sql, pred.binds)
  }

  const a = anchorSql(db, before ?? after, 'aw')
  q = q.joinRaw(a.sql, a.binds)
  if (missing === 'only') {
    // The comparison group, addressable rather than dropped: the people who never
    // reached the milestone at all. In the case this was built for, 486 of 894
    // video watchers had never booked — they are most of the population, and the
    // baseline that makes "watched before booking" mean anything.
    return q.whereNull('aw.anchor')
  }

  // `before` STRICT, `after` INCLUSIVE — an exact partition (see the note above).
  const pred = and(before
    ? [cmp('<', 'aw', off), ...(span == null ? [] : [cmp('>=', 'aw', off - span)])]
    : [cmp('>=', 'aw', off), ...(span == null ? [] : [cmp('<', 'aw', off + span)])])

  if (missing === 'include' || missing === 'bucket') {
    // Same rows either way — no anchor means no boundary to be on the wrong side
    // of, so everything they did qualifies. The two differ only in LABELLING, which
    // group() applies to the bucket expression (see noAnchorBucket below): `include`
    // merges them into the ordinary buckets, `bucket` keeps them separable.
    const w = orNull('aw.anchor is null', pred)
    return q.whereRaw(w.sql, w.binds)
  }
  return q.whereNotNull('aw.anchor').whereRaw(pred.sql, pred.binds)
}

function applyFilters(db, q, { content, source, channel, direction, last, since, until, window: win, session, attrs }, { at, scope, now }) {
  if (scope?.length) q = whereScope(q, 'e.passport_id', scope)
  if (content != null && content !== '') q = applyContent(db, q, content)
  q = whereLabel(q, 'e.source', source)
  if (channel) q = whereLabel(q, 'e.channel', channel)
  if (direction) q = whereLabel(q, 'e.direction', direction)
  if (win) q = applyWindow(db, q, win, now)
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
// Both separators, in the same order ingest cuts them (awareness/pii.js), so the
// read side and the write side agree — and so `canonUrl()` in JS, which strips
// query AND fragment, cannot disagree with the SQL about the same address. When
// only `?` was stripped here, `page#t=30` and `page` were different buckets and a
// filter written from a real url matched one of them.
const CONTENT_URL_CANON = { sql: 'split_part(split_part(e.content_url, ?, 1), ?, 1)', binds: ['?', '#'] }

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
function numericSource({ field, column, fact, use }, agg) {
  if (use != null && !fact) {
    throw new Error(
      `selector.group: \`${agg}.use\` picks WHICH of a passport's fact values to aggregate, ` +
      `so it only applies with \`fact\` — got \`${field ? 'field' : column ? 'column' : 'no source'}\`. ` +
      `An event attribute has one value per event; there is nothing to choose between.`)
  }
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
  // `use` is forwarded to every numericSource call, not just the fact ones: its only
  // job there is to REFUSE `use` on a source that has no values to choose between, and
  // a guard that is skipped on exactly the specs it exists to catch is not a guard.
  const { field, column, p, use } = bounds
  switch (agg) {
    case 'count': return { sql: 'count(*)', bindings: [] }
    case 'distinct_sessions': return { sql: 'count(distinct e.session_id)', bindings: [] }
    case 'distinct_passports': return { sql: 'count(distinct e.passport_id)', bindings: [] }
    case 'sum_dwell_ms': return { sql: 'coalesce(sum(e.dwell_ms), 0)', bindings: [] }
    case 'sum': {
      const src = numericSource({ field, column, fact: bounds.fact, use }, 'sum')
      return { sql: `coalesce(sum(${src.sql}), 0)`, bindings: src.binds }
    }
    // avg/min/max are NOT coalesced to 0: a bucket where nothing carried the field
    // has no average, and reporting 0 would put it on the chart as a real low value
    // rather than an absent one. It comes back null and the caller can say so.
    case 'avg': case 'min': case 'max': {
      const src = numericSource({ field, column, fact: bounds.fact, use }, agg)
      return { sql: `${agg}(${src.sql})`, bindings: src.binds }
    }
    case 'median': case 'percentile': {
      const src = numericSource({ field, column, fact: bounds.fact, use }, agg)
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
      const src = numericSource({ field, column, use }, agg)
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
export async function group(db, spec, { by, at, scope, limit, band, cohortSize, use: bucketUse } = {}) {
  if (!by) throw new Error('selector.group: needs `by` (a time grain, column, session:<utm>, attr:<key>, or fact:<key>)')
  const { filters, agg, bounds } = split(spec, GROUP_AGGS)
  const now = at ? new Date(at) : new Date()
  const factKey = factKeyOf(by)
  if (band != null && factKey == null) {
    throw new Error('selector.group: `band` only applies to a `fact:<key>` bucket (it bands a numeric fact into ranges)')
  }
  // Refused rather than ignored. `use` picks which of a passport's fact values the
  // BUCKET means, so on a time or column bucket it has no subject — and accepting it
  // silently would read as "the rule was applied" to whoever wrote it. The aggregate's
  // own rule lives in the aggregate (`avg: { fact, use }`), which is a different
  // question about a possibly different key.
  if (bucketUse !== undefined && factKey == null) {
    throw new Error(
      `selector.group: \`use\` only applies to a \`fact:<key>\` bucket (it picks WHICH of a passport's ` +
      `values the bucket means) — got by: ${JSON.stringify(by)}. For an aggregate over a fact, ` +
      `put it there: { avg: { fact: '<key>', use: '…' } }.`)
  }
  let bucket = bucketSql(by, band, factKey != null && computed.isComputed(factKey))
  const value = aggSql(agg, bounds)

  // `missingAnchor: 'bucket'` CROSS-TABULATES: one series per cohort, each broken
  // down by `by`. That is the shape the question has — "what do the people who
  // reached the milestone watch, that the people who never did don't" — and it needs
  // both sides at the same granularity to be answerable.
  //
  // It deliberately does NOT put the no-anchor total into the ordinary series. That
  // was the first shape here, and it is dimensionally mixed: it plots "people who
  // watched X" beside "people who never booked", which are not comparable
  // categories, so the bar that matters most is the one bar you cannot read against
  // the others.
  const crossTab = !!(filters.window && filters.window.missingAnchor === 'bucket')
  if (crossTab) {
    return crossTabByAnchor(db, { spec, filters, agg, bounds, bucket, value, by, at, scope, now, limit, factKey, bucketUse })
  }

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
    if (factKey != null) inner = joinFact(db, inner, factKey, now, 'f', bucketUse)   // the BUCKET fact
    inner = joinFact(db, inner, bounds.fact, now, 'af', bounds.use)         // the AGGREGATED fact
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
  if (factKey != null) q = joinFact(db, q, factKey, now, 'f', bucketUse)
  q = applyFilters(db, q, filters, { at, scope, now })
    .select(db.raw(`${bucket.sql} as bucket`, bucket.binds), db.raw(`${value.sql} as value`, value.bindings))
    .groupByRaw('1')                                          // group by the bucket (output position)
  q = (limit != null)
    ? q.orderByRaw('2 desc').limit(limit)                     // top-N by value (the guardrail)
    : q.orderByRaw('1')                                       // by bucket (chronological for time grains)

  // `value: null` is preserved deliberately. Number(null) is 0, and an avg/median of
  // a bucket where nothing carried the field would then plot as a real zero — the
  // same class of confident-wrong-number this engine keeps being bitten by.
  const series = (await q).map(r => ({ bucket: r.bucket, value: r.value == null ? null : Number(r.value) }))
  return cohortSize ? withCohortSize(db, series, agg, filters, { at, scope, now }) : series
}

/**
 * One series per cohort — anchored vs never-anchored — each bucketed by `by`.
 *
 * Emitted in the same shape the cohort projection already uses (and the chart layer
 * already renders): `{ multi: true, series: [{ name, points }], sizes: [{ cohort,
 * size }] }`. `sizes` is the per-cohort denominator, so a reach percentage inside
 * each series needs nothing further — which is the whole point, since comparing two
 * cohorts by raw counts compares their sizes more than their behaviour.
 *
 * `limit` is applied to the BUCKET dimension, not to the rows: the top-N buckets by
 * combined value across both cohorts, then every cohort's number for those buckets.
 * Taking the top N rows instead would return a ragged table — three buckets for one
 * cohort and one for the other — and a chart drawn from it would silently omit the
 * comparison it exists to make. It costs a second query to resolve which buckets win
 * before fetching them, which is cheaper than transferring every bucket to sort in
 * memory and is what makes the guardrail still a guardrail.
 */
const ANCHORED_BUCKET = '__anchored__'

async function crossTabByAnchor(db, { filters, agg, bounds, bucket, value, by, at, scope, now, limit, factKey, bucketUse }) {
  const alias = filters.window.between ? 'awa' : 'aw'
  const cohort = { sql: `case when ${alias}.anchor is null then ? else ? end`, binds: [NO_ANCHOR_BUCKET, ANCHORED_BUCKET] }
  const build = () => {
    let q = base(db, needsSession(filters, by))
    if (factKey != null) q = joinFact(db, q, factKey, now, 'f', bucketUse)
    return applyFilters(db, q, filters, { at, scope, now })
  }

  // Aggregating a FACT stays two-level here too — the per-passport dedup has to happen
  // before the aggregate or every customer is weighted by how many events they have,
  // which is the whole reason that path exists. The cohort simply rides along: it is a
  // function of the anchor, so it is constant per passport and adding it to the DISTINCT
  // changes nothing about which rows survive.
  const grouped = (cols) => {
    if (!bounds.fact) {
      // GROUP BY the KEY columns only, by output position — position N would be the
      // aggregate itself, which Postgres rejects outright ("aggregate functions are
      // not allowed in GROUP BY"). Positions rather than repeating the expressions,
      // because a bucket expression carries binds and repeating it would double them.
      const keys = cols.filter(c => c.as !== 'value')
      return build().select(...cols.map(c => db.raw(`${c.sql} as ${c.as}`, c.binds)))
        .groupByRaw(keys.map((_, i) => i + 1).join(', '))
    }
    let inner = base(db, needsSession(filters, by))
    if (factKey != null) inner = joinFact(db, inner, factKey, now, 'f', bucketUse)
    inner = joinFact(db, inner, bounds.fact, now, 'af', bounds.use)
    const afCol = computed.isComputed(bounds.fact) ? 'af.value::text' : `af.value #>> '{}'`
    inner = applyFilters(db, inner, filters, { at, scope, now }).distinct(
      'e.passport_id',
      ...cols.filter(c => c.as !== 'value').map(c => db.raw(`${c.sql} as ${c.as}`, c.binds)),
      db.raw(`case when (${afCol}) ~ ? then (${afCol})::numeric end as v`, [NUMERIC_TEXT]),
    )
    const keys = cols.filter(c => c.as !== 'value').map(c => c.as)
    return db.from(inner.as('d'))
      .select(...keys, db.raw(`${value.sql} as value`, value.bindings))
      .groupBy(...keys)
  }

  const COHORT = { sql: cohort.sql, binds: cohort.binds, as: 'cohort' }
  const BUCKET = { sql: bucket.sql, binds: bucket.binds, as: 'bucket' }
  const VALUE = { sql: value.sql, binds: value.bindings, as: 'value' }

  // Which buckets survive the guardrail — decided across both cohorts together.
  let keep = null
  if (limit != null) {
    const top = await grouped([BUCKET, VALUE]).orderByRaw('2 desc nulls last').limit(limit)
    keep = top.map(r => r.bucket)
    if (!keep.length) return { multi: true, series: [], sizes: [], aggregate: agg }
  }

  let q = grouped([COHORT, BUCKET, VALUE]).orderByRaw('1, 2')
  if (keep) {
    // A null bucket is a REAL bucket here — "no value for the group dimension" — and
    // `= any()` never matches null, so it needs its own arm or the guardrail would
    // silently drop the one bucket that says "we don't know".
    // `bucket` is the raw expression on the single-level query and a plain column on
    // the two-level one, so the filter has to name whichever this is.
    const col = bounds.fact ? { sql: 'bucket', binds: [] } : bucket
    const named = keep.filter(k => k != null)
    const parts = [], binds = []
    if (named.length) { parts.push(`${col.sql} = any(?)`); binds.push(...col.binds, named) }
    if (keep.some(k => k == null)) { parts.push(`${col.sql} is null`); binds.push(...col.binds) }
    q = q.whereRaw(`(${parts.join(' or ')})`, binds)
  }

  const byCohort = new Map()
  for (const r of await q) {
    if (!byCohort.has(r.cohort)) byCohort.set(r.cohort, [])
    byCohort.get(r.cohort).push({ bucket: r.bucket, value: r.value == null ? null : Number(r.value) })
  }

  // Sizes come from the same filtered set, per cohort, so the denominators and the
  // series cannot disagree about who is in which half.
  const sizeRows = await build()
    .select(db.raw(`${cohort.sql} as cohort`, cohort.binds), db.raw('count(distinct e.passport_id)::int as n'))
    .groupByRaw('1')
  const sizes = sizeRows.map(r => ({ cohort: r.cohort, size: r.n }))

  // Stable order: the anchored cohort first, because it is the one being explained.
  const order = [ANCHORED_BUCKET, NO_ANCHOR_BUCKET]
  const series = order.filter(n => byCohort.has(n)).map(name => ({ name, points: byCohort.get(name) }))
  return { multi: true, series, sizes, aggregate: agg }
}

/**
 * The DENOMINATOR — how many distinct passports the query is over — beside the
 * series, so a reach percentage does not cost another round trip. Opt-in
 * (`group: { cohortSize: true }`) precisely so the default return stays a bare
 * array and nothing that already reads one has to change.
 *
 * Three decisions worth stating, because each one is a different number:
 *
 *  · Always distinct PASSPORTS, whatever the series aggregates. A series of
 *    exposure counts still wants "of how many people", not "of how many events" —
 *    a per-event denominator would make every percentage a ratio of two different
 *    units.
 *  · Counted BEFORE `limit`. `limit` is the top-N display guardrail; if it also
 *    trimmed the denominator, asking for the top 50 buckets would silently inflate
 *    every percentage in them.
 *  · It counts the cohort the FILTER selects, including passports that contribute
 *    nothing to any bucket — someone whose fact value is missing or non-numeric is
 *    still in the cohort. That is the honest denominator for "what share of these
 *    people did we see doing this"; the alternative flatters the answer.
 *
 * A second query rather than a window function: Postgres has no
 * `count(distinct …) over ()`, so doing it in one statement would mean wrapping the
 * whole thing in a CTE and re-shaping the query that every other path here shares.
 * One extra aggregate over the same filtered set is the cheaper trade, and it is
 * still one call for the caller.
 */
async function withCohortSize(db, series, agg, filters, { at, scope, now }) {
  // No `by` passed to needsSession: the bucket dimension is irrelevant to a count
  // of people, so the sessions join is only taken when a FILTER needs it.
  const q = applyFilters(db, base(db, needsSession(filters)), filters, { at, scope, now })
  const [row] = await q.select(db.raw('count(distinct e.passport_id)::int as n'))
  return { series, cohortSize: row?.n ?? 0, aggregate: agg }
}
