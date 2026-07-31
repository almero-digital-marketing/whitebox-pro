// Journey schema + validation. A journey is a trigger + a step graph — see
// docs/README.md for the concept. This module only validates the shape;
// service.js owns persistence and lifecycle rules.

import { z } from 'zod'

// --- trigger ---
// Every journey configures exactly one AUTOMATIC trigger — event or audience.
// Manual enrollment is NOT a third trigger kind here: it's an always-available
// capability independent of this config, exercised via POST /:id/enroll or
// the journeys_enroll MCP tool regardless of what a journey's trigger is set
// to (service.enroll() never reads `trigger` at all) — see triggers.js.
// `event` is an array — a journey can react to any one of several event
// names (picked via toggles in the UI from the observed event registry, see
// server/src/event-registry). Not validated against that registry here: it's
// empirically built and retention-pruned, so a legitimate event type that
// simply hasn't fired recently must stay configurable. Deliberately allowed
// to be empty — a freshly created journey starts with nothing picked yet
// (same "starts genuinely incomplete until configured" shape as a new
// Audience/Campaign), not a fake placeholder value; an empty array just
// never matches any incoming event, so it can't fire until it's filled in.
// `audience_ids` is likewise an array (a journey can react to several
// audiences), combined per `op` — 'any' (union: in at least one) or 'all'
// (intersection: in every one) — the exact same op/any/all vocabulary the
// Audiences module already uses for its own segment rule combinator.
export const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.array(z.string().min(1)) }).strict(),
  z.object({
    kind: z.literal('audience'),
    audience_ids: z.array(z.string().uuid()),
    op: z.enum(['any', 'all']).default('any'),
  }).strict(),
])

// --- dedupe ---
export const Dedupe = z.object({
  reenroll: z.boolean().default(false),
  cooldown_days: z.number().int().positive().nullable().default(null),
}).strict()

// --- goal ---
// What the journey is FOR, so its results can say more than "people moved
// through steps". Events only for now, and deliberately the same discriminated
// shape as Trigger above: a condition-based goal ({ filter }) can join as a
// second kind later without changing anything that reads this one.
//
// window_days null means "ever after enrolling" — no upper bound. It's a
// window from EACH enrollment's own enrolled_at, not a fixed calendar range,
// which is why the goal is measured per enrollment rather than as one cohort.
export const Goal = z.object({
  event: z.array(z.string().min(1)).min(1),
  window_days: z.number().int().positive().nullable().default(null),
}).strict()

// --- per-kind step config ---
const StepConfig = {
  trigger_campaign: z.object({
    campaign_id: z.string().uuid(),
  }).strict(),

  // duration_ms is one combined total, not a {minutes,hours,days} breakdown —
  // the UI's separate Minutes/Hours/Days fields are purely a convenient way
  // to compose (and re-split, on load) that single value; nothing downstream
  // needs to know which units the person actually typed into.
  wait: z.object({
    duration_ms: z.number().int().positive().optional(),
    until: z.string().datetime().optional(),
  }).strict().refine(c => !!(c.duration_ms || c.until), 'wait needs `duration_ms` or `until`'),

  // Exactly one of three: an audience membership check, a deterministic
  // fact/activity filter, or `judge` — an LLM verdict on one person.
  //
  // `judge` was deliberately excluded when this shipped, on the grounds that it
  // would make branch evaluation expensive and unpredictable "regardless of
  // enrollment volume". That reasoning was inherited from AUDIENCES, where it is
  // right: an audience runs the judge across every candidate the deterministic
  // stages left, and re-resolves on a schedule — which is why the selector has a
  // whole preview/cost-estimate path (`calls`, `estLatencyMs`) before you save one.
  //
  // A branch is a different shape. It resolves with `scope: [one passport]`, so
  // it is one verdict, once, when that enrollment reaches the node — cost is
  // linear in traffic through a single step, not in population, and it does not
  // recur. The step already tolerates far more expensive work on the same path:
  // `trigger_campaign` sends a real email.
  //
  // What the cheap stages DID buy is determinism, and that is genuinely given up
  // here: the same person can branch differently on a re-run. The verdict
  // (match/score/reason) is therefore recorded in the step run — see runBranch.
  branch: z.object({
    condition: z.object({
      filter: z.any().optional(),
      audience_id: z.string().uuid().optional(),
      judge: z.object({
        // The question, as a rule the model decides a person against.
        criteria: z.string().min(1),
        // Below this the verdict counts as "no". Bounded here but NOT defaulted
        // here: StepConfig is validated inside StepsGraph's superRefine, which
        // reports issues and throws the parsed value away, so a `.default()` on
        // this field would never reach the stored config — it would read as a
        // guarantee while doing nothing. The one real default lives where the
        // comparison happens (selector.judge.evaluate, 0.7), so a branch and an
        // audience cannot drift apart.
        confidence: z.number().min(0).max(1).optional(),
      }).strict().optional(),
    }).strict().refine(
      c => [c.filter, c.audience_id, c.judge].filter(Boolean).length === 1,
      'branch condition needs exactly one of `filter`, `audience_id` or `judge`',
    ),
  }).strict(),

  set_fact: z.object({
    key: z.string().min(1),
    value: z.any(),
    type: z.string().optional(),
  }).strict(),

  // Put the enrolled passport on a STATIC LIST segment. Only lists are valid
  // targets — a query segment recomputes its membership from a predicate, so
  // adding someone to one would be undone by the next resolve. The audiences
  // service enforces that; this only carries the id.
  add_to_list: z.object({
    segment_id: z.string().uuid(),
  }).strict(),

  // Every method core's webhook sender can deliver. GET and HEAD go out
  // without a body (see server/src/webhooks.js's BODYLESS) — legal, and the
  // step editor greys out the payload field for them rather than letting you
  // fill in something that would be silently dropped.
  webhook: z.object({
    url: z.string().url(),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).default('POST'),
    headers: z.record(z.string(), z.string()).optional(),
    payload: z.record(z.string(), z.any()).optional(),
    secret: z.string().optional(),
  }).strict(),

  exit: z.object({
    reason: z.string().optional(),
  }).strict(),
}

