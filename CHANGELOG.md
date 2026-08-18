# Changelog

Notable and especially BREAKING changes, newest first. Packages in this repo version
independently; entries name the package and version that carries the change.

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
