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

export const coerceScalar = (v: string): any => {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !isNaN(Number(v))) return Number(v)
  return v
}

export const eventArr = (ev: any): string[] => ev == null ? [] : (ev.in ? ev.in : Array.isArray(ev) ? ev : [ev])

export const newCondition = (defaultKey = '') => ({
  not: false, type: 'fact', key: defaultKey, op: 'eq', value: '',
  events: [] as string[], campaigns: [] as string[], measure: 'count', cmp: 'gte', mvalue: '1', window: '',
})

function eventClause(events: string[]) { return events.length === 1 ? events[0] : { in: events } }

export function buildClause(c: any): any {
  let cl: any
  if (c.type === 'metric') {
    const m: any = {}
    if (c.events?.length) m.attrs = { event: eventClause(c.events) }
    if (c.campaigns?.length) m.session = { utm_campaign: c.campaigns.length === 1 ? c.campaigns[0] : c.campaigns }
    const bound = { [c.cmp]: coerceScalar(c.mvalue) }
    if (c.measure === 'sum') m.sum = { field: 'value', ...bound }; else m.count = bound
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
    const measure = m.sum ? 'sum' : 'count'
    const agg = m.sum || m.count || {}
    const cmp = agg.lte !== undefined ? 'lte' : 'gte'
    const mvalue = agg.gte ?? agg.lte ?? ''
    const camp = m.session?.utm_campaign
    return {
      ...newCondition(), not, type: 'metric', events: eventArr(m.attrs?.event),
      campaigns: camp == null ? [] : (Array.isArray(camp) ? camp : [camp]), measure, cmp, mvalue: String(mvalue), window: m.last || '',
    }
  }
  return null
}

// A whole filter tree ({all:[...]} / {any:[...]} / a bare single clause /
// undefined) → the flat {combinator, conditions[]} shape a ConditionsBuilder
// edits, and back. A single condition round-trips through a bare clause
// (no {all:[...]} wrapper) — buildFilter only wraps once there are 2+.
export function parseFilter(filter: any): { combinator: 'all' | 'any'; conditions: any[] } {
  if (filter?.all) return { combinator: 'all', conditions: filter.all.map(parseClause).filter(Boolean) }
  if (filter?.any) return { combinator: 'any', conditions: filter.any.map(parseClause).filter(Boolean) }
  if (filter) { const c = parseClause(filter); return { combinator: 'all', conditions: c ? [c] : [] } }
  return { combinator: 'all', conditions: [] }
}

export function buildFilter(combinator: 'all' | 'any', conditions: any[]): any {
  const valid = conditions.filter((c) => (c.type === 'metric' ? (c.events?.length || c.campaigns?.length) : c.key))
  const clauses = valid.map(buildClause)
  if (!clauses.length) return undefined
  return clauses.length === 1 ? clauses[0] : { [combinator]: clauses }
}
