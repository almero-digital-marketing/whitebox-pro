import * as funnelEngine from './funnel.js'
import { resolvePeople, preview } from './people.js'
import { resolveKnowledge, resolveGroup } from './knowledge.js'

// The selector engine — the public face. `resolve()` dispatches by projection;
// the people and knowledge paths live in their own modules (people.js,
// knowledge.js), the shared injected deps in runtime.js, the semantic narrow in
// about.js, and the deterministic gates in filter.js / metric.js / judge.js.
// Funnels (§14) compose the people path. See docs/selector.md.

export { init } from './runtime.js'
export { preview }

// resolve(selector, opts) → a projection result
//   projection: "count" (the number alone) | "people" (ids) | "knowledge" (evidence)
//   scope:      people → passport-id array | undefined (whole base)
//               knowledge → "passport" (with `passport`) | undefined (base)
//   passport:   the passport id, for knowledge·passport scope
//   asOf:       a point in time — applies to the deterministic filter; `about`
//               is a now-relative semantic narrow/rank
//   limit:      knowledge — evidence rows to return
//   group:      { by } — return a time-series / breakdown series instead of a
//               projection (§7); buckets selector.filter.metric by a time grain
//               or dimension
export async function resolve(selector = {}, opts = {}) {
  if (opts.group) return resolveGroup(selector, opts)   // charts — a series, not a projection
  const { projection = 'people' } = opts
  // `count` — the same query, without serialising the ids.
  //
  // "How many customers have visited?" answered with 153,245 passport ids is
  // 9.4 MB of payload for a number that is already sitting in the first field,
  // and it is enough to blow an MCP client's budget outright. The cohort is
  // computed identically; this only declines to ship what the caller did not
  // ask for.
  //
  // A separate projection rather than a truncation of `people`: a shortened
  // array would leave `count` and `passports.length` disagreeing, which is a
  // subtler trap than the one being fixed. And `people` keeps its exact
  // contract — matched_at per passport is what funnels anchor on.
  if (projection === 'count') {
    const { count } = await resolvePeople(selector, opts)
    return { count }
  }
  if (projection === 'people') return resolvePeople(selector, opts)
  if (projection === 'knowledge') return resolveKnowledge(selector, opts)
  throw new Error(`selector: projection "${projection}" not implemented yet`)
}

// funnel(spec, { asOf, named }) — ordered windowed steps over the people engine.
// Each step is resolved as a people query scoped to the prior step's survivors,
// joined on matched_at. Returns { report, steps, gaps } (§14). `funnelSlot` turns
// a result + slot name into an audience cohort.
export async function funnel(spec, { asOf, named } = {}) {
  return funnelEngine.run(spec, {
    asOf,
    named,
    resolveStep: (sel, { scope, anchors }) => resolvePeople(sel, { projection: 'people', scope, anchors, asOf }),
  })
}
export const funnelSlot = funnelEngine.slot