const KINDS = Object.keys(StepConfig)

// --- step graph ---
const NodeSchema = z.object({
  kind: z.enum(KINDS),
  config: z.any(),
  position: z.object({ x: z.number(), y: z.number() }).strict().default({ x: 0, y: 0 }),
  label: z.string().optional(),
  next: z.string().nullable().optional(),
  on_true: z.string().nullable().optional(),
  on_false: z.string().nullable().optional(),
}).strict().superRefine((node, ctx) => {
  const parsed = StepConfig[node.kind].safeParse(node.config)
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: `invalid config for "${node.kind}": ${parsed.error.issues.map(i => i.message).join('; ')}` })
  }
  if (node.kind === 'branch') {
    if (!node.on_true || !node.on_false) ctx.addIssue({ code: 'custom', message: 'branch needs both on_true and on_false' })
  } else if (node.kind !== 'exit' && !node.next) {
    ctx.addIssue({ code: 'custom', message: `"${node.kind}" needs \`next\`` })
  }
})

// Cycles are NOT rejected — a branch looping back through a wait step is a
// legitimate "retry until audience matches" pattern, not a malformed graph.
export const StepsGraph = z.object({
  entry: z.string(),
  nodes: z.record(z.string(), NodeSchema),
}).strict().superRefine((graph, ctx) => {
  if (!graph.nodes[graph.entry]) {
    ctx.addIssue({ code: 'custom', message: `entry "${graph.entry}" is not a node in this graph` })
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const ref of [node.next, node.on_true, node.on_false]) {
      if (ref && !graph.nodes[ref]) {
        ctx.addIssue({ code: 'custom', message: `node "${id}" references unknown step "${ref}"` })
      }
    }
  }
})

export const JourneyInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  trigger: Trigger.optional(),
  steps: StepsGraph.optional(),
  dedupe: Dedupe.optional(),
  goal: Goal.nullish(),
}).strict()

export function validate(input) {
  const parsed = JourneyInput.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid journey: ${msg}`)
    err.status = 400
    throw err
  }
  return parsed.data
}

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined

export const fromRow = row => row && {
  id: row.id,
  name: row.name,
  status: row.status,
  trigger: p(row.trigger),
  steps: p(row.steps),
  dedupe: p(row.dedupe) ?? { reenroll: false, cooldown_days: null },
  goal: p(row.goal) ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
}

export const fromEnrollmentRow = row => row && {
  id: row.id,
  journey_id: row.journey_id,
  passport_id: row.passport_id,
  status: row.status,
  current_step_id: row.current_step_id,
  context: p(row.context) ?? {},
  next_action_at: row.next_action_at,
  enrolled_at: row.enrolled_at,
  completed_at: row.completed_at,
  exited_at: row.exited_at,
  exit_reason: row.exit_reason,
}

export const fromStepRunRow = row => row && {
  id: row.id,
  enrollment_id: row.enrollment_id,
  journey_id: row.journey_id,
  step_id: row.step_id,
  kind: row.kind,
  result: p(row.result),
  ran_at: row.ran_at,
}

// A journey's trigger/steps/dedupe are only editable while draft or paused —
// an active journey must be paused first (in-flight enrollments' current
// step ids would otherwise reference a graph that's shifting under them).
export const isEditable = journey => journey?.status === 'draft' || journey?.status === 'paused'
