// Pure predicate logic for facts — no DB. `matchValue` evaluates value operators
// against a resolved current/as-of value; `matchTemporal` evaluates change /
// transition operators against a key's ordered history. The store feeds these;
// the selector's `filter.fact` is defined by them. See docs/temporal-facts.md.

const UNIT = { h: 3600e3, d: 86400e3, w: 604800e3 }

// Parse a relative window like "7d", "24h", "2w" → milliseconds.
function ms(window) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(window ?? '').trim())
  if (!m) throw new Error(`facts: bad window "${window}" (use e.g. 7d, 24h, 2w)`)
  return Number(m[1]) * UNIT[m[2]]
}

// Numbers compare numerically; ISO-date-ish strings as time; else lexically.
function toTime(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// An actual number, or a string that is ENTIRELY numeric. Returns the number, or
// null. ISO dates ("2024-01-15") are NOT purely numeric, so they still fall
// through to date parsing in cmp — only bare numerics short-circuit here. This is
// what keeps a fact stored as the string "1820" from being read as the YEAR 1820.
function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

// Equality for eq/ne/in: exact match, OR numerically equal when BOTH sides are
// purely numeric — so a fact stored as the string "123" matches { eq: 123 }, and
// "08" matches { eq: 8 }. Non-numeric strings ("08-A", "active") only ever match
// exactly, so distinct string categories are never coerced together.
function numEq(a, b) {
  if (a === b) return true
  const na = asNumber(a), nb = asNumber(b)
  return na != null && nb != null && na === nb
}

// Ordering. Returns null for INCOMPARABLE — which is what an absent value on
// either side is. Without that guard the lexical fallback compared the STRING
// 'null': `{ gte: null }` matched every value sorting after it ("zebra" yes,
// "active" no), and a value going null read as a real `decreased` because
// '100' < 'null'. Neither is an ordering question that has an answer.
function cmp(a, b) {
  if (a == null || b == null) return null
  const na = asNumber(a), nb = asNumber(b)
  if (na != null && nb != null) return na - nb          // both purely numeric → numeric order
  const ta = toTime(a), tb = toTime(b)                  // else date-ish?
  if (ta != null && tb != null) return ta - tb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0   // else lexical
}

// Ordering PREDICATES. Every caller goes through these rather than testing
// cmp()'s result inline, because `null >= 0` and `null <= 0` are both TRUE in JS
// — so the obvious `cmp(a, b) >= 0` would turn "incomparable" back into a match
// for exactly the two operators this is guarding. Incomparable is always no.
const ordered = (op) => (a, b) => { const c = cmp(a, b); return c != null && op(c) }
const gtBy = ordered(c => c > 0)
const gteBy = ordered(c => c >= 0)
const ltBy = ordered(c => c < 0)
const lteBy = ordered(c => c <= 0)

// `held` and `distinct` join these because they read the HISTORY, not the current
// value — which is the whole point of them.
//
// A fact is latest-value-per-passport by design: `booking_location` answers "which
// studio is this customer's most recent" and cannot answer "which studios has this
// customer used", because the earlier rows are invisible to `eq`/`in`. The event
// stream can answer it via `attr:location`, but one row per visit means a customer
// is counted once per visit rather than once per studio.
//
//   { booking_location: { held: 'София - Лозенец' } }        ever, not just latest
//   { booking_location: { held: { in: [...], last: '90d' } } }
//   { booking_location: { distinct: { gte: 2 } } }           uses two or more studios
const TEMPORAL_OPS = ['changed', 'transition', 'decreased', 'increased', 'held', 'distinct']

// A predicate needs the history (not just the current value) iff it uses a
// temporal operator.
export function isTemporal(predicate) {
  return Object.keys(predicate || {}).some(k => TEMPORAL_OPS.includes(k))
}

// Evaluate a value predicate against `value` (which may be undefined when the
// key is absent, or null when it was recorded empty). Multiple operators in one
// predicate are AND-ed (e.g. a range `{ gte: 200, lte: 400 }`).
export function matchValue(value, predicate, now = new Date()) {
  const nowMs = now.getTime()
  const p = predicate || {}

  // NO USABLE VALUE — two spellings of the same thing, so they take one path.
  // `undefined` is a key with no row; `null` is a row whose value is JSON null,
  // or a computed fact whose source date was absent or unparseable.
  //
  // Only `undefined` used to short-circuit here, which made null the most
  // dangerous value in the system: it reached cmp(), where asNumber() and
  // toTime() both give up and the comparison falls through to LEXICAL order.
  // String(null) is 'null', and 'null' > '1', so EVERY `{ gte: <number> }`
  // matched EVERY null-valued row. "Customers who spent 300+" quietly included
  // everyone whose spend was never recorded — a false positive that grows with
  // how much data you are missing, and reads as a bigger, healthier cohort.
  //
  // `distinct` already skipped nulls when counting values; this is the same rule
  // applied where it was missing rather than a new one.
  const empty = value === undefined || value === null

  if ('present' in p) {
    // `present` asks whether there is a VALUE, and null is not one. So a
    // recorded-but-empty birthdate answers `{ present: true }` with no — the
    // same answer `{ gte: 30 }` now gives, instead of contradicting it.
    if (p.present ? empty : !empty) return false
    if (Object.keys(p).length === 1) return true
  }
  // Nothing compares to an absent value, including `ne`: a key with no row has
  // never matched `{ ne: 'x' }` either, and null follows it rather than becoming
  // a second, looser kind of absent.
  if (empty) return false
  const t = toTime(value)

  for (const [op, bound] of Object.entries(p)) {
    let ok
    switch (op) {
      case 'present': continue                                   // already handled
      case 'eq':  ok = numEq(value, bound); break
      case 'ne':  ok = !numEq(value, bound); break
      case 'in':  ok = Array.isArray(bound) && bound.some(b => numEq(value, b)); break
      case 'gt':  ok = gtBy(value, bound); break
      case 'gte': ok = gteBy(value, bound); break
      case 'lt':  ok = ltBy(value, bound); break
      case 'lte': ok = lteBy(value, bound); break
      // Directional date windows — each states which way time points, so the
      // window is unambiguous without knowing the value.
      case 'next':   ok = t != null && t >= nowMs && t <= nowMs + ms(bound); break    // upcoming, e.g. renews in the next 30d
      case 'last':   ok = t != null && t >= nowMs - ms(bound) && t <= nowMs; break     // recent, e.g. ordered in the last 30d
      case 'before': ok = t != null && t < nowMs - ms(bound); break                    // older than, e.g. last order > 60d ago
      default: throw new Error(`facts: unknown value operator "${op}"`)
    }
    if (!ok) return false
  }
  return true
}

// Evaluate a temporal predicate against `history` (rows oldest-first, each with
// `value` + `observed_at`). `now` bounds the relative windows.
export function matchTemporal(history, predicate, now = new Date()) {
  const nowMs = now.getTime()
  const p = predicate || {}
  const inWin = (r, w) => new Date(r.observed_at).getTime() >= nowMs - ms(w)

  for (const [op, spec] of Object.entries(p)) {
    let ok
    switch (op) {
      case 'changed':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && r.value !== history[i - 1].value)
        break
      case 'transition':
        // A transition needs a prior, different value — the initial observation
        // of a value is not a transition into it.
        ok = history.some((r, i) => {
          if (i === 0 || !inWin(r, spec.last)) return false
          const prev = history[i - 1].value
          if (prev === r.value) return false                        // not a change
          if (spec.to !== undefined && r.value !== spec.to) return false
          if (spec.from !== undefined && prev !== spec.from) return false
          return true
        })
        break
      case 'decreased':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && ltBy(r.value, history[i - 1].value))
        break
      case 'increased':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && gtBy(r.value, history[i - 1].value))
        break
      default: throw new Error(`facts: unknown temporal operator "${op}"`)
    }
    if (!ok) return false
  }
  return true
}

