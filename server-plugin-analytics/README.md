# Analytics Plugin

> The read side of whitebox. Turns the per-passport semantic memory written by mail / voip / engagement / crm into HTTP endpoints — including a single grounded LLM endpoint that can answer almost any natural-language question about one customer.

## What it is

A thin, auth-protected HTTP shell over `core/awareness` and the per-passport context registry. It owns **no data, no embeddings, no domain logic** — it composes three primitives:

1. `core/awareness` — semantic recall, cohort queries, timeline, GDPR forget.
2. `ctx.context` — structured state from other plugins (CRM rows, billing status, …) without analytics ever importing them.
3. `openai.prompt` — grounded synthesis on top of (1) and (2).

Awareness itself has **no public surface** by design. Analytics is the only way to read out of it.

## What you get

- **A grounded Q&A endpoint over the whole customer.** `POST /analytics/ask` returns an LLM answer that combines semantic recall from every channel (mail bodies, call transcripts, watched video segments, web reading, CRM notes) with current-state structured context (active subscription, upcoming reservation), and cites timestamps + UTM attribution from the evidence.
- **Cohort awareness in one call.** `POST /analytics/population` returns "how many distinct customers have seen / said anything matching this concept" with a similarity threshold — the analytics equivalent of "how big is the segment that knows X".
- **A grounded Q&A endpoint over the whole base.** `POST /analytics/ask-population` is the cohort sibling of `/ask`: no passport, it answers population-level questions ("what are customers asking about?", "how big is the cohort that's seen X?") grounded in content from across every passport, weighted by how many customers each piece reached.
- **Per-customer semantic search.** `POST /analytics/recall` returns the top-k chunks from one customer's history scoped by query embedding.
- **A debug surface for the context registry.** `GET /analytics/context/:passport_id` shows exactly what each registered plugin is feeding into `/ask`, with `?provider=` filtering and paging — useful for verifying a new integration before it changes LLM answers.
- **GDPR forget in one call.** `DELETE /analytics/passport/:id` cascades through all channels' awareness footprint.
- **Zero per-channel coupling.** Adding a new channel plugin tomorrow (billing, support tickets, scheduling …) automatically shows up in `/ask` answers — analytics doesn't change.

## How to integrate

### 1. Enable the plugin

```js
// config
{
  plugins: [..., 'analytics'],
  analytics: {
    auth: { secret: process.env.WHITEBOX_ANALYTICS_TOKEN },
  },
}
```

There are no other knobs. All semantic behavior lives in `config.awareness`.

### 2. Ask grounded questions

```js
const res = await fetch('https://wb.example.com/analytics/ask', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.WHITEBOX_ANALYTICS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    passport_id: customer.passport_id,
    question: 'Has this customer had any billing issues, and what was their reaction?',
  }),
})

const { answer, evidence, context } = await res.json()
```

`answer` is the synthesized text. `evidence` is the raw chunks the LLM saw (with timestamps, channel, UTM). `context` is the structured state pulled from registered providers (CRM rows, etc.). Surface as much or as little of either to your operators as you want.

### 3. Build on top of the retrieval primitives

For custom synthesis flows that aren't a free-form question, compose the lower-level endpoints yourself:

```js
// "Has this user seen the refund policy in the last 30 days?"
const { hits } = await POST('/analytics/recall', {
  passport_id, query: 'refund policy', limit: 5,
})
const recent = hits.find(h => new Date(h.ts) > thirtyDaysAgo)
```

The pattern that scales: pull grounded evidence, format it with timestamps + attribution, pipe through your own prompt. The four base endpoints (`recall`, `population`, `timeline`, `context`) are the building blocks — `/ask` is one example of stitching them together.

### 4. Let other plugins enrich answers

Any plugin that wants its structured data to influence `/analytics/ask` calls one line in its setup:

```js
ctx.context.register('billing', async (passportId, { limit = 20, offset = 0 } = {}) => {
  return db('subscriptions').where({ passport_id: passportId }).limit(limit).offset(offset)
})
```

That's it. Analytics will collect from that provider on every `/ask` and include the rows in the LLM prompt under `Structured context: billing:`. The CRM plugin's registration is the canonical example.

## Role

