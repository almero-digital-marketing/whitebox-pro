# Journeys Plugin

> Multi-step, trigger-driven customer automation: when a passport does X, wait,
> send, branch, notify externally, and repeat. The behavioral counterpart to
> the **Campaigns** plugin's one-shot, human-scheduled sends.

## What it is

A journey has a **trigger** (what enrolls a passport) and a **step graph**
(what happens to them once enrolled). Steps are `trigger_campaign`,
`wait`, `branch`, `set_fact`, `add_to_list`, `webhook`, and `exit`.

This plugin is a **thin orchestration layer** over plugins that already
exist — it never reimplements sending, targeting, or consent/suppression. A
step doesn't carry its own message content:

- `trigger_campaign` calls the **Campaigns** plugin's
  `activateForPassport()` — one campaign's content (channel + message),
  triggered for the enrolled passport. Campaigns owns the actual send (its
  own gated `mail`/`sms` `queueSend()` calls, suppression/invalid-address
  checks inherited for free) and the per-customer activation is independent
  of that campaign's own bulk schedule/lock lifecycle.
- `branch` conditions and audience-based triggers call into the
  **audiences** plugin's service (`resolveAudience`) and the core
  **selector** engine (`resolve`) — never a bespoke query language.
- `set_fact` writes through the core **facts** module — only whitebox-native
  facts, never an ad hoc external label.
- `add_to_list` calls the **audiences** plugin's `addToList()`, writing the
  same membership row the People browser writes by hand. Only *static list*
  segments are valid targets: the other segment sources are queries whose
  membership is recomputed on every resolve, so an "addition" to one would be
  undone by the next sweep. The call is idempotent, so a step re-run after a
  crash is a no-op rather than an error.
- `webhook` steps fire through the core **webhooks** module (HMAC-signed).

**Webhook steps are deliberately dumb.** A `webhook` step reports an
*objective* fact — "passport X reached step Y in journey Z" — to a
configured URL, and does not wait for or react to anything the receiver
does. Whitebox has no concept of any business meaning ("VIP", "at risk",
whatever) an external system might attach to that notification; it only
ever reports what actually happened on its own side.

## Triggers

Every journey configures exactly one automatic trigger:

- **Event** — enroll when a named internal event fires (anything already
  published via another plugin's `notify()` — `mail.sent`, `sms.replied`,
  `awareness.recorded`, …).
- **Audience** — enroll when a passport matches an Audience. Backed by a
  debounced reactive recheck (fast path) plus a required periodic full
  sweep (catches passports whose match came from a fact write with no
  matching awareness exposure — the reactive path's known blind spot).

**Manual enrollment is not a third trigger kind.** Every journey, regardless
of its configured automatic trigger, can always be enrolled into directly —
`POST /:id/enroll` or the `journeys_enroll` MCP tool — since `service.enroll()`
never reads `trigger` at all. That consumer (whoever calls the endpoint) is
outside this plugin's scope.

## Goal — did it work?

A journey may carry a **goal**: the event(s) that count as success, and
optionally a window in days.

```jsonc
{ "goal": { "event": ["conversions.purchase"], "window_days": 14 } }
```

The window runs from **each enrollment's own `enrolled_at`**, not a calendar
range — someone who enrolled yesterday still has their whole window ahead while
someone from last month has spent theirs. That's why it's expressed in days, and
why the goal is measured per enrollment rather than as one cohort query.

`GET /:id/results` reports the whole picture: the enrollment split (in-flight vs
completed/exited/failed), what the journey caused each channel to send —
attributed by `journey_id` on the outbox rows — and how many enrollments went on
to hit the goal. A journey with no goal still reports its enrollments; it just
can't say whether they mattered (`goal_met` is `null`).

## HTTP

| method | path | auth | notes |
|---|---|---|---|
| `GET` | `/journeys` | read | `?q` `?limit` `?offset` → `{total, rows}` — **paged**; `q` is a contains on `name` |
| `POST` | `/journeys` | write | create |
| `GET` | `/journeys/:id` | read | one journey |
| `PATCH` | `/journeys/:id` | write | edit — see the lifecycle rules below |
| `DELETE` | `/journeys/:id` | write | |
| `POST` | `/journeys/:id/activate` | write | |
| `POST` | `/journeys/:id/pause` | write | |
| `POST` | `/journeys/:id/enroll` | write | manual enrollment, always available |
| `GET` | `/journeys/:id/enrollments` | read | `?status` `?limit` `?offset` |
| `GET` | `/journeys/:id/step-counts` | read | per-step enrollment counts, for the canvas badges |
| `GET` | `/journeys/:id/results` | read | the funnel above |
| `GET` | `/journeys/enrollments/:enrollmentId` | read | one enrollment + its step runs |
| `POST` | `/journeys/enrollments/:enrollmentId/exit` | write | pull someone out |

## Lifecycle

```
draft (editable) → active (running) ⇄ paused (no new enrollments) → archived
```

Editing the trigger or step graph is only allowed in `draft`/`paused` —
pause an active journey first. An enrollment's own lifecycle is
`active → waiting (during a wait step) → completed | exited | failed`,
with every step execution recorded in an append-only audit log
(`whitebox_journey_step_runs`) — a discipline Campaigns' own `insertSend()`
never got wired up to, and one this plugin is built not to repeat.

## Docs

See `docs/09-api.md`-style REST/MCP reference (TODO once the API surface
stabilizes) and the plugin's own inline comments — `src/executor.js`'s
header in particular explains the crash-safety and idempotency guarantees
of the step executor.
