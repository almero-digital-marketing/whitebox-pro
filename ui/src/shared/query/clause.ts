// The "one condition on a person" clause model, and its translation to/from
// the filter DSL server/src/selector/filter.js actually evaluates:
//
//   filter = clause | { all: [filter…] } | { any: [filter…] } | { not: filter }
//   clause = { fact: { <key>: { <op>: <value> } } } | { metric: { … } }
//
// buildFilter/parseFilter are the two directions of that translation for a
// whole filter tree; buildClause/parseClause do the same for one row. Used
// by Analytics' Query builder (useQueryModel.ts) and Journeys' branch-step
// condition editor — anywhere a person needs to be matched against facts or
// activity, not just inside a "query."

import { MEASURES, NEEDS_FIELD } from './constants'

export const coerceScalar = (v: string): any => {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !isNaN(Number(v))) return Number(v)
  return v
}

export const eventArr = (ev: any): string[] => ev == null ? [] : (ev.in ? ev.in : Array.isArray(ev) ? ev : [ev])

export const newCondition = (defaultKey = '') => ({
  not: false, type: 'fact', key: defaultKey, op: 'eq', value: '',
  events: [] as string[], campaigns: [] as string[], sources: [] as string[],
  channel: '', direction: '',
  measure: 'count', sumField: 'value', cmp: 'gte', mvalue: '1', window: '',
})

function eventClause(events: string[]) { return events.length === 1 ? events[0] : { in: events } }
// A session column takes a bare value or an array; one entry writes the bare
// form so the saved JSON matches what a person would write by hand.
const one = (vals: string[]) => (vals.length === 1 ? vals[0] : vals)
// …and reads back either, plus the { in: [...] } form the engine also accepts.
const valueArr = (v: any): string[] =>
  v == null ? [] : Array.isArray(v) ? v : (Array.isArray(v?.in) ? v.in : [v])
const MEASURE_KEYS = MEASURES.map((m) => m.value)

export function buildClause(c: any): any {
  let cl: any
  if (c.type === 'metric') {
    const m: any = {}
    if (c.events?.length) m.attrs = { event: eventClause(c.events) }
    // Both session dimensions the app already treats as first-class elsewhere
    // (see BREAKDOWN_SLICES); they compose, so "campaign X from source Y" is one
    // condition rather than two.
    const session: any = {}
    if (c.campaigns?.length) session.utm_campaign = one(c.campaigns)
    if (c.sources?.length) session.utm_source = one(c.sources)
    if (Object.keys(session).length) m.session = session
    // Own columns on the exposure, not attrs — '' means "don't narrow".
    if (c.channel) m.channel = c.channel
    if (c.direction) m.direction = c.direction
    const bound = { [c.cmp]: coerceScalar(c.mvalue) }
    // `sum` is the only aggregate that names a field; the rest take the bound
    // alone. Writing { field } on the others would be a key metric.js rejects.
    m[c.measure] = NEEDS_FIELD.has(c.measure)
      ? { field: (c.sumField || 'value').trim(), ...bound }
      : bound
    if (c.window) m.last = c.window
    cl = { metric: m }
  } else {
    const val = c.op === 'present' ? true
      : c.op === 'in' ? c.value.split(',').map((s: string) => coerceScalar(s.trim()))
        : coerceScalar(c.value)
    cl = { fact: { [c.key]: { [c.op]: val } } }
  }
  return c.not ? { not: cl } : cl
}

export function parseClause(cl: any): any | null {
  let not = false
  if (cl?.not) { not = true; cl = cl.not }
  if (cl?.fact) {
    const key = Object.keys(cl.fact)[0]; const op = Object.keys(cl.fact[key])[0]
    const v = cl.fact[key][op]
    return { ...newCondition(), not, type: 'fact', key, op, value: Array.isArray(v) ? v.join(', ') : String(v) }
  }
  if (cl?.metric) {
    const m = cl.metric
    // Whichever aggregate is present, not just the two the row used to build —
    // a saved condition can hold any of them, and defaulting an unrecognised
    // one to `count` would silently rewrite the query on the next save.
    const measure = MEASURE_KEYS.find((k) => k in m) || 'count'
    const agg = m[measure] || {}
    const cmp = agg.lte !== undefined ? 'lte' : 'gte'
    const mvalue = agg.gte ?? agg.lte ?? ''
    return {
      ...newCondition(), not, type: 'metric', events: eventArr(m.attrs?.event),
      campaigns: valueArr(m.session?.utm_campaign),
      sources: valueArr(m.session?.utm_source),
      channel: m.channel || '', direction: m.direction || '',
      measure, sumField: agg.field || 'value',
      cmp, mvalue: String(mvalue), window: m.last || '',
    }
  }
  return null
}

// A whole filter tree ({all:[...]} / {any:[...]} / a bare single clause /
// undefined) → the flat {combinator, conditions[]} shape a ConditionsBuilder
// edits, and back. A single condition round-trips through a bare clause
// (no {all:[...]} wrapper) — buildFilter only wraps once there are 2+.
//
// `unrepresented` carries the clauses this flat shape CANNOT hold, verbatim.
// The filter DSL is recursive — all/any/not each take a filter, not a clause —
// so a nested group, or a `not` wrapping one, has no row to become. The builder
// is one combinator over a list, and widening it to a recursive tree makes the
// common two-condition case worse; that limit is deliberate.
//
// What is not deliberate is losing them. These used to be dropped on the floor
// by .filter(Boolean), and because buildFilter reconstructs the filter from
// whatever survived, opening such a query and saving ANY unrelated edit — a
// title, a chart kind — silently deleted the nested branch. Queries composed
// through MCP are the ones that use the full grammar, so they were exactly the
// ones at risk.
//
// Returning them makes that the caller's decision instead of an accident: a
// caller with a non-empty `unrepresented` must not persist the result of
// buildFilter over the original.
export function parseFilter(filter: any): { combinator: 'all' | 'any'; conditions: any[]; unrepresented: any[] } {
  const split = (clauses: any[]) => {
    const conditions: any[] = []
    const unrepresented: any[] = []
    for (const cl of clauses) {
      const c = parseClause(cl)
      if (c) conditions.push(c)
      else unrepresented.push(cl)
    }
    return { conditions, unrepresented }
  }
  if (filter?.all) return { combinator: 'all', ...split(filter.all) }
  if (filter?.any) return { combinator: 'any', ...split(filter.any) }
  if (filter) return { combinator: 'all', ...split([filter]) }
  return { combinator: 'all', conditions: [], unrepresented: [] }
}

// A row counts once it narrows ANYTHING. The test used to be events-or-
// campaigns, which was the whole of what the row could set; with channel,
// direction, source and lookback now settable, that test would have thrown each
// of them away on save — silently, the way a dropped condition always goes.
//
// Still a test rather than "keep everything": clicking + and leaving the row
// untouched must not add `count >= 1` (anyone with any activity at all) to the
// query behind the user's back.
const narrows = (c: any) => !!(
  c.events?.length || c.campaigns?.length || c.sources?.length ||
  c.channel || c.direction || c.window
)

export function buildFilter(combinator: 'all' | 'any', conditions: any[]): any {
  const valid = conditions.filter((c) => (c.type === 'metric' ? narrows(c) : c.key))
  const clauses = valid.map(buildClause)
  if (!clauses.length) return undefined
  return clauses.length === 1 ? clauses[0] : { [combinator]: clauses }
}
