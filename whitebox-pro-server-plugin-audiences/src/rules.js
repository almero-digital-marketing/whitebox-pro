// Rule schema + validation. A rule is a saved audience: a `select` (a core
// selector — about / filter / judge) plus delivery + lifecycle. The engine
// (ctx.selector) does all the selection; this plugin just stores the selector,
// resolves it, and activates the cohort. See docs/03-rules.md.

import { z } from 'zod'

// The selector is validated deeply by the engine; here we only bound the
// envelope and require the rule to actually narrow (an empty selector would mean
// "everyone", never what an audience wants).
const Selector = z.object({
  about:  z.union([z.string(), z.object({}).passthrough()]).optional(),
  filter: z.any().optional(),
  judge:  z.object({
    criteria:   z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
  }).passthrough().optional(),
}).passthrough().refine(
  s => s.about != null || s.filter != null || s.judge != null,
  'select needs at least one of about / filter / judge',
)

const Delivery = z.object({
  // Mode A only in v1: fire a custom event; the platform builds the audience.
  event: z.string(),
  mode: z.literal('event').default('event'),
}).partial({ mode: true })

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'id must be snake_case'),
  name: z.string().min(1),
  enabled: z.boolean().default(false),

  select: Selector,                 // the core selector — the whole selection predicate

  ttl_days: z.number().int().positive().default(30),
  policy: z.enum(['non_sensitive', 'unrestricted']).default('non_sensitive'),

  // One entry per target network: { meta:{event}, tiktok:{event}, google:{event} }
  delivery: z.record(z.enum(['meta', 'tiktok', 'google']), Delivery).default({}),
}).strict()

export function validate(input) {
  const parsed = RuleSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid rule: ${msg}`)
    err.status = 400
    throw err
  }
  return parsed.data
}

// Serialize jsonb columns for the store; the store expects plain values. The DB
// column is `selector` (SELECT is a reserved word); the rule field is `select`.
export function toRow(rule, updatedBy) {
  return {
    id: rule.id, name: rule.name, enabled: rule.enabled,
    selector: JSON.stringify(rule.select),
    ttl_days: rule.ttl_days, policy: rule.policy,
    delivery: JSON.stringify(rule.delivery),
    updated_by: updatedBy || null,
  }
}

export const fromRow = row => row && ({
  id: row.id, name: row.name, enabled: row.enabled,
  select: typeof row.selector === 'string' ? JSON.parse(row.selector) : row.selector,
  ttl_days: row.ttl_days, policy: row.policy,
  delivery: typeof row.delivery === 'string' ? JSON.parse(row.delivery) : row.delivery,
  updated_at: row.updated_at, updated_by: row.updated_by,
})
