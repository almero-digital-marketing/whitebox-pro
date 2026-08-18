# The WhiteBox query language — complete reference

One query language, two layers. This is the whole surface: every key, what it means,
and the mistakes each one invites.

```
┌─ composition layer ── server-plugin-analytics ────────────────────────────┐
│  the QUERY DEF: what a widget stores and analytics_resolve runs           │
│  { selector, group, breakdownFact, splitBy, series, distribution,        │
│    scatter, funnel, cohort, question, projection, scope, asOf, … }        │
│                                                                           │
│  ┌─ core ── whitebox-pro-server ──────────────────────────────────────┐   │
│  │  the SELECTOR: { about, filter, judge } + projection/group/scope   │   │
│  │  the FILTER TREE: all / any / not / fact / metric                  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

Read [selector.md](selector.md) for why the core is shaped this way,
[temporal-facts.md](temporal-facts.md) for the fact timeline, and
[event-attributes.md](event-attributes.md) for the event dimensions. This document is
the reference the three of them assume you already have.

---

## 1. The two questions

Everything reduces to one of these, and picking the wrong one is the most common error:

| | reads | grain | asks |
|---|---|---|---|
| **`fact`** | `whitebox_facts` | one value per person per key | *what someone IS* |
| **`metric`** | `whitebox_awareness_exposures` | many events per person | *what someone DID* |

A fact is single-valued per passport. An event stream is not. So money that arrives as
`meta.paid` on a booking event is a `metric` question — summing it needs
`sum: { field: 'paid' }` over events, and it cannot be answered by a fact filter.

The mistake this prevents: `{ fact: { last_visit_at: { gte: '2026-01-01' } } }` with a
lifetime `sum` selects *people active since January* and then sums their *all-time*
money. Bounding the money needs `since`/`until`/`last` on the metric.

---

## 2. `filter` — the boolean tree

```json
{ "filter": { "all": [ {"fact": …}, {"any": [ {"metric": …}, {"not": {"fact": …}} ]} ] } }
```

`all` = AND, `any` = OR, `not` = negation, each taking a **filter**, not a clause — so
they nest arbitrarily. A leaf is exactly one `fact` or one `metric`.

An empty filter is everyone. `{"filter": {}}` is legal and means no restriction.

---

## 3. `fact` — one key, one predicate

```json
{"fact": {"plan_tier": {"eq": "pro"}}}
{"fact": {"mrr": {"gte": 200, "lte": 400}}}
```

**Exactly one key per clause.** Several operators on that key AND together, which is
how a range is written. Two keys need two clauses under `all`.

### Value operators

| operator | takes | notes |
|---|---|---|
| `present` | `true` \| `false` | is the key set at all — `false` finds people with no row |
| `eq` · `ne` | a scalar | numeric-aware: `"1820"` and `1820` compare equal |
| `in` | an array | |
| `gt` · `gte` · `lt` · `lte` | a scalar | numbers numerically, ISO dates as time, else lexically |
| `contains` · `startsWith` · `endsWith` | a string | stringifies the value first |
| `next` · `last` · `before` | a duration | for DATE values: upcoming / recent / older-than |

Incomparable values match nothing rather than throwing — `null >= 0` is not true here.

### Temporal operators — questions about movement

The window is a key **inside** the operator, never the operator's value:

```json
{"fact": {"plan_tier":   {"transition": {"to": "cancelled", "last": "30d"}}}}
{"fact": {"mrr":         {"decreased": {"last": "30d"}}}}
{"fact": {"visits_total":{"increased": {"last": "7d"}}}}
{"fact": {"geo_city":    {"changed": {"last": "6M"}}}}
{"fact": {"tier":        {"held": "gold"}}}
{"fact": {"geo_city":    {"distinct": {"gte": 2}}}}
```

`changed` · `transition {to?,from?}` · `increased` · `decreased` all **require**
`last`. `held` (was this value ever held) and `distinct` (how many different values)
take an optional `last` — without one they read the whole history.

`{"increased": "7d"}` is the natural mistake and is refused by name.

### `use` — WHICH value, when a passport holds several

A fact is single-valued per passport, so every read picks one.

```json
{"fact": {"first_booked_at": {"gte": "2026-01-01", "use": "min"}}}
```

`last` (default) and `first` pick by `observed_at`; `max`/`min` pick by VALUE. `use` is
a control key — it needs an operator alongside it, since alone it picks a value and asks
nothing about it.

**You should rarely write it.** A deployment DECLARES what each key means, and then
every filter, bucket, aggregate and window anchor honours that declaration. Write `use`
only to override deliberately.

Why this exists: duplicate source records and passport merges make one passport hold
several legitimate values. On GPoint, 3,350 passports hold more than one
`first_booked_at` — 98% of them because one person exists as several CRM customer
records, each correctly reporting its own first booking. Under `last`, "clients acquired
since 1 January" over-reported by 586 people, because a first booking cannot move
forward.

---

## 4. `metric` — an aggregate over events

```json
{"metric": {"attrs": {"event": "booking"}, "last": "6M", "sum": {"field": "paid"}}}
```

One aggregate plus any number of filters. Which aggregates are legal depends on **how
the clause is evaluated**, and that is decided by whether `group` is present:

| | as a GATE (no `group`) | GROUPED (`group` present) |
|---|---|---|
| means | per-passport aggregate, used to select people | one total per bucket |
| aggregates | `count` `distinct_sessions` `sum_dwell_ms` `sum` `recency_days` | `count` `distinct_sessions` `distinct_passports` `sum_dwell_ms` `sum` `avg` `min` `max` `median` `percentile` `earliest` `latest` |
| bound | **required** — `{gte}` / `{lte}`; an unbounded gate matches nobody | ignored — `count: {}` is the correct timeseries |

`recency_days` is gate-only (there is nothing to bucket about "days since").
`distinct_passports` is group-only (a per-passport aggregate cannot gate the passports
it counts).

### Aggregate sources

```json
{"sum": {"field": "paid"}}     // a meta attribute on the event
{"avg": {"column": "dwell_ms"}} // the one numeric exposure column
{"avg": {"fact": "ltv_paid"}}   // a FACT, aggregated per PERSON
{"percentile": {"field": "paid", "p": 0.9}}
```

One of `field` / `column` / `fact`, never two. Non-numeric and absent values contribute
**nothing** rather than zero — an average over "the events that carry a value" is the
only reading that is not a lie.

`fact` sources are deduplicated to one row per (passport, bucket) before aggregating,
so `avg: {fact: 'ltv'}` is the average customer's value and not the value of the average
visit. `earliest`/`latest` are event-time-ordered and therefore reject a `fact`. A `fact`
source may carry its own `use`.

### Event filters

| key | matches |
|---|---|
| `channel` · `direction` · `source` | exposure columns; `=`, array, `{in}`, `{present}` |
| `attrs: {…}` | the `meta` jsonb — `{event: 'booking'}`, `{present: true}` |
| `session: {…}` | UTM columns via the session join — `utm_source`, `utm_campaign`, `utm_medium`, `utm_term`, `utm_content`, `referrer` |
| `content` | **deprecated** substring on the opaque `content_id` |

### Bounding events in TIME

```json
{"metric": {"attrs": {"event": "booking"}, "last": "6M", "sum": {"field": "paid"}}}
{"metric": {"attrs": {"event": "booking"}, "since": "2026-02-16", "until": "2026-08-18", "count": {}}}
```

`last` is relative and moves with the clock. `since`/`until` are absolute and do not.
Given together, the later lower bound wins — which is what AND means.

**These are not `window`.** See §6.

### Durations

`24h` · `7d` · `2w` · `6M` · `1y`.

`h`/`d`/`w` are fixed spans. `M`/`y` are **calendar** spans: `6M` is the same
day-of-month six months ago, clamped for short months (31 August − 6M = 28 February),
matching Postgres interval arithmetic. `m` is refused rather than guessed at, because it
means minutes in most other grammars.

`M`/`y` do **not** apply to `window.offset`/`window.within`, which are converted to
seconds for `make_interval` and have no calendar equivalent.

---

## 5. `judge` and `about`

`about` narrows semantically before the filter runs (`{about: "asked about pricing"}` or
`{about: {text, limit, floor}}`). `judge` applies an LLM predicate to the survivors.
Both cost model calls; `filter` alone costs none.

---

## 6. `window` — anchoring events on a FACT's value

```json
{"metric": {"source": "video", "window": {"before": {"fact": "first_booked_at"}}, "count": {}}}
{"metric": {"source": "video", "window": {"between": [{"fact": "signed_up_at"}, {"fact": "first_booked_at"}]}, "count": {}}}
```

This answers "what did people watch **before they first booked**" — each person's own
boundary, not a shared calendar date.

| key | means |
|---|---|
| `before` · `after` | events on one side of the anchor |
| `between: [a, b]` | events between two anchors |
| `offset: "7d"` / `"-7d"` | shift the boundary (fixed spans only) |
| `within: "7d"` | bound the far side — "the week before" |
| `missingAnchor` | `exclude` (default) · `include` · `only` · `bucket` |
| `use` | which of the anchor key's values to use |

**`window` takes no dates and no durations of its own.** A date handed to it is a time
bound, and time bounds are `last`/`since`/`until` (§4). This is the single most
misleading corner of the language: the error now says so.

`missingAnchor: "bucket"` cross-tabulates anchored vs never-anchored as two series with
their own denominators — the shape "what do people who booked watch, that people who
never booked don't" actually has.

---

## 7. `projection`, `scope`, `asOf`

| | returns |
|---|---|
| `people` (default) | `{passports: [{id, …}]}` |
| `count` | `{count: n}` — the number, not the ids |
| `knowledge` | the grouped series (requires `group`) |

`scope` confines a query to a cohort: an id array, or a whole sub-selector
(`{scope: {filter: …}}`). `asOf` moves the entire query's clock backwards — time travel,
*not* a range bound.

---

## 8. `group` — buckets and series

```json
{"group": {"by": "month"}}
{"group": {"by": "attr:location", "limit": 10}}
{"group": {"by": ["month", "attr:location"], "seriesLimit": 6}}
```

| key | means |
|---|---|
| `by` | one dimension, or **exactly two** to cross-tabulate |
| `limit` | top-N buckets by value — the high-cardinality guardrail |
| `band` | band a numeric `fact:<key>` into ranges (`band: 5` → 20-24, 25-29) |
| `cohortSize` | also return the denominator, so a reach % needs no second call |
| `use` | which value a `fact:<key>` bucket means |
| `seriesLimit` | cap the SERIES dimension of a two-dimension `by` — default **6**, max **200** |

### The dimensions

| `by` | buckets by |
|---|---|
| `hour` `day` `week` `month` | event time |
| `channel` `direction` `source` | exposure columns |
| `content_url` `content_hash` | the content identity |
| `attr:<key>` | a `meta` attribute |
| `session:<utm>` | a session column |
| `fact:<key>` | a fact value (LEFT joined — no value is a **null bucket**, not a dropped row) |

### Two dimensions

The **first** is the x-axis, the **second** becomes one series per value:

```json
{"selector": {"filter": {"metric": {"attrs": {"event": "booking"}, "last": "6M", "sum": {"field": "paid"}}}},
 "projection": "knowledge",
 "group": {"by": ["month", "attr:location"]}}
