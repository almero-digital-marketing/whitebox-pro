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
export const MEASURES = [{ label: 'count', value: 'count' }, { label: 'sum', value: 'sum' }]
export const CMPS = [{ label: '≥', value: 'gte' }, { label: '≤', value: 'lte' }]
export const COMBINATORS = [{ label: 'all', value: 'all' }, { label: 'any', value: 'any' }]