// The `matched_at` of a temporal match: the qualifying event's observed_at, or
// null if the predicate doesn't hold. For each op we take the LATEST qualifying
// row (the most recent time it became true); a multi-op predicate composites to
// the latest across ops (the moment the whole predicate was satisfied). This is
// the funnel anchor for a temporal step. See docs/selector.md §7.
export function temporalMatchedAt(history, predicate, now = new Date()) {
  const nowMs = now.getTime()
  const p = predicate || {}
  const inWin = (r, w) => new Date(r.observed_at).getTime() >= nowMs - ms(w)

  let composite = null
  for (const [op, spec] of Object.entries(p)) {
    // An aggregate over the history rather than a test on one row, so it cannot go
    // in the per-row loop below. matched_at is the instant the count REACHED the
    // bound — the visit that made them a two-studio customer, which is the event a
    // funnel step should anchor on, not their latest visit.
    if (op === 'distinct') {
      const { gte, lte, last } = (spec && typeof spec === 'object') ? spec : { gte: spec }
      const seen = new Set()
      let reachedAt = null
      for (const r of history) {
        if (last && !inWin(r, last)) continue
        if (r.value === undefined || r.value === null) continue
        seen.add(JSON.stringify(r.value))                    // by VALUE — objects included
        if (gte != null && reachedAt == null && seen.size >= gte) reachedAt = new Date(r.observed_at).getTime()
      }
      const n = seen.size
      if (gte != null && n < gte) return null
      if (lte != null && n > lte) return null
      // No gte to cross (an lte-only bound) → the last observation is the answer.
      const best = reachedAt ?? (history.length ? new Date(history[history.length - 1].observed_at).getTime() : null)
      if (best == null) return null
      if (composite == null || best > composite) composite = best
      continue
    }

    let best = null   // latest qualifying observed_at (ms) for this op
    for (let i = 0; i < history.length; i++) {
      const r = history[i]
      let ok = false
      switch (op) {
        case 'changed':
          ok = i > 0 && inWin(r, spec.last) && r.value !== history[i - 1].value
          break
        case 'transition': {
          if (i === 0 || !inWin(r, spec.last)) break
          const prev = history[i - 1].value
          if (prev === r.value) break
          if (spec.to !== undefined && r.value !== spec.to) break
          if (spec.from !== undefined && prev !== spec.from) break
          ok = true
          break
        }
        case 'decreased':
          ok = i > 0 && inWin(r, spec.last) && ltBy(r.value, history[i - 1].value)
          break
        case 'increased':
          ok = i > 0 && inWin(r, spec.last) && gtBy(r.value, history[i - 1].value)
          break
        case 'held': {
          // The value comparators, applied to a historical row instead of the
          // current one — so `held` accepts everything `eq`/`in`/a range does and
          // cannot drift from them. A bare value or array is sugar for eq/in.
          const raw = (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec : (Array.isArray(spec) ? { in: spec } : { eq: spec })
          const { last, ...valuePred } = raw
          if (last && !inWin(r, last)) break
          ok = matchValue(r.value, Object.keys(valuePred).length ? valuePred : { present: true }, now)
          break
        }
        default: throw new Error(`facts: unknown temporal operator "${op}"`)
      }
      if (ok) { const t = new Date(r.observed_at).getTime(); if (best == null || t > best) best = t }
    }
    if (best == null) return null               // this op never qualified → no match
    if (composite == null || best > composite) composite = best
  }
  return composite == null ? null : new Date(composite)
}
