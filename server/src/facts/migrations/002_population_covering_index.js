// A covering index for the population scan — the shape every chart bucket runs.
//
// Analytics resolves "current value per passport for key K" as
//
//     SELECT DISTINCT ON (passport_id) passport_id, value
//       FROM whitebox_facts WHERE key = ? ORDER BY passport_id, observed_at DESC
//
// and 001's two indexes both miss it. `(passport_id, key, observed_at)` cannot
// seek on key alone — passport_id leads. `(key, observed_at)` seeks on key but
// orders by time, not by passport, so the DISTINCT ON still has to sort; and
// neither carries `value`, so every surviving row needs a heap fetch anyway.
// Postgres correctly concludes the indexes are not worth it and sequentially
// scans the whole table.
//
// Measured on gpoint (56k rows for the key, 243k in the table):
//
//     Seq Scan + external merge sort, 2,816 kB to disk    286 ms
//     Index Only Scan, no sort at all                      39 ms
//
// The column order is the whole design: `key` first so equality seeks, then
// `passport_id` and `observed_at DESC` so the index ALREADY holds the DISTINCT
// ON's ordering — which is what removes the sort rather than merely speeding it
// up. INCLUDE (value) makes it index-only, so the heap is not touched for the
// value the caller actually wants.
//
// RAW SQL, not the schema builder: knex's t.index() cannot express INCLUDE or a
// per-column DESC, and an index missing either is a different index from the one
// measured above — without INCLUDE it is not index-only, and the heap fetch per
// row is most of what was being paid for.
//
// This does not replace 001's indexes. `(passport_id, key, observed_at)` still
// serves the per-passport reads (a profile, a timeline, an as-of lookup), which
// lead with passport_id and would not use this one.
//
// Not CONCURRENTLY: knex runs migrations inside a transaction and CREATE INDEX
// CONCURRENTLY cannot run in one. On a large existing table this takes a brief
// write lock — acceptable at migration time, and the alternative is running it
// by hand outside the migration, which then drifts from the schema.
export const up = knex => knex.raw(`
  CREATE INDEX IF NOT EXISTS whitebox_facts_key_passport_observed_idx
    ON whitebox_facts (key, passport_id, observed_at DESC)
    INCLUDE (value)
`)

export const down = knex => knex.raw(`
  DROP INDEX IF EXISTS whitebox_facts_key_passport_observed_idx
`)
