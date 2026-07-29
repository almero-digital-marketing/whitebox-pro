# 03 · Segment sources

A segment's `source` is **declarative data** — the shared grammar lives in
[`src/rules.js`](../src/rules.js) (zod-validated: `Selector`, `Funnel`, `SLOT_RE`) and is reused as-is
by [`src/segments.js`](../src/segments.js)'s `SegmentSource` schema. (`rules.js` is a small file today —
this plugin no longer has a standalone "rule" entity; the file now only exports this shared grammar. See
[01 · Architecture](01-architecture.md).)

The engine (`ctx.selector`) does all the selection; this plugin just stores the source, resolves it, and
composes it into audiences. The selector grammar — `about` / `filter` / `judge`, and the full `filter`
boolean tree — lives in [`selector.md`](../../server/docs/selector.md); this page is the segment-source
envelope around it.

## Shape

A segment source is **exactly one** of a `select` (a selector) or a `funnel` + `slot`:

```js
// SOURCE A — a core selector (≥1 of about / filter / judge)
{
  select: {
    about:  'competitor, alternatives, switching',          // semantic narrow (vector)
    filter: { all: [ { fact:   { plan_tier: { eq: 'pro' } } },
                     { metric: { content: 'pricing', channel: 'web', recency_days: { lte: 30 } } } ] },
    judge:  { criteria: 'genuinely at risk of churning', confidence: 0.7 },
  },
}
```

## `select` — the selector source

`select` is a core selector with three optional stages; **at least one** must be present (an empty
selector would mean "everyone," never a real slice):

- **`about`** — a short semantic topic, vector-matched. For a people cohort it *gates* at a similarity
  floor (kept everyone above it), not a top-N. Comma-separated topics work best.
- **`filter`** — a boolean tree (`all` / `any` / `not`) of deterministic `fact` and `metric` clauses,
  run before the LLM. **The grammar is in [`selector.md` §5](../../server/docs/selector.md)** —
  `fact` (ops `eq/ne/in/gt/gte/lt/present`, directional dates `next/last/before`, temporal
  `changed/transition/decreased/increased`) and `metric` (windowed aggregates over awareness:
  `count` · `distinct_sessions` · `sum_dwell_ms` · `sum` · `recency_days`, with `content` / `channel` /
  `last`). Don't re-document it here — link to it.
- **`judge`** — `{ criteria, confidence? }`, an LLM predicate run **last**, once per candidate that
  survives `about` + `filter`. `criteria` is one precise sentence; keep if `score ≥ confidence`.

Examples — each is a valid `select`:

```js
// pure structured, NO LLM — win-back (pure-negative; preview flags a full scan)
select: { filter: { all: [ { fact: { order_count: { gte: 1 } } },
                           { not: { metric: { content: 'purchase', recency_days: { lte: 90 } } } } ] } }

// semantic only — interested in teeth whitening
select: { about: 'teeth whitening, whitening cost' }

// windowed spend — big spenders this quarter
select: { filter: { metric: { content: 'purchase', sum: { field: 'value', gte: 1000 }, last: '90d' } } }
```

## Funnel source

The other source is a **funnel** + a **slot** — for windowed / ordered steps (*"started a trial, then
purchased within 14 days"*) that a single `filter` can't express. The funnel shape and resolution are
defined in [`selector.md` §14](../../server/docs/selector.md); a segment pins it to one cohort with
`slot`:

```js
{
  funnel: {
    within: '30d',                                   // OPTIONAL total window from entry
    steps: [
      { select: { filter: { metric: { content: 'trial_start', count: {} } } }, name: 'trial' },
      { select: { filter: { metric: { content: 'activation', count: {} } } }, within: '7d', name: 'activated' },
      { select: { filter: { metric: { content: 'purchase',   count: {} } } }, within: '14d', name: 'purchased' },
    ],
  },
  slot:   'gap:2→3',               // the drop-off cohort: activated, didn't purchase
  status: 'pending',              // still inside the window (act now) — vs 'dropped' (window closed)
}
```

- **`slot`** — `"step:N"` (that step's completers) or `"gap:N→M"` (the drop-off between two steps).
- **`status`** — only on a `gap:` slot: `'pending'` (did step *k*, hasn't done *k+1*, **still in the
  window**) or `'dropped'` (window **closed** — win-back). A gap segment **self-drains**: it's
  recomputed live on every resolve, so as people convert they simply stop appearing in it.

## Validation — exactly one source

`SegmentSource` (in [`src/segments.js`](../src/segments.js), built from the `Selector`/`Funnel`/`SLOT_RE`
grammar in `src/rules.js`) is a **strict** schema — top-level keys beyond `select`/`funnel`/`slot`/
`status` are rejected — and enforces:

- **`select` XOR `funnel`** — a segment needs exactly one source.
- A `funnel` source **requires a `slot`** (`"step:N"` or `"gap:N→M"`).
- `status` only applies to a **`gap:` slot**.
- A `select` must have **≥1 of** `about` / `filter` / `judge`.

The underlying `Selector`/`Funnel` schemas use `.passthrough()`, so the engine can accept
forward-compatible selector fields this plugin doesn't itself validate.

## Authoring

Three ways, all hitting the same validation:

1. **Talk to it** — `audiences_preview_segment { source }` → refine → `audiences_name_segment` →
   `audiences_create_segment`. (See the README conversations.)
2. **REST** — `POST /audiences/segments`.
3. **Config-as-code** — keep a source JSON in your repo and `POST` it on deploy.

**Always preview before create.** Preview runs the selector engine and tells you the candidate pool,
projected matches, sampled judge reasons, whether a full scan is needed, and whether a confirm is
required — before a cent of LLM spend. See [09 · API](09-api.md#preview) for the response shape.

`audiences_create_segment` / `POST /audiences/segments` **dedups on the source predicate** — saving the
same slice twice returns the existing segment (see
[11 · Segments & audiences](11-segments-and-audiences.md)).