```

→ `{multi: true, series: [{name, points: [{bucket, value}]}], aggregate}`

The order is fixed, not inferred: a chart with the axes swapped is not a smaller mistake
than a wrong number. `limit` bounds the x-axis; `seriesLimit` bounds the series and
defaults to 6, and when it truncates the response says so:

```json
{"seriesTruncated": {"shown": 6, "cap": 6, "dimension": "attr:location",
                     "raise": "group.seriesLimit (up to 200) — `limit` bounds the other dimension"}}
```

`limit` and `seriesLimit` are independent: `limit` trims the x-axis, `seriesLimit` the
series. Lowering `limit` does not reduce the number of series, and the default of 6 is
sized for a chart — a pivot over 125 studios wants `seriesLimit: 125`.

At most one dimension may be a `fact:<key>` — two would each need their own `use` rule
and there is one. Cannot be combined with `missingAnchor: "bucket"`, which already owns
the series dimension.

`null` values are preserved in a series: `avg` over a bucket where nothing carried the
field has no average, and a zero would plot as a real low value.

---

## 9. The composition layer — the query def

Everything above goes in `selector`. These sit beside it and are resolved by
`server-plugin-analytics`. Unknown keys are refused; so are known keys with the wrong
**shape**.

| key | shape |
|---|---|
| `selector` | §2–6 |
| `group` | §8 |
| `projection` · `scope` · `asOf` · `limit` · `passport` | §7 |
| `breakdownFact` | `{key: "<factKey>", values?: […]}` — split a cohort by a fact's values |
| `splitBy` | `{key: "<factKey>", values: […]}` — the SAME measure as one series per fact value (max 6) |
| `series` | `[{name, query}]` — genuinely different queries overlaid (max 6) |
| `distribution` | `{source: "fact"\|"event", key, bins?}` — a histogram |
| `scatter` | `{x, y, colorBy?}` — numeric facts, one dot per person |
| `funnel` | `{steps: [{name, select, within?}]}` |
| `cohort` | retention grid |
| `question` | a grounded generative answer — last resort, qualitative only |
| `stack` · `target` | presentation, read downstream |

`kind` selects the presentation: `stat` `timeseries` `breakdown` `donut` `radar`
`distribution` `scatter` `pivot` `heatmap` `cohort` `funnel` `dropoff` `table` `answer`.

**`splitBy` vs `group.by` pair** — splitBy compares values of one **fact**; a second
*dimension* is the two-element `group.by`. `splitBy: "attr:location"` is refused with
that distinction spelled out.

**An unknown fact key is an error, not an empty chart.** `breakdownFact`, `fact:<key>`
and a bare token all check the vocabulary — what has been WRITTEN plus what the
deployment DECLARES. A declared key with no rows yet is a legitimate empty series; a key
that was never declared and never written is a 400 that lists the keys that exist.

### `warnings` and `applied`

When a query rests on a fact that holds conflicting values for the people it resolved
**and nobody has declared what that key means**, the MCP response carries:

```json
{"data": …,
 "applied": {"first_booked_at": "min"},
 "warnings": [{"code": "ambiguous_fact_value", "fact": "surplus_key",
               "affected_passports": 3349, "pct_of_cohort": 3.0, "used": "last",
               "max_values_for_one_passport": 24, "remedy": "declare it — …"}]}
