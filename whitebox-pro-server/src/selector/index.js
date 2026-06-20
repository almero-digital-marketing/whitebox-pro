import * as filter from './filter.js'
import * as judge from './judge.js'

// The selector engine — resolve a `{ about, filter, judge }` predicate into a
// projection. See docs/selector.md.
//
// So far: the `people` projection, with `about` (semantic narrow → candidate
// gate) → `filter` (the deterministic boolean tree of fact + metric clauses) →
// `judge` (LLM predicate). `preview()` makes the judge's cost visible before you
// run/save (§9). The `knowledge` projection and funnels land in later increments.

let db
let logger
let passports        // reserved: scope/merge resolution as the engine grows
let awareness        // injected — the semantic memory (about → population, judge evidence → recall)
let ai               // injected — the LLM behind judge
let defaults

export function init(deps) {
  db = deps.db
  passports = deps.passports
  awareness = deps.awareness
  ai = deps.ai
  logger = deps.logger.child({ component: 'selector' })
  const cfg = deps.config?.selector ?? {}
  defaults = {
    candidateSimilarity: cfg.candidateSimilarity ?? 0.72,
    candidateLimit: cfg.candidateLimit ?? 2000,
    previewSample: cfg.previewSample ?? 20,      // §9 — judge sample size for preview
    confirmCap: cfg.confirmCap ?? 5000,          // §9 — survivors above this need explicit confirm
    judgeConcurrency: cfg.judgeConcurrency ?? 6, // matches judge.evaluate's default
    judgeMsPerCall: cfg.judgeMsPerCall ?? 1200,  // coarse per-call latency for the estimate
  }
}

// resolve(selector, { projection, scope, asOf }) → result
//   projection: "people"           (knowledge comes later)
//   scope:      array of passport ids | undefined (whole base)
//   asOf:       a point in time     (applies to the deterministic filter; `about`
//               is a now-relative semantic narrow)
export async function resolve(selector = {}, opts = {}) {
  const { projection = 'people' } = opts
  if (projection !== 'people') throw new Error(`selector: projection "${projection}" not implemented yet`)

  const { candidateIds } = await narrow(selector, opts)

  // `judge` — the LLM predicate, last, on the already-narrowed candidates only
  // (cost is bounded by about + filter). Confirmed survivors carry score + why.
  if (selector.judge) {
    const survivors = await judge.evaluate(candidateIds, selector.judge, {
      ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: defaults.judgeConcurrency,
    })
    return { count: survivors.length, passports: survivors.map(s => ({ id: s.id, why: s.reason, score: s.score })) }
  }

  return { count: candidateIds.length, passports: candidateIds.map(id => ({ id })) }   // matched_at (funnels) lands later
}

// preview(selector, { projection, scope, asOf }) → cost metadata, NO commitment.
// Runs the same deterministic funnel `resolve` would (so "what you preview == what
// gets delivered" by construction), then — instead of judging everyone — reports
// the counts and *samples* the judge on ~20 survivors. All cheap; the only LLM
// work is the bounded sample. See docs/selector.md §9 (S4).
export async function preview(selector = {}, opts = {}) {
  const { projection = 'people' } = opts
  if (projection !== 'people') throw new Error(`selector: projection "${projection}" not implemented yet`)

  const { candidateIds, aboutCohort, fullScan } = await narrow(selector, opts)
  const survivors = candidateIds.length      // = exactly the judge-call count of a full run

  const out = {
    projection,
    about: aboutCohort == null ? null : { cohort: aboutCohort },
    filter: { survivors },
    fullScan,                                 // §5 — no anchor ⇒ this scanned everyone
    confirmCap: defaults.confirmCap,
    confirmRequired: survivors > defaults.confirmCap,
    judge: null,
  }

  // Sample the judge on a bounded slice → projected qualifying rate + a few real
  // reasons. No selector.judge ⇒ the deterministic survivors *are* the audience.
  if (selector.judge) {
    const sample = candidateIds.slice(0, Math.min(defaults.previewSample, survivors))
    const matched = await judge.evaluate(sample, selector.judge, {
      ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: defaults.judgeConcurrency,
    })
    const rate = sample.length ? matched.length / sample.length : 0
    out.judge = {
      calls: survivors,                       // a full run makes this many judge calls
      sample: sample.length,
      qualifyingRate: rate,
      projectedMatches: Math.round(rate * survivors),
      reasons: matched.map(m => m.reason).filter(Boolean).slice(0, 3),
      estLatencyMs: Math.ceil(survivors / defaults.judgeConcurrency) * defaults.judgeMsPerCall,
    }
  }
  return out
}

// The shared deterministic funnel: scope → about (semantic gate) → filter (the
// boolean tree). Both resolve and preview run exactly this, so they can never
// disagree about who the judge sees. Returns the candidate ids plus the metadata
// preview reports (`aboutCohort`, `fullScan`).
async function narrow(selector, { scope, asOf } = {}) {
  const at = asOf ? new Date(asOf) : null
  let scopeArr = scope == null ? null : [].concat(scope)
  let aboutCohort = null

  // `about` — semantic narrow → candidate gate. Everyone whose memory clears the
  // similarity floor; intersected with any caller scope. Runs first (cheap-ish),
  // narrowing what the filter then has to gate.
  if (selector.about != null) {
    const cands = await aboutGate(selector.about)
    const candSet = new Set(cands)
    scopeArr = scopeArr ? scopeArr.filter(id => candSet.has(id)) : cands
    aboutCohort = scopeArr.length
  }

  // `fullScan` is set iff the filter actually scanned the whole population — i.e.
  // ctx.universe() did a real DB read because there was no scope/about bound and
  // no positive anchor (empty/pure-negative filter). A bounded scan inside an
  // about cohort or caller scope is not a full scan.
  let universeCache
  let fullScan = false
  const ctx = {
    at,
    scope: scopeArr,
    db,                          // metric clauses aggregate the awareness exposure stream
    universe: async () => {
      if (scopeArr) return scopeArr
      fullScan = true
      if (!universeCache) {
        logger.warn('selector: full passport scan (filter has no positive anchor)')
        universeCache = (await db('whitebox_passports').select('id')).map(r => r.id)
      }
      return universeCache
    },
  }

  const candidateIds = await filter.evaluate(selector.filter, ctx)
  return { candidateIds, aboutCohort, fullScan }
}

// Evidence handed to the judge for one candidate: the about-recalled chunks
// (or, with no about, recall on the criteria itself).
async function evidenceFor(id, selector) {
  if (!awareness?.recall) return []
  const about = selector.about
  const query = (typeof about === 'string' ? about : about?.query) || selector.judge.criteria
  const hits = await awareness.recall({ passport_id: id, query, limit: 10 })
  return Array.isArray(hits) ? hits : (hits?.data || [])
}

// `about` as a people gate: a similarity floor over the semantic memory →
// candidate passport ids. `about` may be a string, or `{ query, similarity?, limit? }`.
async function aboutGate(about) {
  if (!awareness?.population) throw new Error('selector: `about` requires the awareness module (population)')
  const query = typeof about === 'string' ? about : about?.query
  if (!query) throw new Error('selector: `about` needs a query string')
  const similarity = (typeof about === 'object' ? about.similarity : undefined) ?? defaults.candidateSimilarity
  const limit = (typeof about === 'object' ? about.limit : undefined) ?? defaults.candidateLimit
  const res = await awareness.population({ query, similarity, limit })
  return (res?.passports || []).map(p => p.passport_id)
}
