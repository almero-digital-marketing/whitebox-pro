// Shared source-selector grammar (about / filter / judge, or a funnel + slot).
// The engine (ctx.selector) does all the selection; segments.js (a saved
// selector source, minus delivery/lifecycle) reuses this exact grammar.

import { z } from 'zod'

// The selector is validated deeply by the engine; here we only bound the
// envelope and require the rule to actually narrow (an empty selector would mean
// "everyone", never what an audience wants).
// Exported so the segment source schema (segments.js) reuses the exact same
// selector / funnel / slot grammar — a segment is a rule's source minus delivery.
export const Selector = z.object({
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

// A funnel source: ordered windowed steps (resolved by the engine), then a slot.
const FunnelStep = z.object({
  select: z.union([z.string(), Selector]),   // a named ref or an inline selector
  within: z.string().optional(),
  name: z.string().optional(),
}).passthrough()
export const Funnel = z.object({
  within: z.string().optional(),
  steps: z.array(FunnelStep).min(1),
}).passthrough()

// "step:N" | "gap:N→M" — the funnel slot selector.
export const SLOT_RE = /^(step:\d+|gap:\d+→\d+)$/
