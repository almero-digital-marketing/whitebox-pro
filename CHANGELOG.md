# Changelog

Notable and especially BREAKING changes, newest first. Packages in this repo version
independently; entries name the package and version that carries the change.

---

## whitebox-pro-server 2.31.1 · analytics 0.18.1

### Fixed — a time grain with `limit` returned the BUSIEST buckets, not the most recent

`group.by: "week"` with `limit: 8` returned the eight busiest weeks in value order. On live
data: W16, W23, W17, W19, W22, W09, W18, W24. Two things wrong at once — the order, and the
SELECTION. Those weeks are not adjacent, so a line drawn through them joins periods with
gaps between them and reads as a trend that never happened.

`limit` switched the ordering to value-desc for every bucket type. A time grain now defaults
to `order: 'bucket'`: the most RECENT n, returned chronologically, which is what "the last
8 weeks" means. Verified for all four grains — hour, day, week, month — with the limited set
being exactly the tail of the full series in each.

A categorical dimension is unchanged and still ranks by value, because there top-N by value
IS the guardrail: 449 content urls have no natural order and the interesting ones are the
big ones.

`order: 'bucket' | 'value'` is now explicit, so "the five busiest months" stays expressible —
it is a ranking rather than a series, and the caller says which. Fixed in all four places the
ordering was decided: the single-level path, the two-level fact-aggregate path, the
two-dimension cross-tab x-axis, and the anchor cross-tab.

---

## whitebox-pro-server 2.31.0 · analytics 0.18.0 · ui 0.14.0

### API versioning — a contract number a caller can pin

Five breaking changes shipped in about a day, every one of them correct, and nothing built
on the API could pin behaviour across any of them: there was no version in the request, in
the response, or in the grammar.

Every resolve response now carries `version: { contract, current, server, changelog }`, and
`version: <n>` is accepted on `analytics_resolve` / `analytics_widget_resolve`. An unknown
version is REFUSED with a 400 naming what is on offer, not rounded to the nearest — a
client pinning 3 was built against something this deployment does not have.

The CONTRACT is deliberately not the package version, which moves for an unrelated bug fix.
It moves only when a working query would answer differently or stop working:

  1 — the result at the ROOT, no envelope (deprecated at analytics 0.16.0, still served)
  2 — { data, applied, warnings, version } (current)

Honest about the limit: pinning cannot bring back data. The booking_* facts are deleted, so
no contract can serve a query against them, and the anchor default and strict parsing are
not separable from the current engine. Contract 1 exists because the envelope is the one
change that stops a client PARSING a response rather than merely changing a number — that
is where a compatibility window earns its keep. `analytics_grammar` lists every contract
with what changed in it.

### `first_seen` / `last_seen` — when a bucket first and last saw an event

`min(ts)` and `max(ts)` per bucket, as ISO instants. `earliest`/`latest` order BY event time
and return a FIELD's value, so "when did this bucket first see anything" had no expression:
`column: 'ts'` was refused and every other shape asked for a value to read. A studio's
opening date is `first_seen` by `attr:location`; a dormant location is `last_seen`. Both had
to be written in raw SQL.

Named separately rather than by widening earliest/latest, because those mean "the value AT
the first event" and these mean "the time OF it" — one word for both is how `last` came to
mean four things. They take no source, refused by the engine AND the validator: ignoring one
would answer a question about time while naming one about money.

### Fixed — the console served no favicon, so clients showed GPoint's icon

`whitebox.gpoint.bg` declared `rel=icon` pointing at `logo.svg` and served no
`/favicon.ico`. A browser reads the tag; many clients do not — they probe `/favicon.ico` at
the origin, got a 404, fell back to the registrable domain, and showed `gpoint.bg`'s icon
for a WhiteBox server. The mark was never missing, only unreachable under a name anyone
looks for. The console now ships `favicon.ico` (16/32/48), `favicon.svg` and
`apple-touch-icon.png`, rendered from the existing logo.

---

## whitebox-pro-server 2.30.0 · analytics 0.17.0

### `attrs` take the fact operator set