```
┌─────────────────────────────────────────┐
│  analytics (this plugin)                │
│  HTTP routes, auth, Zod validation,     │
│  grounded LLM synthesis (/ask)          │
└──────────┬───────────────────┬──────────┘
           │ calls             │ collects from
           ▼                   ▼
┌────────────────────┐  ┌─────────────────────────┐
│ core/awareness     │  │ ctx.context (registry)  │
│ recall / population│  │ crm, billing, …         │
│ timeline / forget  │  │ (whatever plugins join) │
└────────────────────┘  └─────────────────────────┘
```

## File layout

```
src/
├── index.js              - plugin factory: permissions, migrate(), mounts both REST surfaces + both MCP registrations
├── routes.js             - original awareness-query REST routes (recall/population/timeline/context/forget/ask/ask-population)
├── mcp.js                - original 7 MCP tools (whitebox.*)
├── ask.js                - /ask + /ask-population handlers (system prompt, evidence formatting)
├── migrations/           - whitebox_reports / whitebox_widgets schema, tracked in whitebox_analytics_migrations
└── composition/
    ├── routes.js         - Reports/Widgets REST surface; also exports runQuery/enrichPeople/composeReport/
    │                        widgetSummary/compactForExplain, reused by composition/mcp.js
    ├── store.js          - knex CRUD over whitebox_reports / whitebox_widgets; broadcasts analytics.changed
    │                        over Socket.IO on every mutation
    ├── compose.js        - the AI compose loop: composeWidgets / describeQuery / explainWidget /
    │                        explainPerson / suggestQuestions / discoverSchema
    ├── mcp.js             - the 18 composition MCP tools (analytics_*)
    ├── mask.js            - PII masking (email/phone) for the people table + LLM prompts
    └── histogram.js       - pure histogram binning for `distribution` widgets
```

There ARE migrations now, and there ARE DB tables: `whitebox_reports` and `whitebox_widgets`, migrated via a
dedicated `whitebox_analytics_migrations` tracking table (see `migrate()` in `index.js`). What's still true is
**no worker / background job** — the composition surface resolves every query live, on every call; the only
thing ever persisted beyond the reports/widgets themselves is a widget's lazily-generated `summary` (regenerated
only when its query changes) plus small in-process `explain`/`suggest` caches keyed by a result fingerprint.

## Endpoints

All four are auth-protected with a Bearer token. None are public.

### Pagination

Every collection endpoint takes the same `limit` + `offset` params (defaults/caps differ per endpoint) and returns the same envelope:

```json
{ "data": [ ... ], "limit": 50, "offset": 0, "has_more": true }
```

`has_more` is computed by fetching one extra row — no `COUNT` query. `population` additionally returns `total` (the cohort size). The one structural exception is `context`: it returns a *map* of providers rather than a single list, so it carries the same `limit`/`offset` params but keeps a per-provider `has_more`.

### `POST /analytics/recall` — per-passport semantic search

> "What does this user know about X?"

Request:
```json
{
  "passport_id": "a1b2c3d4-5678-4abc-89de-1234567890ab",
  "query": "enterprise pricing tier",
  "limit": 5
}
```

Response:
```json
{
  "data": [
    {
      "id": 421,
      "chunk_text": "Professional teeth whitening lifts years of staining...",
      "ts": "2024-11-12T14:23:01Z",
      "similarity": 0.66,
      "engagement": 0.75,
      "depth": "deep"
    }
  ],
  "limit": 10, "offset": 0, "has_more": false
}
```

Paginated (`limit` ≤100, default 10). Embeds the query, vector-searches chunks scoped to that passport, and returns top matches ranked by relevance **blended with reading depth** — a deeply-read paragraph outranks a skimmed heading of similar relevance (a heading that *is* the query phrase can score the highest raw similarity yet rank below the paragraph the customer actually read). Each hit carries `engagement` (0–1 depth weight) and `depth` (`glance`/`read`/`deep`); non-text exposures (mail/voip/crm) have no depth signal and use `engagement = 1`.

Pass **`min_similarity`** (0–1, default 0 = off) to apply a relevance **floor** *before* the depth blend — chunks below it are dropped rather than returned as weak "best of a bad lot" matches. Without it, a single-domain corpus returns off-topic results (every dental paragraph scores ~0.4 against any dental query); a floor of ~0.45 keeps only genuinely on-topic content. The console's `Recall` defaults to `0.45`.

### `POST /analytics/population` — cohort awareness

> "How many users know about X?"

Request:
```json
{
  "query": "spring promotion 25% discount",
  "similarity": 0.78,
  "limit": 50,
  "offset": 0
}
```

