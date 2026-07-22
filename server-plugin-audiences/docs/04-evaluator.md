# 04 · Evaluator

The evaluator ([`src/evaluator.js`](../src/evaluator.js)) is a **thin adapter over the core selector
engine** (`ctx.selector`). There's no bespoke feature family and no plugin-owned LLM judge — the engine
owns every bit of selection; this module maps a segment's saved source onto it, and separately combines
segments into an audience with set algebra. `service.js` is the only caller.

For the selection mechanics themselves — `about`, `filter`, `judge`, `preview`, and the `funnel` slot
model — read the selector spec: [`whitebox-pro-server/docs/selector.md`](../../server/docs/selector.md).
This doc stays focused on **how the plugin uses the engine.**

## Resolving a segment's source

A segment has one of two sources, and each maps to one engine call shape:

```
resolveCohort(source)                                # the QUALIFIED cohort, per-member metadata
  select source → selector.resolve(source.select, { projection: 'people' })
  funnel source → selector.funnel(source.funnel)  then  selector.funnelSlot(result, source.slot, { status })

resolveSource(source) = resolveCohort(source)        # alias — a segment's source is rule-shaped
```

The engine resolves the **whole cohort — judge included — in one call.** Each member carries `{ id,
qualified, score, reason, evidence }` — for a `select` source these come straight from the engine's
`passports` (`p.score`, `p.why`, `p.matched_at`); for a `funnel` source the slot ids are wrapped with a
synthetic `score: 1` / `reason: "funnel <slot>"`. `service.resolveSegment` takes just the `id`s from this
for its API response — see [02 · Concepts](02-concepts.md) for why the richer per-member data isn't
surfaced over REST/MCP today.

## Preview = cost, before anything is saved

```
preview(source)                                       # aliased as previewSource
  select source → selector.preview(source.select)  mapped to:
      candidate_pool    = filter.survivors
      est_matches       = judge.projectedMatches   (or filter.survivors when there's no judge)
      sampled           = judge.sample
      full_scan         = fullScan
      confirm_required  = confirmRequired
      sample_reasons    = judge.reasons
  funnel source → resolveCohort(source) → { candidate_pool = est_matches = slot cohort size }
```

Preview never persists or fires anything. For a `select` source it's a pass-through of the engine's
preview: the survivor count *is* the judge-call count, plus a sampled qualifying rate, a few real "why"
reasons, a `full_scan` flag, and a `confirm_required` cap. For a `funnel` source there's no LLM to
preview, so it reports the slot cohort size. `service.previewSegment` runs this over an **unsaved**
source — nothing is written to `whitebox_audience_segments`.

## Composing an audience — set algebra over segments

This is the layer above a single segment resolve: an audience is a boolean composition, so the
evaluator owns a small **set** combinator on top of per-segment resolution:

```
composeAudience(rule, resolveSegment)                 # rule = { op, members: [{segment, negate?}] }
  → positives = members without negate; negatives = members with negate
  → resolve each positive segment (resolveSegment(id) → Set<passport id>, caller-memoised)
  → op:'all' → intersect the positive sets
    op:'any' → union the positive sets
  → subtract the union of the negated segments' sets
```

`resolveSegment` is passed in by the caller (`service.js`'s `segmentResolver()`) — the evaluator owns
only the set combination, not the segment store, so it stays a pure function of ids. Set algebra works
uniformly whether a member segment is `select`- or `funnel`-sourced: each simply resolves to a cohort
first, then the sets combine. There is no "compile an all-`select` composition into one selector call"
optimization — every member segment always resolves independently.

```
resolveAudience(rule, resolveSegment) → [...ids]
previewAudience(rule, resolveSegment) → { candidate_pool: ids.size, est_matches: ids.size }
```

`previewAudience` is coarser than a segment preview — no judge sampling or full-scan flag, since the
expensive narrowing already happened once per segment by the time you're composing them.

## Naming (AI-native, preview-first)

```
nameSegment({ source, context })          # ai.object(...) → a 2-5 word Title Case name; falls back to
                                          # context.label, or a generic "Segment"/"Funnel <slot>", on failure
nameAudience({ op, included, excluded })  # names from the composition's segment NAMES (resolved by
                                          # service.js — the evaluator only knows ids), split by
                                          # include/exclude, plus the match mode
```

Both are best-effort: on any AI failure they fall back to a deterministic name rather than erroring, so
naming never blocks a create.

## Supporting calls

```
availableFacts()        # fact keys for segment/audience authoring + discovery
  → db('whitebox_facts').distinct('key').orderBy('key')  → [{ key, label }]
```

`label` is a plugin-registered or config-set human name (`whitebox.config.js` `facts.labels`) — falls
back to the raw key when nothing is registered.

## The cost lever lives in the engine

The two principles this plugin used to implement by hand now live entirely in the selector engine:

- **Cheap narrow before expensive LLM.** `about` gates semantically, `filter` gates deterministically
  (SQL / facts), and the LLM `judge` runs **last, only on the survivors**. Cost is governed entirely by
  how much `about` + `filter` narrowed first. (selector.md §3, §6.)
- **The LLM judges meaning, never counts.** `metric` / `fact` clauses are computed deterministically and
  handed to the judge as structured context — it weighs them, it never recomputes or counts. (selector.md
  §6.)

The plugin owns no evaluation-cost config of its own — no `candidateSimilarity` / `candidateLimit`, those
are engine config (`selector.candidateSimilarity`, etc). Tune selection in the engine, not here.