`eq · ne · in · gt · gte · lt · lte · contains · startsWith · endsWith · present`, where
before there were three: a value, `{in: […]}`, `{present: true}`. So an event attribute
supported equality and nothing else — no range, no negation — while a fact supported
fourteen operators including change detection. "Who increased their visits" was trivial
and "bookings over 100 lv" was inexpressible.

The asymmetry got worse in 2.24.0, when the six `booking_*` facts became booking EVENTS.
`cost`/`paid`/`first` were per-booking data wrongly modelled as customer facts, so moving
them was right — but it moved them from the surface with fourteen operators to the one
with three. The model became more honest and less answerable in the same change.

`gt/gte/lt/lte` compare numerically when the bound is a number and as text otherwise, so
an ISO date works. Several operators AND together. `ne` requires the attribute to be
present — a booking with no `location` is unknown, not "not Варна".

### `analytics_grammar` — the grammar, as a call

`analytics_schema` gives the vocabulary (which fact keys, which event actions, which
channels); nothing gave the syntax, and `analytics_describe_query` runs query → prose. So
the grammar could only be learned by writing something wrong and reading the error. Every
improvement to those errors made the guessing cheaper without removing it.

Generated from the engine's exported constants, so it cannot describe a language the
engine does not speak. It also names the overloaded words, none of which can be renamed
without breaking stored widgets: `last` means four different things depending on where it
sits, and `limit`/`seriesLimit` bound different dimensions.

### Fixed — two drifts the grammar work exposed on its first run

· The validator listed `missing` where the engine reads `missingAnchor`, and its mode list
  had no `bucket`. `analytics_resolve` does not validate, so the anchor cross-tab
  previewed correctly and was refused the moment anyone tried to SAVE it as a widget.
  Both constants are now imported from the engine instead of restated.
· The attrs check would have rejected every new operator above. Fourth instance of this
  validator being stricter than the engine, after the temporal operators, the value
  aggregates and `contains`.

---

## whitebox-pro-server-plugin-analytics 0.16.1

### Fixed — malformed JSON was answered with the whole population

A query string with one surplus closing brace was accepted, the filter discarded, and the
response was the total passport count — 301,787 — for a query whose real answer was 17.
Reproducibly, so it read as a real number.

Two places, the same mechanism: a JSON string that failed to parse was replaced with
something harmless-looking. At the MCP boundary it was returned unchanged, after which
`q.selector` is undefined; in `runQuery` it became `{}`. An undefined or empty filter is
EVERYONE, so "cannot read this request" degenerated into "no filter at all".

Both now refuse with a 400 naming the parse position and marking it in context. An
explicitly empty `{}` still means the whole base — that is a real request; only an
unreadable one is refused.

Worth noting where this came from: the string-coercion was itself added to fix exactly
this symptom for VALID JSON strings, and its own `catch` branch preserved the bug for
invalid ones. The error path of a fix is part of the fix.

---

## whitebox-pro-server-plugin-analytics 0.16.0 · whitebox-pro-server 2.28.0

### BREAKING — the resolve envelope is now UNCONDITIONAL

`analytics_resolve` and `analytics_widget_resolve` always return

```json
{ "data": …, "applied": {}, "warnings": [] }
```

0.15.x wrapped only when there was something to report, which was the conservative
choice and the wrong one: whether a query warns depends on the DATA, not the request, so
a caller could not tell from its own query which shape it would get. In practice about
half of queries came back each way and every client had to probe for `data` — code
reading `data.count` broke on the bare half, and code reading `count` broke on the
wrapped half. One shape always costs a single break instead of a permanent ambiguity.

`res?.data ?? res` keeps working across both, if you need to straddle versions.

Still unaffected: the REST routes and core `selector.resolve()`, which is what the
console reads.

### `group.seriesLimit` — raised ceiling, and the truncation notice now names it

The cap on the SERIES dimension of a two-dimension `by` was discoverable only from the
source. `seriesTruncated` said `{ shown: 6, cap: 6 }` and nothing about how to raise it,
so a 125-studio network read as permanently visible six at a time — the exact question
cross-tab was added for. The notice now carries `raise`, naming the knob and the maximum,
and the ceiling went from 50 to 200 because a pivot or a table legitimately wants every
studio. The DEFAULT stays 6: that is right for a chart.