```

**The envelope is unconditional** — `applied` and `warnings` are always present, empty
when there is nothing to report, and the result is always under `data`. Never at the
root.

> Earlier versions (0.15.x) wrapped only when a warning existed. That made the shape
> depend on the DATA rather than the request, so a client could not predict it and had to
> probe. `res?.data ?? res` straddles both if you need to support both versions.
>
> This applies to `analytics_resolve` and `analytics_widget_resolve` only. The REST
> routes and core `selector.resolve()` never carried warnings and return results bare.
> See CHANGELOG.md.

`applied` and `used` report the rule that RAN, following the engine's precedence: a
query's `use` beats the declaration, which beats `last`. A query that overrides gets its
override echoed, and the anchor remedy names the declaration it displaced — these fields
exist to be trusted about which semantics produced a number, so reporting the declared
rule for an overridden call would be worse than reporting nothing.

There are two codes, and the difference is which question a declaration closes:

| code | fires when | why |
|---|---|---|
| `ambiguous_fact_value` | the key is ambiguous **and undeclared** | nobody chose; `last` won by default and the caller cannot see it |
| `ambiguous_anchor_fact` | the key is ambiguous **and used as a `window` anchor** — declared or not | a declaration says which value a key MEANS; it does not say where each person's boundary lands |

A declared key used as an ordinary **filter** never warns: the deployment decided, the
answer is right, and warning anyway would fire on every query touching
`first_booked_at` forever — which is how a warning becomes noise. It appears in
`applied` instead, as a statement with no alarm.

A declared key used as an **anchor** does warn, because the question is not the same
one. `window: { before: { fact: 'first_booked_at' } }` draws a boundary per person, and
someone holding several candidate dates gets a window containing a different set of
events depending on which was taken. Nothing is wrong — the rule is declared and
applied — but "what they watched before booking" should be read as *before the `min`
first_booked_at*, and `used` says so. Pass `use` on the anchor to ask for a different
one.

`pct_of_cohort` is scoped to the resolved cohort, not the base: a key ambiguous for 3%
of everyone can be ambiguous for 100% of the people a query selected.

**Cost.** A declared non-anchor key needs no database work at all — the declaration is
in memory. Anchors and undeclared keys cost one indexed query (the partial index on
`value_count > 1`), so the price is proportional to how much a deployment has left
undecided plus how many anchors a query uses.

Ambiguity is **permanent**, not a bug awaiting a fix. The fact log is append-only, so a
key legitimately holds many values over time. It does not collapse, and a backfill
increases it.

---

## 10. Worked examples

```json
// revenue per studio, last six months
{"selector": {"filter": {"metric": {"attrs": {"event": "booking"}, "last": "6M", "sum": {"field": "paid"}}}},
 "projection": "knowledge", "group": {"by": "attr:location", "limit": 10}}

