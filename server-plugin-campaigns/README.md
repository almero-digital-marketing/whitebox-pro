# Campaigns Plugin

> Plan & execute email/SMS campaigns to audiences. Mikser upserts campaign content from outside
> (by `external_id`); the UI attaches audiences and schedules. All cohort resolution and consent
> gating is reused from the **Audiences** plugin — campaigns never reimplements it.

## What it is

A campaign is a planned email or SMS send to a set of audiences. There are two ways content gets
into a campaign, tracked by `source`:

- **Mikser** (`source: 'mikser'`) — an external system upserts the campaign's content
  (`name`/`channel`/`subject`/`scheduled_at`/`message`) by a stable `external_id`, idempotently
  (`PUT /campaigns/upsert`). Mikser owns content; it never touches audience bindings.
- **UI** (`source: 'ui'`) — a campaign is created directly (`POST /campaigns`), then edited in
  place (`PATCH /campaigns/:id`).

Either way, the **UI owns the audience binding** (a many-to-many attach/detach — a campaign can
target several audiences, recipients are the de-duped union) and **commits the schedule**
(`POST /campaigns/:id/schedule`).

Audience resolution, reach counting, and consent/suppression gating are never reimplemented here —
every one of those calls is delegated to the **audiences plugin's service**
(`ctx.plugins.audiences.service`, or an injected override via the `audiences` option): `getAudience`,
`resolveAudience`, `previewCohort`, `deliverableCohort`. This plugin **must be registered after
audiences** — see [Cross-plugin dependency](#cross-plugin-dependency-audiences).

Executing a campaign (`schedule`) **locks** it and stamps real `stats`; a sent campaign can later
have an Analytics performance report linked to it (`report_id`).

## Campaign shape

```jsonc
// GET /campaigns/:id
{
  "id": "5c9e…",
  "external_id": "mikser-post-1234",     // present only for source: 'mikser'
  "source": "mikser",                    // 'ui' | 'mikser'
  "name": "July Newsletter",
  "channel": "email",                    // 'email' | 'sms'
  "subject": "July highlights",
  "scheduled_at": "2026-07-25T09:00:00Z",
  "status": "scheduled",                 // draft | scheduled | sent
  "message": { "html": "<html>…</html>", "published_at": "2026-07-21T12:00:00Z" },
  "objective": { "goals": ["Bookings", "Revenue"], "notes": "Push the August sale" },
  "stats": { "resolved": 4200, "suppressed": 80, "no_consent": 140, "reach": 3980, "dry_run": true },
  "analytics_prompt": null,              // null ⇒ server derives one from objective (see below)
  "report_id": null,
  "sent_at": null,
  "audiences": [{ "id": "aud_1", "name": "Lapsed pro users", "size": 3980 }],
  "created_at": "2026-07-01T10:00:00Z",
  "updated_at": "2026-07-21T09:00:00Z"
}
```

`GET`/schedule/attach responses include a live-resolved `audiences` list and an `analytics_prompt`.
If none was set explicitly, `getCampaign` builds a default one from the campaign's `objective`
(goals + notes), channel, audience names, and — once sent — its actual recipient count (see
`defaultPrompt()` in `src/service.js`). Setting `analytics_prompt` explicitly overrides the default.

Two schemas validate input (`src/campaigns.js`), deliberately different:

| | `CampaignInput` (UI: create/patch) | `UpsertInput` (Mikser upsert) |
|---|---|---|
| required to create | `name` + `channel` | `external_id` + `name` + `channel` |
| identity | `id` (server-assigned) | `external_id` (caller-assigned, the upsert key) |
| carries `objective` / `analytics_prompt` / `report_id` | yes | no — Mikser never sets these |
| audiences | not part of the payload — separate attach/detach calls | never — Mikser can't touch audiences |

A campaign is **locked** once `status` is `scheduled` or `sent` (`isLocked()` in `src/campaigns.js`).
Locked blocks: `PATCH`, attach/detach audience, and Mikser upsert — all fail with `409 campaign is
locked (already sent)`.

## The campaign lifecycle

```
draft ──schedule()──▶ scheduled (locked) ──[due time / send worker]──▶ sent (locked, final)
  ▲                        │
  └──────unlock()──────────┘
```

- **draft** — editable: content (UI or Mikser), audience attach/detach, freely.
- **scheduled** — committed by `schedule()`, **locked** for edits. Reached when `scheduled_at` is
  still in the future at schedule time.
- **sent** — **locked, final**. Reached either because a scheduled campaign's due time arrived, or
  because `schedule()` was called when `scheduled_at` had *already passed* — in which case delivery
  fires **immediately** and the campaign goes straight from draft to `sent` (skipping `scheduled`
  entirely). As the source comment puts it: "you don't send from the UI — you schedule, and a past
  time is just due."

`schedule(id)` (`src/service.js`) refuses to run unless: it isn't already locked, at least one
audience is attached, the message is ready for the channel (`message.text` for `sms`,
`message.html` for `email`), and `scheduled_at` is set — each missing precondition is a distinct
`400` error.

**`unlockCampaign(id)`** is the escape hatch — but only in one direction: a **`scheduled`** campaign
can be pulled back to `draft` (clearing `sent_at` and `stats`; a previously linked `report_id` is
kept). A **`sent`** campaign can never be unlocked — it's delivered and final; the source is explicit:
`"a delivered campaign is final and can't be unlocked"` (`409`). Delete it instead if it needs to go
away.

## The dryRun safety switch

`dryRun` is a **whitebox config** option, **default ON** (`options.dryRun !== false` — you must pass
`dryRun: false` explicitly to arm live sending). It exists so a misconfigured or half-built campaign
can never blast real inboxes.

- **`dryRun: true` (default)** — `schedule()`'s delivery step records the *projected* reach as if it
  sent (`stats.sent = deliverable count, stats.dry_run: true`) but never calls the `deliver` hook.
- **`dryRun: false` + a wired `deliver` hook** — the only combination that actually sends. On a due
  campaign, campaigns resolves the consent-gated deliverable passport ids
  (`audiences.deliverableCohort`) across all attached audiences (de-duped union) and calls
  `deliver({ campaign, channel, subject, message, passportIds })`. The host wires this to its
  mail/sms plugins; its return value's `batch_id` (or `id`) is stamped into `stats.batch_id`.
- **`dryRun: false` but no `deliver` hook wired** — this is a misconfiguration. At plugin
  registration (`src/index.js`) it logs a startup warning: `"campaigns: dryRun is OFF but no
  \`deliver\` hook is wired — live sends will fail until the mail/sms delivery is configured"`. It
  does **not** crash the server — but any campaign that actually comes due will fail at send time
  with a `500`: `"live delivery is not configured — set campaigns.dryRun=true or wire the deliver
  hook"`.
- Setting `dryRun` only controls whether a **due** send actually goes out — a **future**
  `scheduled_at` always just records a projected reach (`stats.reach`, `stats.dry_run` reflecting
  the configured mode) regardless, since nothing is sent until it's due.

`dryRun` can be flipped at any time in config — it's read fresh at plugin registration, not baked
into stored campaigns.

## REST reference

Base path: `/campaigns`. `read`/`write` are the two auth tiers resolved from `campaigns.auth` via
`resolveReadWriteAuth()` (`whitebox-pro-server/auth`) — same static-secret / composed-verifier
pattern as other plugins. The split is by **mutation, not HTTP verb**: `/delivery/preview` is a
`POST` but never persists (a reach count), so it stays read-gated.

| method | path | tier | what it does |
|---|---|---|---|
| `PUT` | `/campaigns/upsert` | write | **Mikser only** — create-or-update by `external_id`, idempotent. Owns content, never audiences. |
| `GET` | `/campaigns` | read | list all campaigns |
| `POST` | `/campaigns` | write | UI: create a draft campaign |
| `GET` | `/campaigns/:id` | read | one campaign, + attached audiences (live size) + resolved `analytics_prompt` |
| `PATCH` | `/campaigns/:id` | write | UI: update a draft's fields — `409` if locked |
| `DELETE` | `/campaigns/:id` | write | delete |
| `GET` | `/campaigns/:id/audiences` | read | the attached audiences |
| `POST` | `/campaigns/:id/audiences` | write | attach an audience — `{ audience_id }` — `409` if locked |
| `DELETE` | `/campaigns/:id/audiences/:audienceId` | write | detach an audience — `409` if locked |
| `POST` | `/campaigns/:id/delivery/preview` | read | consent-gated reach of the attached audiences' union (never persists) |
| `POST` | `/campaigns/:id/schedule` | write | commit for delivery, **lock**. Fires immediately if `scheduled_at` has passed. Body may carry `{ counts }` to reuse a reach already previewed by the caller (skips a redundant cohort resolve). |
| `POST` | `/campaigns/:id/unlock` | write | pull a `scheduled` campaign back to `draft` — `409` if already `sent` |
| `POST` | `/campaigns/:id/report` | write | link an Analytics report — `{ report_id }` |

The Mikser upsert route is registered **before** `/:id` in `src/rest.js` (so `/upsert` doesn't get
swallowed by the `:id` param route) and is deliberately kept **separate from the UI create path**
(`POST /campaigns`): the UI creates a bare draft by name/channel that a person then fills in and
schedules; Mikser upserts *complete* content keyed on an external system's own id, in one call,
without ever creating or touching an audience binding.

## MCP reference

Registered on the shared MCP server only if the host wires one (`ctx.mcp`), behind
`config.mcp.auth.secret` (endpoint-level, like other plugins). Mirrors the REST surface, grouped as
in `src/mcp.js`:

### Inspect

| tool | purpose |
|---|---|
| `campaigns_list` | list all campaigns |
| `campaigns_get` | one campaign, with attached audiences (id, name, live size) and resolved `analytics_prompt` |
| `campaigns_delivery_preview` | of the attached audiences' consent-gated union, how many are actually reachable |

### Author (draft campaigns only — locked once scheduled/sent)

| tool | purpose |
|---|---|
| `campaigns_create` | create a draft campaign |
| `campaigns_update` | update a draft's fields — fails if locked (unlock first) |
| `campaigns_attach_audience` | attach an audience to a draft (many-to-many) — fails if locked |
| `campaigns_detach_audience` | detach an audience from a draft — fails if locked |

### Act (guarded)

| tool | purpose |
|---|---|
| `campaigns_schedule` | commit for delivery at `scheduled_at` and **lock**; fires immediately if already due. Obeys the server's configured `dryRun` — there is **no per-call override**. |
| `campaigns_unlock` | pull a `scheduled` (not yet sent) campaign back to draft; a `sent` campaign can't be unlocked |
| `campaigns_set_report` | link an Analytics report to a campaign |
| `campaigns_delete` | delete a campaign |

### The Mikser upsert path has no MCP equivalent — by design

`PUT /campaigns/upsert` is **intentionally not exposed** as an MCP tool. It's a specific
external-system integration path (Mikser pushing content by its own `external_id`), not a general
campaign-management action an agent should be able to trigger — an agent authors and manages
campaigns through `campaigns_create`/`campaigns_update`/schedule/unlock, never by impersonating
Mikser's upsert contract. (Comment straight from `src/mcp.js`: *"deliberately NOT exposed here —
it's a specific external-system integration path, not a general campaign-management action."*)

## Config

```js
import { audiences } from 'whitebox-pro-server-plugin-audiences'
import { campaigns } from 'whitebox-pro-server-plugin-campaigns'

export default async (runtime) => ({
  // ...
  plugins: [
    audiences({ /* ... */ }),   // MUST be registered before campaigns

    campaigns({
      // Bearer secret (or a composed verifier, or { read, write }) for the management REST
      // surface (/campaigns/*) and the MCP tools. Required — registration throws without it.
      auth: { secret: process.env.WB_CAMPAIGNS_TOKEN },

      // Optional override of the audiences service dependency. Defaults to
      // ctx.plugins.audiences.service (the host-wired audiences plugin) — you only need this
      // for tests or an alternate wiring.
      // audiences: someAudiencesService,

      // Safety switch — default true (dry-run: records projected reach, never sends). Set
      // false only once `deliver` below is wired and you're ready to send for real.
      dryRun: process.env.WB_CAMPAIGNS_DRY_RUN !== 'false',

      // Required for live sends (dryRun: false). Called only for a due, non-dry-run campaign;
      // wire it to your mail/sms plugins for the given channel.
      deliver: async ({ campaign, channel, subject, message, passportIds }) => {
        // return { batch_id } (or { id }) from your mail/sms provider's bulk-send call
      },
    }),
  ],
})
```

Permissions registered by this plugin (gate UI features / roles, not the REST auth above):

| key | label | description |
|---|---|---|
| `campaigns:read` | View Campaigns | View campaigns and their delivery status |
| `campaigns:write` | Edit Campaigns | Create, schedule, and send email/SMS campaigns |

`permissions.defaults` is empty — no role gets these by default; grant them explicitly in your role
config.

## Cross-plugin dependency: audiences

Campaigns never resolves cohorts or gates consent itself — it calls straight through to the
**audiences plugin's service**, injected by the host as `ctx.plugins.audiences.service` (or
overridden via the `audiences` factory option). The exact calls made (`src/service.js`):

