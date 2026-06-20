// Evaluator — now a thin adapter over the core selector engine (ctx.selector).
// The engine owns ALL selection (about → filter → judge over the two memories);
// this module just maps a rule's saved `select` onto it. The old bespoke feature
// families (semantic / metric / crm) and the LLM judge are gone — they were a
// re-implementation of exactly this funnel. See docs/04-evaluator.md.

import { z } from 'zod'

// A drafted rule (audiences_draft_rule): the LLM proposes a selector-shaped rule.
const DRAFT = z.object({
  name: z.string(),
  select: z.object({
    about: z.string().optional(),
    judge: z.object({
      criteria: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }).optional(),
  }),
})

let selector, ai, db, logger

export function init(deps) {
  selector = deps.selector
  ai = deps.ai
  db = deps.db
  logger = deps.logger
}

const verdict = (qualified, score, reason, evidence) => ({ qualified, score, reason, evidence })

// The rule's cohort — everyone the selector resolves (people projection).
export async function candidates(rule) {
  const res = await selector.resolve(rule.select, { projection: 'people' })
  return res.passports.map(p => p.id)
}

// Membership of ONE passport: a scoped population resolve. The engine runs the
// same about → filter → judge funnel against just this passport, so per-passport
// (dirty) evaluation reuses the engine with zero duplicate logic.
export async function evaluate(rule, passportId) {
  const res = await selector.resolve(rule.select, { projection: 'people', scope: [passportId] })
  const hit = res.passports.find(p => p.id === passportId)
  if (!hit) return verdict(false, 0, 'did not match the selector', {})
  return verdict(true, hit.score ?? 1, hit.why ?? 'matched the selector', { matched_at: hit.matched_at })
}

// Cost preview — straight from the engine's preview (cohort, judge-call count,
// sampled qualifying rate + reasons, full-scan flag). Never fires.
export async function preview(rule /*, { sample } */) {
  const p = await selector.preview(rule.select, {})
  return {
    candidate_pool: p.filter.survivors,
    est_matches: p.judge ? p.judge.projectedMatches : p.filter.survivors,
    sampled: p.judge?.sample ?? 0,
    full_scan: p.fullScan,
    confirm_required: p.confirmRequired,
    sample_reasons: p.judge?.reasons ?? [],
  }
}

// Fact keys the base has — for rule authoring + discovery (was a bespoke cache;
// now read straight from core facts).
export async function availableFacts() {
  const rows = await db('whitebox_facts').distinct('key').orderBy('key')
  return rows.map(r => ({ key: r.key }))
}

// Draft a selector-shaped rule from a natural-language description.
export async function draftRule(description) {
  const system = `Turn a marketer's audience description into a draft audience rule.
- "name": a short human label.
- "select.about": a few comma-separated topics for a semantic search (omit if purely structural).
- "select.judge.criteria": one precise sentence the AI judges membership against (omit if purely structural).
- "select.judge.confidence": 0..1 (default 0.7).
Return only the fields you're confident about; structural fact/metric filters are added by hand after.`
  return ai.object(system, description, DRAFT)
}
