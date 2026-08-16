# Frozen fixture — GPoint dataset, 14 Aug 2026

Acceptance values for the analytics query-grammar work (`group` clause handling,
`fact:` grain/limit, `metric.window`, cohort-relative session predicates).

The values in the original brief were read from the **live** production dataset and
drifted while being read. They are not usable as assertions. Everything below was
measured against a frozen Neon branch and is reproducible.

## The snapshot

| | |
|---|---|
| Neon project | `lucky-rice-88260820` — *GPoint Bulgaria WhiteBox* |
| Production branch | `br-billowing-truth-asew2hzx` — **never write to this** |
| Scratch branch | `br-crimson-queen-asa0v1tz` — `dbg-resolver` |
| **Frozen fixture** | **`br-billowing-lab-asog5mca`** — `fixture-2026-08-14` |
| Database | `neondb` (12 GB) |

`fixture-2026-08-14` is branched from `dbg-resolver`, which was branched from
production at ~12:52 UTC on 14 Aug 2026. Neon branches are point-in-time and do
not track the parent, so this is immutable as long as nothing writes to it.
Assert against **`br-billowing-lab-asog5mca`** only.

## Drift observed while measuring

Both directions were present simultaneously, which is why a snapshot is required:

- **Counts fell** on already-past days — 11 Aug went 91 → 90, 13 Aug 84 → 83.
  Append-only data cannot do that; passport **merges** collapsing duplicates can.
  Note `first_booked_at` has 114,799 rows across 111,162 distinct passports, so
  ~3,637 people carry more than one value for it.
- **Counts rose** for open-ended ranges — the `first_booked_at >= 2026-07-01`
  cohort went 3,195 → 3,235 as new bookings landed.

## Semantics: latest-value-per-passport

"People whose `first_booked_at` falls on day D" is computed as **the latest fact
row per passport**, then bucketed:

```sql
SELECT DISTINCT ON (passport_id) passport_id, (value #>> '{}')::timestamptz AS fb
FROM whitebox_facts WHERE key = 'first_booked_at'
ORDER BY passport_id, observed_at DESC NULLS LAST, id DESC
```

Not "any row matching". With ~3,637 multi-valued passports, any-row lets one
person land in two day-buckets, so the daily series would sum above the distinct
population — wrong by construction for "new customers per day". Latest-per-passport
also matches the store's existing `latestByPassport` / `factBreakdown` convention.

The difference is material: any-row gives 963 for 1–13 Aug where latest gives 952.

Day buckets are **UTC**. Europe/Sofia bucketing moves 2–7 people per day across
boundaries and is a separate decision; if the product wants local-time days, the
fixtures must be re-measured.

## Fixtures

New customers per day (latest-per-passport, UTC), `first_booked_at`:

| Day | People | | Day | People |
|---|---|---|---|---|
| 2026-08-01 | 66 | | 2026-08-08 | 72 |
| 2026-08-02 | 69 | | 2026-08-09 | 65 |
| 2026-08-03 | 70 | | 2026-08-10 | 68 |
| 2026-08-04 | 76 | | 2026-08-11 | **90** |
| 2026-08-05 | 73 | | 2026-08-12 | 98 |
| 2026-08-06 | 66 | | 2026-08-13 | **83** |
| 2026-08-07 | 56 | | | |

| Aggregate | Value | Brief said |
|---|---|---|
| 2026-08-13, single call | **83** | 84 |
| Sum 2026-08-01 … 2026-08-13 | **952** | 954 |
| July 2026 | **2230** | 2231 |
| Cohort `first_booked_at >= 2026-07-01` | **3235** | 3195 |
| People with a `first_booked_at` at all | **111162** | — |

Monotonicity pair for 2026-08-12 (`whitebox_awareness_exposures`, `count(*)`,
`by: "day"`):

| | Value |
|---|---|
| Unfiltered | **63805** |
| `session.utm_source in ["adwords","Google","g"]` | **13012** |
| Distinct passports, unfiltered | 17191 |
| Distinct sessions, unfiltered | 15329 |

## Correction to the brief: repro 1B is not a defect

The brief cites 13,012 against a claimed unfiltered 9,645 and calls it a violated
invariant. **13,012 is the correct filtered count**; the true unfiltered figure for
that day is **63,805**. `13012 <= 63805` — the invariant holds and the session
clause is applied as written.

The 9,645 baseline is *smaller* than a correct filtered result, so it cannot have
been that query's superset; it came from a differently-constrained query. It matches
no daily `count(*)`, `count(distinct passport_id)` or `count(distinct session_id)`
for 8–14 Aug under either UTC or Europe/Sofia bucketing.

Both mechanisms that could raise an aggregate were ruled out:

- **Fan-out** — `whitebox_sessions.id` is a real `PRIMARY KEY` (107,138 rows, zero
  duplicate ids), so `leftJoin(sessions, 's.id', 'e.session_id')` in `metric.js` is
  strictly 1:0-or-1 and cannot multiply rows.
- **Aggregate switching** — the time-grain branch of `bucketSql` uses the same
  `aggSql` expression as every other bucket; no branch swaps `count(*)` for
  anything else.

`tests/selector/group-monotonicity.test.js` encodes the invariant as a passing
regression guard over a generated matrix of bucket × aggregate × narrowing clause.

Two smaller corrections:

- The **2022 buckets** in repro 1D are expected, not a dropped `scope`. `scope`
  filters *people*, not time — someone whose `first_booked_at` is May 2026 can have
  browsing exposures from 2022. `cohortScope()` does resolve and apply.
- The **66600/66601 and 57320/57318** difference in repro 1A is most likely the same
  live drift documented above, not the clause perturbing anything. Confirm by running
  one identical unfiltered query twice.

## Still-confirmed defects (root cause located)

`resolveGroup` (`src/selector/knowledge.js:55-61`) forwards only two of its inputs:

```js
return metric.group(rt.db, m, { by: group?.by, limit: group?.limit, at, scope: scopeArr })
```

- **1A** — everything in `selector.filter` except `.metric` is discarded, so a
  sibling `fact` clause silently vanishes.
- **1C** — `fact:` never reaches the engine (`bucketSql` has no such case);
  `composition/routes.js:165-198` diverts to `store.factBreakdown(key, scope)` and
  passes neither `grain` nor `limit`. That signature defaults to `limit = 12`, which
  is the "12 buckets" in the brief.
- **1D** — `by: "day"` resolves to `to_char(e.ts, …)` over exposures with `count(*)`,
  i.e. event rows, and `group.key` is never forwarded.

Note `distinct_passports` **already exists** as a group aggregate (`metric.js:21`,
`:156`), so a caller can choose it today. What is missing is that the response never
states which aggregate produced `value`.
