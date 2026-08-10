// Shared option lists for the "one condition on a person" clause model (see
// clause.ts) — used anywhere a person needs to be matched against facts or
// activity: Analytics' Query builder and Journeys' branch-step condition
// editor. Query-kind-specific constants (chart kinds, cohort grains, ...)
// stay local to analytics/components/query/constants.ts.

export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'present'].map((o) => ({ label: o, value: o }))

// What kind of answer each operator wants from the data, which is what decides
// how a fact key gets described to the user (see ConditionRow's factHint):
// an exact match wants the value list, a range wants the bounds, and a
// presence check wants the population.
export const OP_GROUP: Record<string, 'exact' | 'range' | 'presence'> = {
  eq: 'exact', ne: 'exact', in: 'exact',
  gt: 'range', gte: 'range', lt: 'range', lte: 'range',
  present: 'presence',
}

// The fact-key options a condition row binds to. Carries the schema's
// discovered stats (type/values/bounds/counts) alongside label+value so the
// row can describe whichever key is chosen — PrimeVue's Select reads only
// label/value and ignores the rest. One definition, because both consumers
// (Analytics' query builder and Journeys' branch editor) have to describe a
// fact identically; two hand-written maps would drift.
export const factKeyOptions = (schema: any) => (schema?.factKeys || []).map((k: any) => ({
  label: k.key,
  value: k.key,
  type: k.type ?? null,
  values: k.values || [],     // complete set, categorical keys only
  sample: k.sample || [],     // up to 8, any key
  distinct: k.distinct ?? null,
  people: k.people ?? null,
  min: k.min ?? null,
  max: k.max ?? null,
}))
export const CLAUSE_TYPES = [{ label: 'Fact', value: 'fact' }, { label: 'Activity', value: 'metric' }]
// Every aggregate a GATE metric can use — selector/metric.js GATE_AGGS. The row
// offered `count` and `sum` only, so four fifths of what the engine can already
// answer had no way to be asked: how many distinct SESSIONS someone had, how
// long they spent, how many days since they were last seen.
//
// Labelled by what they mean to someone reading the row rather than by their
// key. "events >= 3" and "sessions >= 3" are different questions and the key
// names do not say so.
//
// `distinct_passports` is deliberately absent: it is a GROUP aggregate. Counting
// distinct people cannot gate the very people it counts, and the engine rejects
// it here.
export const MEASURES = [
  { label: 'events', value: 'count' },
  { label: 'sessions', value: 'distinct_sessions' },
  { label: 'time spent (ms)', value: 'sum_dwell_ms' },
  { label: 'sum of', value: 'sum' },
  { label: 'days since last', value: 'recency_days' },
]

// The aggregate that needs a field named alongside it — sum reads meta.<field>
// per event, and the row hardcoded 'value'. Anything else recorded on an event
// (a price, a duration, a score) was unreachable.
export const NEEDS_FIELD = new Set(['sum'])

// Both are open strings in the engine, so these are the values actually in use
// rather than a schema-declared enum. Left free of a "must be one of" claim: an
// unknown value is a legitimate saved condition, the same way an unrecorded
// fact key is.
export const DIRECTIONS = [
  { label: 'any direction', value: '' },
  { label: 'expression', value: 'expression' },
  { label: 'conversion', value: 'conversion' },
  { label: 'exposure', value: 'exposure' },
  { label: 'conversation', value: 'conversation' },
  { label: 'observation', value: 'observation' },
]
export const CMPS = [{ label: '≥', value: 'gte' }, { label: '≤', value: 'lte' }]
export const COMBINATORS = [{ label: 'all', value: 'all' }, { label: 'any', value: 'any' }]