`limit` and `seriesLimit` bound different dimensions — `limit` the x-axis, `seriesLimit`
the series — and lowering `limit` was expected to trim the series too. Both are now in
the `analytics_resolve` tool description and in the compose prompt, which is where
whoever writes these queries actually looks.

---

## whitebox-pro-server-plugin-analytics 0.15.0 · whitebox-pro-server 2.27.0

### BREAKING — `analytics_resolve` and `analytics_widget_resolve` may return an envelope

When a query rests on a fact whose values are ambiguous for the people it resolved, the
MCP resolve tools return

```json
{ "data": <what they used to return>, "applied": { … }, "warnings": [ … ] }
```

instead of the result at the root. **Anything reading `series`, `count`, `sizes`,
`multi` or an array index off the root breaks for those queries.**

The envelope itself shipped in 0.14.0 but was unreachable: the only warning then was
"ambiguous and undeclared", and every ambiguous key on a configured deployment is
declared, so it never fired. 0.15.0 adds the anchor warning, which fires on a DECLARED
key — so any query with `window: { before|after|between: { fact } }` on an ambiguous key
now gets the envelope. On GPoint that is every anchored query, because `first_booked_at`
is ambiguous for 3,357 passports.

Queries with nothing to report still return the bare result, so this is not a blanket
shape change — which also means **a caller cannot tell the shape from the request**. Read
it defensively:

```js
const rows = res?.data ?? res            // works either way
const warnings = res?.warnings ?? []
```

The REST routes and the core `selector.resolve()` are NOT affected — they never carried
warnings, and the console reads those.

### Fixed — `applied` and `warnings[].used` reported the declared rule, not the resolved one

A query passing `use` on an anchor or a predicate got the right NUMBER and the wrong
provenance: `{ fact: 'first_booked_at', use: 'max' }` returned the max and reported
`min`. The fields exist so a caller can trust which semantics produced a number, so a
wrong `applied` was worse than none. They now follow the engine's precedence — query
`use` > declaration > `last` — and the anchor remedy names the declaration it overrode.

Present from 0.14.0 (where `applied` was introduced) and only observable once anchor
warnings made it fire, i.e. in practice 0.15.0.

---

## whitebox-pro-server 2.26.0 · analytics 0.14.0

- `group.by` accepts **two dimensions** — `["month", "attr:location"]` — returning
  `{ multi, series, aggregate }`. `seriesLimit` caps the series dimension (default 6)
  and `seriesTruncated` declares it when it bites.
- A **malformed but known** query key is refused instead of silently ignored
  (`splitBy: "attr:location"` resolved as though unwritten).
- `band`, `cohortSize`, `use` and `seriesLimit` now cross the HTTP and core-MCP
  boundaries. `groupShape` was `.strict()` and listed only `by`/`limit`, so three
  shipped engine features were unreachable to any caller not running in-process.

## whitebox-pro-server 2.25.0

- **Calendar durations** — `6M`, `1y` — for `last` and the fact temporal windows.
  `h`/`d`/`w` stay fixed spans; `M`/`y` clamp on short months (31 Aug − 6M = 28 Feb) to
  match Postgres interval arithmetic. `m` is refused, since it means minutes elsewhere.
  NOT accepted by `window.offset`/`within`, which are seconds-based.
- `window` errors now name `last`/`since`/`until`. A date handed to `window` used to say
  only "window anchor must be { fact }", which made a solvable question look impossible.
- A temporal operator with no window names the operator and the shape instead of
  reporting `bad window "undefined"`.
- `held`/`distinct` no longer throw when a predicate is tested against a single passport.
- An unknown fact key in a breakdown returns 400 listing the known keys, rather than an
  empty series indistinguishable from "no data".

## whitebox-pro-server 2.24.0

- `use` (`last`/`first`/`min`/`max`) reaches fact **aggregates** and **`fact:` buckets**,
  not only predicates — so a filter and a bucket on the same key can no longer disagree.
- `whitebox_facts_current.value_count` (migration 007), which is what makes the
  ambiguity report cheap enough to run.
