import * as facts from '../facts/index.js'
import * as metric from './metric.js'

// Boolean evaluation of a selector's `filter` tree → passports, each with a
// `matched_at` (the qualifying-event time, the funnel anchor — §7). The leaves
// resolve to Map<id, matched_at|null>; the combinators compose both the sets and
// the times. See docs/selector.md §5, §7, §14.
//
//   filter = clause | { all: [filter…] } | { any: [filter…] } | { not: filter }
//   clause = { fact: { <key>: { <op>: <value> } } } | { metric: { … } }
//
// matched_at provenance:
//   · fact   → exact (value row / qualifying event observed_at)
//   · metric → the threshold-crossing time for a monotone `gte` (the first row
//              at which the running aggregate reached the bound). `lte` and
//              recency_days have no crossing and stay null — un-windowed
//              membership only; see §14 and metric.evaluateTimed.
//   · not / empty / universe → null (an absence has no single event)

// ── Map<id, time> combinators ───────────────────────────────────────────────
const mapNull = ids => { const m = new Map(); for (const id of ids) m.set(id, null); return m }

// `all`: the composite anchor is the LATEST positive leaf time (when every
// condition was finally met). Null-propagating — if any positive leaf's time is
// unknown (an lte metric, a recency gate), the composite can't be a clean
// anchor → null.
const combineAll = (x, y) => (x == null || y == null) ? null : (x >= y ? x : y)
// `any`: the EARLIEST branch that qualified (first time any path matched).
const combineAny = (x, y) => (x == null) ? y : (y == null) ? x : (x <= y ? x : y)

function intersectTimed(a, b) {
  const out = new Map()
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const k of small.keys()) if (big.has(k)) out.set(k, combineAll(a.get(k), b.get(k)))
  return out
}
function differenceTimed(a, bKeys) {        // a minus the keys present in map b
  const out = new Map()
  for (const [k, v] of a) if (!bKeys.has(k)) out.set(k, v)
  return out
}
function unionTimed(maps) {
  const out = new Map()
  for (const m of maps) for (const [k, v] of m) out.set(k, out.has(k) ? combineAny(out.get(k), v) : v)
  return out
}

// ── clause validation ───────────────────────────────────────────────────────
// A clause node carries EXACTLY ONE of these. The dispatch below is an ordered
// if-chain, so a node holding two of them would silently evaluate the first and
// discard the rest — `{ fact, metric }` applied only `fact`, and the grouped path
// (resolveGroup) applied only `metric`, i.e. the same input produced two
// different half-answers depending on the projection. Neither erred.
//
// Rejecting rather than composing is deliberate: `{ fact, metric }` has no
// unambiguous meaning to infer. AND is already spelled `{ all: [...] }`, and
// guessing on the caller's behalf is how the silent behaviour arose.
const CLAUSE_KEYS = ['all', 'any', 'not', 'fact', 'metric']

function assertClause(node) {
  const keys = Object.keys(node)
  const unknown = keys.filter(k => !CLAUSE_KEYS.includes(k))
  if (unknown.length) {
    throw new Error(`selector.filter: unknown key "${unknown[0]}" (allowed: ${CLAUSE_KEYS.join('/')})`)
  }
  if (keys.length > 1) {
    throw new Error(
      `selector.filter: a clause takes exactly one of ${CLAUSE_KEYS.join('/')} — got ${keys.join(' + ')}. ` +
      `Combine them explicitly: { all: [${keys.map(k => `{ ${k}: … }`).join(', ')}] }.`,
    )
  }
  if (keys.length === 0) throw new Error(`selector.filter: empty clause ${JSON.stringify(node)}`)
}

// ── timed evaluation ────────────────────────────────────────────────────────
async function evalTimed(node, ctx) {
  if (!node) return mapNull(await ctx.universe())                 // empty filter ⇒ everyone in scope
  assertClause(node)
  if (node.all) return evalAllTimed(node.all, ctx)
  if (node.any) return unionTimed(await Promise.all(node.any.map(c => evalTimed(c, ctx))))
  if (node.not) return differenceTimed(mapNull(await ctx.universe()), await evalTimed(node.not, ctx))
  if (node.fact) return evalFact(node.fact, ctx)
  return metric.evaluateTimed(ctx.db, node.metric, { at: ctx.at, scope: ctx.scope, anchors: ctx.anchors })
}

// `all` with a positive anchor: intersect the positives (compositing the latest
// time), then subtract each `not`. Only a *pure*-negative `all` falls back to the
// universe (§5 — flagged as a full scan by ctx.universe).
async function evalAllTimed(children, ctx) {
  const positives = children.filter(c => !c.not)
  const negatives = children.filter(c => c.not)
  let set = positives.length
    ? (await Promise.all(positives.map(c => evalTimed(c, ctx)))).reduce(intersectTimed)
    : mapNull(await ctx.universe())
  for (const neg of negatives) set = differenceTimed(set, await evalTimed(neg.not, ctx))
  return set
}

async function evalFact(factObj, ctx) {
  const entries = Object.entries(factObj)
  if (entries.length !== 1) throw new Error('selector.filter: a `fact` clause takes exactly one key')
  const [key, predicate] = entries[0]
  const rows = await facts.matchesTimed(key, predicate, { at: ctx.at, scope: ctx.scope })
  const m = new Map()
  for (const r of rows) m.set(r.id, r.matched_at ?? null)
  return m
}

// ── public API ──────────────────────────────────────────────────────────────
// evaluateTimed → Map<id, matched_at|null>; evaluate → just the id array (the
// membership view, for callers that don't need anchors).
export async function evaluateTimed(node, ctx) {
  return evalTimed(node, ctx)
}
export async function evaluate(node, ctx) {
  return [...(await evalTimed(node, ctx)).keys()]
}
