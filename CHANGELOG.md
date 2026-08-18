# Changelog

Notable and especially BREAKING changes, newest first. Packages in this repo version
independently; entries name the package and version that carries the change.

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