// …per studio PER MONTH, one query
{"selector": {"filter": {"metric": {"attrs": {"event": "booking"}, "last": "6M", "sum": {"field": "paid"}}}},
 "projection": "knowledge", "group": {"by": ["month", "attr:location"]}}

// clients acquired since January, correctly
{"selector": {"filter": {"fact": {"first_booked_at": {"gte": "2026-01-01"}}}}, "projection": "count"}

// who downgraded this month and has not been back
{"selector": {"filter": {"all": [
  {"fact": {"ltv_paid": {"decreased": {"last": "30d"}}}},
  {"not": {"metric": {"attrs": {"event": "booking"}, "last": "30d", "count": {"gte": 1}}}}]}}}

// what people watch BEFORE they first book
{"selector": {"filter": {"metric": {"source": "video",
  "window": {"before": {"fact": "first_booked_at"}}, "count": {}}}},
 "projection": "knowledge", "group": {"by": "content_url", "limit": 10}}

// …and what the never-booked watch instead
{"selector": {"filter": {"metric": {"source": "video",
  "window": {"before": {"fact": "first_booked_at"}, "missingAnchor": "bucket"}, "count": {}}}},
 "projection": "knowledge", "group": {"by": "content_url", "limit": 10}}

// average customer value by tier, with the denominator
{"selector": {"filter": {"metric": {"attrs": {"event": "booking"}, "avg": {"fact": "ltv_paid"}}}},
 "projection": "knowledge", "group": {"by": "fact:tier", "cohortSize": true}}
```

---

## 11. The mistakes this language invites

| you wrote | it means | you wanted |
|---|---|---|
| `window: {between: ["2026-02-16", "2026-08-18"]}` | nothing — `window` anchors on a fact | `since` / `until` |
| `window: {last: "6M"}` | nothing — not a window key | `last` on the metric |
| `last: "6m"` | nothing — `m` is minutes elsewhere | `6M` |
| `{increased: "7d"}` | nothing — no window key | `{increased: {last: "7d"}}` |
| `splitBy: "attr:location"` | silently ignored (now refused) | `group.by: ["month", "attr:location"]` |
| `{pick: "min"}` | no such operator | `use` |
| `fact` filter + lifetime `sum` | those people's all-time total | a time bound on the metric |
| `group.by: "fact:deleted_key"` | 400 naming the known keys | check the key exists |
| a gate aggregate with no bound | matches nobody | `{gte: 1}` |