Response:
```json
{
  "total": 1284,
  "data": [
    {
      "passport_id": "a1b2c3d4-...",
      "hits": [{ "chunk_text": "...", "similarity": 0.94, "ts": "..." }]
    }
  ],
  "limit": 50, "offset": 0, "has_more": true
}
```

`total` = the cohort size (distinct passports matching above the similarity threshold). `data` is the paginated drilldown of those passports.

Parameters:
- `similarity` — cosine threshold (default 0.75). Raise for strict concept matches, lower for fuzzy theme matches.
- `limit` / `offset` — page the passport drilldown (`limit` ≤200, default 50). `total` stays the full cohort size.
- `min_engagement` — optional reading-depth gate (0–1, default 0 = off). A web text read only puts a passport in the cohort if its depth weight clears this — e.g. `0.15` counts genuine reads but excludes skimmed headings (a heading scores ~0.05). Non-text exposures (mail/voip/crm — no depth signal) always qualify, so this never drops a customer who *called* or *was emailed* about the concept. Lets "how many customers are interested in X" mean readers, not glancers.

### `GET /analytics/timeline/:passport_id` — raw exposure history

> "Show me everything we have for this person."

Query parameters:
- `from`, `to` — ISO timestamps
- `channels` — comma-separated: `mail,voip,web`
- `directions` — comma-separated: `exposure,expression,conversation`

Response: the standard `{ data, limit, offset, has_more }` envelope; `data` is exposure rows ordered by `ts` descending (`limit` ≤200, default 50). No embedding logic — just a SQL filter on the exposures table. Page with `?limit=&offset=`.

### `POST /analytics/ask` — LLM-synthesized answer

> "Answer a natural-language question about this customer, grounded in their content history."

Request:
```json
{
  "passport_id": "a1b2c3d4-5678-4abc-89de-1234567890ab",
  "question": "Has this user been told about the refund policy? When?",
  "limit": 10
}
```

Response:
```json
{
  "answer": "On 2024-11-12 the user read a pricing-page section that included the 30-day refund clause. They have not been sent the refund policy via email or discussed it on any call.",
  "evidence": [
    {
      "id": 421,
      "chunk_text": "...30-day refund policy...",
      "ts": "2024-11-12T14:23:01Z",
      "channel": "web",
      "direction": "exposure",
      "utm_source": "google",
      "utm_campaign": "spring-2025",
      "similarity": 0.91
    }
  ]
}
```

Flow:
1. Calls `awareness.recall({ passport_id, query: question, limit })` to retrieve the top relevant chunks
2. Formats them as evidence with timestamps, channel/direction, and UTM attribution
3. Sends the evidence to GPT-4o with a grounded-answer system prompt
4. Returns both the synthesized answer and the raw evidence

When recall returns no hits, no LLM call is made — the response is `{ answer: "No relevant content found...", evidence: [] }`. This avoids paying for an LLM call to say "I don't know."

The system prompt enforces:
- Ground every claim in evidence
- Cite timestamps
- Mention UTM attribution when relevant
- Don't invent attribution when UTMs are absent
- Distinguish exposure vs expression
- Weight reading depth + intent — a skimmed heading or passively-viewed image (a "glance") is incidental, not a stated interest; lead with what the customer genuinely read or actively did
- Stay concise

### `POST /analytics/ask-population` — LLM-synthesized answer over the whole base

> "Answer a natural-language question about the entire customer base, not one customer."

The cohort sibling of `/ask`. Where `/ask` grounds a single passport's recall, `ask-population` answers about the base as a whole. **No `passport_id`.** It grounds on two things:

1. **Base-wide stats** (always) — total customers and a breakdown of content events by channel/direction. This makes counting/aggregate questions ("how many customers do we have?") exact.
2. **Evidence** — *either* the semantic cohort that matches the question (collapsed into representative content weighted by how many distinct customers it reached), *or*, when the question maps to no cohort (a broad/overview question), a query-independent **base-wide content sample** (biased toward what customers *express*, not just what we broadcast).

So it works for both *targeted* questions ("what do customers who asked about pricing want?") and *whole-base* questions ("what are people interested in?", "what's going on across everyone?") — the latter no longer dead-ends on an empty cohort.

Request:
```json
{
  "question": "What are customers most interested in right now?",
  "similarity": 0.6,
  "limit": 1000
}
```