| call | used for |
|---|---|
| `getAudience(id)` | resolving an attached audience's display `name` |
| `resolveAudience(id)` → `{ count, ids }` | live audience size (for display) and passport ids (for the union) |
| `previewCohort(ids)` → `{ resolved, suppressed, no_consent, deliverable }` | consent-gated reach of the de-duped union — powers both `/delivery/preview` and the projected `stats` a future-scheduled campaign stores |
| `deliverableCohort(ids)` → passport ids | the actual consent-gated recipient list handed to the `deliver` hook on a live send |

**Register `audiences` before `campaigns`.** If it isn't wired (`options.audiences` unset and
`ctx.plugins.audiences.service` missing), registration does **not** throw — it logs a startup
warning instead: `"campaigns: audiences service not wired — delivery preview + send will fail
(register audiences first)"`. The plugin comes up, but any call that needs a cohort (delivery
preview, schedule, live send) will fail once actually invoked.

## Data & migrations

Migrations run via `db.migrate.latest()` against `src/migrations/`, tracked in their own table
`whitebox_campaign_migrations` (kept separate from other plugins' migration history).

- **`001_create_campaigns.js`** creates three tables:
  - `whitebox_campaigns` — one row per campaign (`id`, `external_id` unique, `source`, `name`,
    `channel`, `subject`, `scheduled_at`, `status` default `'draft'`, `message` jsonb, `stats` jsonb,
    `analytics_prompt`, `report_id`, `sent_at`, timestamps). The column comment documents a wider
    status set (`draft|scheduled|sending|sent|failed`), but the current service (`src/service.js`)
    only ever sets `draft`, `scheduled`, or `sent`.
  - `whitebox_campaign_audiences` — the campaign⇄audience many-to-many (`campaign_id`,
    `audience_id`, composite primary key).
  - `whitebox_campaign_sends` — a per-send audit row (`resolved`/`deliverable`/`suppressed`/
    `no_consent`/`dry_run`/`batch_id`/`status`). `src/store.js` exposes `insertSend()` for it, but
    the current `schedule()`/`runDelivery()` flow doesn't call it yet — send stats are written
    directly onto the campaign row's `stats` column instead.
- **`002_add_objective.js`** adds the `objective` jsonb column (`{ goals: string[], notes? }`) used
  to build the default `analytics_prompt`.
