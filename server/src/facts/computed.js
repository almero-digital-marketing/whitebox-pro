// Computed facts — a key DERIVED from a stored one, evaluated on read.
//
// `age` is not a fact anybody can store. Written down it is wrong tomorrow, and a
// nightly job that rewrites 111k rows to bump a number is a lot of machinery to
// keep one integer current. What IS a fact is `birthdate`; age is a reading of it
// taken at a moment. Same for how long someone has been a customer
// (`first_booked_at`) and how long since they were last seen (`last_visit_at`).
//
// Without them every cohort question needs the date computed by the CALLER and
// pasted in — `last_visit_at >= '2026-02-16'` — which answers "since 16 February",
// not "in the last six months", and silently means something different the next
// day. That is the gap this closes.
//
// Declared in whitebox.config.js, so a deployment names the vocabulary its data
// actually has:
//
//   facts: {
//     computed: {
//       age:                     { from: 'birthdate',       unit: 'years'  },
//       tenure_years:            { from: 'first_booked_at',  unit: 'years'  },
//       months_since_last_visit: { from: 'last_visit_at',    unit: 'months' },
//       days_since_last_visit:   { from: 'last_visit_at',    unit: 'days'   },
//     },
//   }
//
// Then the key behaves like any other, everywhere, with no new query syntax:
//
//   { fact: { age: { gte: 30, lte: 39 } } }          a cohort
//   { by: 'fact:age', band: 5 }                       a breakdown in 5-year bands
//
// ONE expression, in SQL, shared by the predicate path and the grouped path. The
// obvious split — derive in JS where the predicate already filters in memory, and
// in SQL where a GROUP BY forces it — gives two definitions of "age" that agree
// until a leap year, which is exactly the kind of divergence nobody finds.
//
// Read-time also means `asOf` keeps working: age as of a past instant is the same
// expression with a different `now`, so time travel needs no special case.

// The stored value, cast to a timestamp. `nullif` so an empty string derives to
// NULL rather than raising — one unparseable row must not fail the whole query.
const SRC = `nullif(value #>> '{}', '')::timestamptz`

const UNITS = {
  // Calendar-correct, not ms/365.25: `age()` counts whole years the way a person
  // does, so someone born on 29 February is not a day out every fourth year.
  years: (nowSql) => `extract(year from age(${nowSql}, ${SRC}))`,
  months: (nowSql) => `(extract(year from age(${nowSql}, ${SRC})) * 12 + extract(month from age(${nowSql}, ${SRC})))`,
  // Whole days between two DATES — deliberately date-truncated, so "yesterday" is
  // 1 regardless of the clock time either side of it.
  days: (nowSql) => `(${nowSql}::date - (${SRC})::date)`,
}

let registry = new Map()

/**
 * Register the computed keys from config. Validated loudly at boot rather than on
 * first query: a typo in a unit is an error the operator should see once, at
 * startup, not as an empty chart weeks later.
 */
export function init(computed = {}) {
  registry = new Map()
  for (const [key, spec] of Object.entries(computed || {})) {
    const from = spec?.from
    const unit = spec?.unit
    if (!from || typeof from !== 'string') {
      throw new Error(`facts.computed.${key}: needs \`from\` (the stored date fact it is derived from)`)
    }
    if (!UNITS[unit]) {
      throw new Error(`facts.computed.${key}: unknown unit "${unit}" (one of ${Object.keys(UNITS).join('/')})`)
    }
    if (from === key) throw new Error(`facts.computed.${key}: cannot derive a key from itself`)
    if (computed[from]) {
      // Deriving from a derived key would need an ordering pass and gains nothing
      // real — every case here is one hop off a stored date.
      throw new Error(`facts.computed.${key}: \`from\` must be a STORED fact, and "${from}" is itself computed`)
    }
    registry.set(key, { from, unit })
  }
  return registry.size
}

export const isComputed = (key) => registry.has(key)
export const specOf = (key) => registry.get(key) || null
export const computedKeys = () => [...registry.keys()]

/**
 * The SQL for a computed key's value, as a numeric. `now` is bound, never
 * interpolated, and defaults to the statement clock.
 *
 * Returns null for a key that is not computed, so callers can treat "computed?"
 * and "how?" as one question.
 */
export function derivedSql(key, { now = null } = {}) {
  const spec = registry.get(key)
  if (!spec) return null
  const nowSql = now ? '?::timestamptz' : 'now()'
  const sql = UNITS[spec.unit](nowSql)
  // ONE bind per placeholder, counted from the generated SQL rather than assumed.
  // `months` mentions the clock twice (whole years × 12 + residual months), so a
  // single bind for a two-placeholder expression fails with "Expected 1 binding,
  // saw 2" — the same mistake as counting `?` inside a quoted regex.
  const holes = (sql.match(/\?/g) || []).length
  return { sql, binds: now ? Array(holes).fill(now) : [], from: spec.from, unit: spec.unit }
}