Response:
```json
{
  "answer": "Pricing and SSO dominate: dozens of customers asked about per-seat pricing, and a recurring theme among enterprise visitors is SAML/SSO. Refund terms come up far less often.",
  "cohort": { "count": 137 },
  "stats": {
    "customers": 4120,
    "exposures": 38117,
    "breakdown": [
      { "channel": "web", "direction": "exposure", "exposures": 21044, "customers": 4001 },
      { "channel": "mail", "direction": "expression", "exposures": 980, "customers": 612 }
    ]
  },
  "evidence": [
    {
      "chunk_text": "How is pricing structured for larger teams?",
      "channel": "mail",
      "direction": "expression",
      "similarity": 0.88,
      "passport_count": 41
    }
  ]
}
```

- `stats` — base-wide totals + channel/direction breakdown, always present. Use it for "how many" questions.
- `cohort.count` — distinct customers whose content matched the question (the semantic cohort, not the whole base). `0` means nothing matched the specific concept; the answer is then drawn from the base-wide sample (and `evidence[].similarity` is `null`).
- `evidence[].passport_count` — how many distinct customers that content reached; the model uses this to ground magnitude.
- Parameters: `similarity` (default `0.5` — a full natural-language question embeds further from the content than a bare concept, so this is looser than raw `population`'s `0.75`; at `0.6` a question like "what are patients asking about insurance?" matched *nobody* despite many having read the insurance copy, which forced a misleading empty-cohort fallback), `limit` (max chunks scanned, default 1000).
- Only short-circuits (no LLM call) when the base is genuinely empty: `{ answer: "There are no customers in the base yet.", cohort: { count: 0 }, stats, evidence: [] }`.

Like `/ask`, it delegates to the awareness core (`awareness.askPopulation`) and accepts the same `instruction` / `schema` overrides from there. There is **no** per-customer structured-context step — the context registry is per-passport.

### Context providers (how other plugins feed `/ask`)

`/ask` answers from two sources:

1. **Evidence** — semantic recall over awareness chunks (mail bodies, web text, transcripts, CRM notes …). This is automatic for anything routed through `awareness.record()`.
2. **Structured context** — current-state JSON from external systems (CRM rows, billing status, open tickets …). This comes from a generic registry — `ctx.context`.

Plugins opt in by calling `ctx.context.register(name, fn)` during their setup:

```js
// inside someplugin's register(app, ctx)
ctx.context.register('billing', async (passportId, { limit = 20, offset = 0 } = {}) => {
  return db('subscriptions')
    .where({ passport_id: passportId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
})
```

Each provider:
- Returns JSON-serializable data (array or object).
- Respects `opts.limit` and `opts.offset` so `/analytics/context` paging works. `/ask` always calls with `limit: 20, offset: 0`.
- Should be cheap — one indexed DB query, no LLM calls. `collect()` runs on every `/ask`.
- Should not throw — exceptions are caught and surfaced as `null` for that key.

Analytics has zero knowledge of which plugins are registered. The CRM plugin's registration is the canonical example (see `plugins/crm/index.js`). Use `GET /analytics/context/:passport_id` to inspect what each provider returns without paying for an LLM call.

### UTM attribution in responses

All read endpoints (`recall`, `population`, `timeline`, `ask`) include UTM data joined from the sessions table:

```
utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer
```

For exposures without a linked session, these are `null`. Consumers can filter or surface attribution client-side.

### `GET /analytics/context/:passport_id` — inspect structured context

> "What does `/ask` see for this customer before it calls the LLM?"

Returns whatever each registered context provider returns for the passport. Same call `/ask` makes internally, with the LLM step skipped — useful for verifying that a newly added plugin is feeding the right shape into the prompt, and for debugging when an answer omits something you expected.

Query params:
- `provider` — comma-separated allowlist (`?provider=crm,billing`). Default: all registered. Unknown names return **400** so typos aren't silently swallowed.
- `limit` / `offset` — same pagination params as every other endpoint (default 20, `limit` ≤200), passed to each provider, which is expected to honor them.

Unlike the list endpoints, the response is a **map** of providers (so there's no single `data` array); it carries the same `limit`/`offset` plus a per-provider `has_more`.

```bash
# Default — all providers, first 20 entries each
curl -H "Authorization: Bearer $T" \
  "https://api.example.com/analytics/context/$PASSPORT_ID"

# Only CRM, second page of 10
curl -H "Authorization: Bearer $T" \
  "https://api.example.com/analytics/context/$PASSPORT_ID?provider=crm&limit=10&offset=10"
```

Response:
```json
{
  "providers": ["crm"],
  "limit": 10,
  "offset": 10,
  "has_more": { "crm": true },
  "context": {
    "crm": [
      {
        "source": "booking",
        "kind": "reservation",
        "external_id": "res_88421",
        "status": "confirmed",
        "starts_at": "2026-06-12T14:00:00Z",
        "data": { "room_type": "Deluxe Suite", "nights": 3 }
      }
    ]
  }
}
```

`has_more` is a best-effort hint per array-returning provider: `true` when the slice came back full (likely more on the next page), `false` otherwise. Object-returning providers (e.g. `billing: { plan: 'pro' }`) are omitted from `has_more`. There is no total count — paginate forward until `has_more` is false.

When no plugins have registered providers, returns `{ providers: [], limit, offset, has_more: {}, context: {} }`. No LLM call, no embedding call — pure registry walk + per-provider DB query.

### `DELETE /analytics/passport/:passport_id` — GDPR forget

Deletes all exposures + chunks for that passport (chunks cascade via FK). Returns:
```json
{ "deleted": 47 }
```

Fires the `awareness.forgotten` notify event so external systems can react (mail row deletion, voip recording purge, etc.).

## Composition surface

Everything above is the original ask-anything / recall surface. Composition is a second REST surface, mounted
on the same `/analytics` prefix — the backend for the three-pane analytics console (report list → report canvas
of widgets → per-widget Query/Agent view). It owns its own state (`whitebox_reports`, `whitebox_widgets`) and
layers an AI "just ask" loop, an AI co-pilot (describe/explain/suggest), and live query resolution on top of the
core selector engine.

A **report** is a named board with an ordered list of **widgets**. A **widget** is one chart/table/answer on
that board, and stores a **query def** — a small JSON object describing what to fetch, not the fetched data
itself:

```js
{ selector?, group?, projection?, scope?, passport?, asOf?, limit?,   // selector path
  funnel?, named?,                                                    // funnel path
  breakdownFact?: { key, values[] },                                  // fact-value split
  distribution?: { source, key, bins?, maxBins? },                    // histogram
  scatter?: { x, y, colorBy?, limit? },                                // two-numeric-fact scatter
  cohort?: { event?, grain?, periods? },                               // retention grid
  series?: [{ name, query }], splitBy?: { key, values[] },             // multi-series compare
  question? }                                                          // grounded natural-language answer
```

See the header comment in `src/composition/routes.js` (lines 1–24) for the canonical shape, and the system
prompt in `src/composition/compose.js` for the full grammar the AI is taught — it doubles as the best reference
for hand-writing a query def.

`kind` (one of 14) picks how a resolved query def renders:

- **`stat`** — a single cohort count (people count)
- **`timeseries`** — a measure bucketed over time (day/week/month)
- **`breakdown`** — a measure split by a dimension (a fact, channel, session UTM, or event attribute)
- **`donut`** — the same query shape as `breakdown`, rendered as a pie (share of total)
- **`radar`** — the same query shape as `breakdown`, rendered as a polygon (a profile across dimensions)
- **`distribution`** — a histogram of one numeric fact's value, or an event count, per person
- **`scatter`** — one dot per person at (factX, factY), optionally colored by a third fact
- **`pivot` / `heatmap`** — a 2-D compare matrix
- **`cohort`** — a retention grid — % of each cohort still active k periods later
- **`funnel`** — ordered steps, each a metric query; renders survivors per step
- **`dropoff`** — the same funnel shape, rendering the people LOST between each step (the re-engagement audiences)
- **`table`** — the raw matching people, PII-masked before serialization (see below)
- **`answer`** — a grounded natural-language answer (`awareness.askPopulation`) — last resort, qualitative only

The filter grammar used inside `selector`/`scope` is a small boolean tree:
- `fact` — `{ "fact": { "<key>": { "eq"|"ne"|"in"|"gt"|"gte"|"lt"|"lte"|"present": <value> } } }`
- `metric` — an event aggregate: `{ "metric": { "attrs": { "event": "<name>" }, "count": { "gte": 1 }, "last": "30d" } }` (also `sum`, `distinct_passports`, `session.utm_*`, `channel`)
- `combine` — `{ "all": [...] }`, `{ "any": [...] }`, `{ "not": ... }`
- `semantic` — `"about": "<topic words>"` at the selector's top level

### REST endpoints

```
GET    /analytics/reports                 list reports (newest first, each with widget_count)
POST   /analytics/reports                 { name, layout? } → report
GET    /analytics/reports/:id             report + its widgets
PATCH  /analytics/reports/:id             { name?, layout? }
DELETE /analytics/reports/:id             (cascades widgets)
POST   /analytics/reports/:id/widgets     { kind, query, title?, presentation?, position?, provenance?, sort? }
PATCH  /analytics/widgets/:id             partial widget update
DELETE /analytics/widgets/:id
PATCH  /analytics/reports/:id/reorder     { order: [widgetId, …] } — drag-to-reorder
POST   /analytics/resolve                 run an INLINE query def — live preview, no persistence
POST   /analytics/widgets/:id/resolve     run a persisted widget's stored query
POST   /analytics/widgets/:id/summary     the AI's plain-language reading of a widget's query (cached on the row)
POST   /analytics/compose                 { question, report_id? } → AI assembles + persists widgets
POST   /analytics/describe                { query } → plain-language question (inverse of compose)
POST   /analytics/explain                 { id, title, kind, data } → 1–2 sentence insight
POST   /analytics/people/:id/insight      { context? } → 1–2 sentence profile of one person
GET    /analytics/suggestions             ?report_id= → "Try one:" question chips
GET    /analytics/schema                  the queryable vocabulary (fact keys, events, tags) — debug
```

Read-shaped routes (`GET`, `resolve`, `describe`, `explain`, `suggestions`, `schema`, even `widgets/:id/summary`
despite it writing a cache onto the row) are gated by `analytics:read`. Anything that creates, edits, or deletes
a report/widget — including `compose`, because the "just ask" flow persists — requires `analytics:write`.

### Resolve is always live

`/analytics/resolve` and `/analytics/widgets/:id/resolve` re-run the query def against the core selector on
**every single call** — nothing is cached or materialized. `table`-kind results are passed through
`enrichPeople()` first, which attaches a display `label` (a known name, or a masked identity) and masked
`contacts` to each row — raw email/phone never leaves the server (`src/composition/mask.js`).

### Compose: the AI "just ask" loop

`POST /analytics/compose` is how a plain-language question becomes a saved report. `compose.composeWidgets()`
asks the model — grounded in `discoverSchema()`'s real fact keys/events/campaigns, so it can't invent a
vocabulary that doesn't exist — for 1–4 widget specs. **Each spec is then validated by actually resolving it**
before anything is written: a widget whose query the selector rejects is logged and dropped, never persisted
(`composeReport()` in `composition/routes.js`). Passing an existing `report_id` appends to that report instead
of creating a new one.

```json
// POST /analytics/compose
{ "question": "How many active clients?" }
```
```json
{
  "report": { "id": "5c1e2f3a-...", "name": "How many active clients?" },
  "widgets": [
    {
      "id": "9a2fbb10-...", "kind": "stat", "title": "Active clients",
      "query": { "selector": { "filter": { "fact": { "client_status": { "eq": "active" } } } }, "projection": "people" },
      "provenance": "ai", "sort": 0,
      "data": { "count": 812 }, "error": null
    }
  ]
}
```

### The AI co-pilot layer

`describe`, `explain`, `suggest`, and `people/:id/insight` never query the selector for new data — they
generate insight **text** from a query def or an already-resolved result:

- **describe** — a query def → the plain-language question it answers (the inverse of compose; powers the
  Query↔Agent toggle in the widget editor).
- **explain** — a widget's already-rendered result → a 1–2 sentence opportunity/insight ("the cohort worth
  targeting", "the leak to plug", which series leads). Cached in-process by a fingerprint of
  `{ id, kind, compactForExplain(data) }` so an unchanged result never re-calls the model.
- **suggest** (`GET /analytics/suggestions`) — "Try one:" chips, grounded in a clue hierarchy: a report's
  existing widgets → a meaningful report name → just the raw data vocabulary.
- **person insight** (`POST /analytics/people/:id/insight`) — a 1–2 sentence profile of one selected person
  (lifecycle status, LTV, recent activity), with contact-identifier facts stripped before the prompt.

`compactForExplain()` and `widgetSummary()` (both exported from `composition/routes.js`) are shared by REST and
MCP so the generated text can never diverge by transport.

## MCP tools

Analytics registers **25 MCP tools** in total, from two different files, for two different concerns:

- **`src/mcp.js`** — 7 tools, `whitebox.*` (dot) — ad-hoc awareness Q&A, the same primitives as the original endpoints above
- **`src/composition/mcp.js`** — 18 tools, `analytics_*` (underscore) — the persisted reports/widgets feature

The `whitebox.` prefix is a deliberate **product-brand** name (it reads as "ask whitebox"), not a plugin-name
prefix — the composition tools use the plugin's own name instead. Both files are wired from `src/index.js`:
`registerMcp()` runs unconditionally (same as `mountRoutes()`); `registerCompositionMcp()` only runs when `db`
and `selector` are present on `ctx` — the identical guard that skips mounting the composition REST routes.

Both tool sets mirror their REST surface **1:1 by calling the exact same underlying functions** — the original
7 delegate straight to `awareness.ask` / `awareness.recall` / `awareness.population` / etc., and the new 18 call
`runQuery`, `enrichPeople`, `composeReport`, `widgetSummary`, and `compactForExplain` — all exported from
`composition/routes.js` **specifically so REST and MCP never diverge**: one implementation, two transports.

### Original 7 — `whitebox.*`

- `whitebox.ask` — grounded Q&A about one customer (`passport_id` + `question`)
- `whitebox.ask_population` — grounded Q&A about the whole base or a cohort (no `passport_id`)
- `whitebox.recall` — per-passport semantic search
- `whitebox.population` — cohort awareness (count + drilldown)
- `whitebox.timeline` — raw exposure history for one passport
- `whitebox.context` — inspect the structured context registry for one passport
- `whitebox.forget` — GDPR forget (irreversible)

### New 18 (composition) — `analytics_*`

**Inspect** (read-only):
- `analytics_list_reports` — list all reports with `widget_count`
- `analytics_get_report` — one report with its widgets
- `analytics_schema` — the queryable vocabulary (fact keys + samples, events, attrs, campaigns, sources, channels)
- `analytics_suggest_questions` — "Try one:" chips for a report, or generic starters without one

**Author** (AI-native):
- `analytics_compose` — the "just ask" loop; **persists** a report + validated widgets
- `analytics_describe_query` — query def → plain-language question; never persists
- `analytics_widget_summary` — a saved widget's cached AI summary (generated once per query version)
- `analytics_explain_widget` — resolves a saved widget, returns a 1–2 sentence insight (uncached, unlike REST `/explain`)
- `analytics_person_insight` — 1–2 sentence profile of one customer

**Resolve** (live, never persists):
- `analytics_resolve` — run an inline query def
- `analytics_widget_resolve` — run a persisted widget's stored query

**Act** (guarded — persists a mutation):
- `analytics_create_report`, `analytics_update_report`, `analytics_delete_report`
- `analytics_add_widget`, `analytics_update_widget`, `analytics_delete_widget`
- `analytics_reorder_widgets`

## Auth

Two permission scopes gate every route: `analytics:read` (ask questions, view reports, resolve/preview) and
`analytics:write` (create/edit/delete reports and widgets — including `/compose`, since "just ask" persists).
Both default **on** for any teammate — unlike Audiences/Campaigns, viewing reports and asking questions isn't
something that needs an admin's explicit opt-in; the split exists so a teammate *can* be restricted to
view-only later, not to narrow anyone's access today.

Configured via `resolveReadWriteAuth()` (`whitebox-pro-server/auth`), which accepts:
- a bare secret string, or `{ secret }` — resolves to the **same** bearer-token verifier for both scopes
  (matches pre-split behavior exactly)
- a composed verifier (e.g. `auth0({ … })`)
- `{ read, write }` — two independent verifiers/secrets, to gate the two scopes differently

```js
config.analytics = { auth: { secret: 'your-bearer-token' } }
// or split them:
config.analytics = { auth: { read: 'read-only-token', write: 'read-write-token' } }
```

If either side fails to resolve to a verifier, the plugin fails at startup — analytics endpoints are never
accidentally unprotected.

Header format:
```
Authorization: Bearer your-bearer-token
```

## Validation

All POST endpoints use Zod schemas:

- `recall` — passport_id (UUID v1–v8), query (non-empty string), limit (1–100)
- `population` — query (non-empty string), similarity (0–1), limit (1–10000)
- `timeline` — passport_id from URL param

400 on validation failure with the Zod error flattened in the response body.

## Usage example

```js
const res = await fetch('https://api.example.com/analytics/recall', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.WHITEBOX_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    passport_id: customer.passport_id,
    query: 'refund policy',
    limit: 5,
  }),
})

const { hits } = await res.json()
const seen = hits.some(h => h.similarity > 0.8)
```

For richer flows (LLM-synthesized answers, multi-step queries), the consumer layers that on top — analytics gives you grounded retrieval, your code adds synthesis.

A full client wrapper example is in the project root [README.md](../README.md).

## What this plugin is NOT

- **Not a dashboard.** No HTML, no charts, no UI. That's a separate concern — write an admin app that consumes these JSON endpoints.
- **Not just a Q&A surface.** Most endpoints return raw matches. `/ask` adds a grounded synthesis layer on top — but it composes `recall` + an LLM call. The retrieval primitives stay usable on their own.
- **Not a streaming endpoint.** Returns full result sets. For very large cohorts, paginate using `limit` and re-issue.
- **Not where awareness data is written.** Mail/voip/engagement plugins write into awareness. Analytics only reads.
- **Not public.** All endpoints require auth. There's no equivalent of the public `/mail/inbox` form route here.

## Config shape

```js
config.analytics = {
  auth: {
    secret: 'long-random-bearer-token',
  },
}
```

That's it. All other behavior is delegated to `config.awareness`.

## Operational properties

- **No persistent state — original surface only.** The awareness-query endpoints (`recall`/`population`/
  `timeline`/`context`/`forget`/`ask`/`ask-population`) are stateless; restarting loses nothing. The composition
  surface is the exception: reports and widgets persist in Postgres (`whitebox_reports`/`whitebox_widgets`) and
  survive a restart.
- **No background jobs.** Still true, composition included — no workers, no schedules, nothing materialized on
  a timer. Every resolve re-runs live; the only things ever cached are a widget's lazily-generated `summary`
  (persisted, invalidated on query edit) and small in-process `explain`/`suggest` caches (lost on restart,
  regenerated on demand).
- **Stateless requests.** Each request is independent; no session, no rate limiter built in (add at the reverse proxy / WAF layer).
- **Embedding latency.** Recall and population issue a single embedding call to OpenAI (`text-embedding-3-small` by default — typically ~50ms). Timeline is pure SQL, no LLM call.

## Test coverage

```
tests/index.test.js     28 tests  — original REST routes (recall/population/timeline/forget/context/ask/ask-population)
tests/mcp.test.js       10 tests  — the original 7 whitebox.* MCP tools
tests/compose.test.js    3 tests  — discoverSchema's fact-label resolution
                        ————————
                        41 tests total
```

Tests mount the plugin on a fresh Express app with a mocked awareness module. No DB needed for `index.test.js`/
`mcp.test.js`. Note: there is currently no dedicated test file for the composition surface's REST routes
(`composition/routes.js`) or its 18 MCP tools (`composition/mcp.js`) — `compose.test.js` only covers
`discoverSchema`'s fact-labeling behavior, not the resolve/compose/CRUD paths.

## Known gaps

1. **No pagination cursor** — `recall` and `population` cap by `limit`, no way to fetch "next page" of results.
2. **No saved queries** — every query is independent; can't build named queries / dashboards from within the plugin.
3. **No rate limiting** — relies on auth gate alone. For production with multiple admin clients, add a rate limiter at the proxy layer.
4. ~~No LLM synthesis endpoint~~ — no longer true. The composition surface added `compose`/`describe`/`explain`/
   `suggestions`/`people/:id/insight` (see "Composition surface" above), all LLM-backed beyond `/ask`. What's
   still true: none of them is a generic "pipe anything through GPT" route — each is purpose-built for one
   insight shape.
5. **No streaming** — long timelines load fully into memory before serializing.

## Extending

`/ask` is the canonical example of retrieval-primitive-plus-synthesis. For other synthesis patterns (cohort summaries, content-effectiveness rollups, drop-off analyses), follow the same shape:

1. Pull grounded evidence from `awareness.recall`, `.population`, or `.timeline`
2. Format it with timestamps + attribution context
3. Send to `openai.prompt` (or `openai.chat.completions.create` for richer control) with a constrained system prompt
4. Return `{ answer, evidence }` so callers can verify or override the synthesis

Keep these endpoints separate from the retrieval primitives so consumers can pick their abstraction level.

## Ad-network reporting

Analytics is purely query/recall over awareness. **Conversion reporting to the ad
networks moved to [`whitebox-pro-server-plugin-conversions`](../server-plugin-conversions)**,
which receives `/conversions/events` and fans out to composed network packages
(`whitebox-pro-adnetworks-meta` / `-google` / `-tiktok`), deduped against the browser
pixels by `event_id`.
