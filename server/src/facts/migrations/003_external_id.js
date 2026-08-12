// An idempotency handle the WRITER owns, so re-sending a fact is free.
//
// Facts are append-only by design and every read is latest-wins, so a duplicate
// row corrupts no answer — `current`, `asOf`, the analytics distributions and
// the scatter/person reads all resolve DISTINCT ON (passport_id) ORDER BY
// observed_at DESC, and the selector's count/sum aggregates run over exposures,
// not over this table. What duplicates cost is storage and honesty: gpoint's
// CRM import re-ran four times in three days and left 813,624 real booking
// observations spread across 1,756,015 rows, 13.2M fact rows where 6.2M were
// warranted.
//
// The handle is the writer's because only the writer knows what makes two
// publishes the same publish. A value tuple cannot: `visits_total = 12` observed
// twice is either one observation sent twice or a genuine re-observation, and
// nothing in the row distinguishes them. `booking:558231` is unambiguous.
//
// SEPARATE from `entity`, which already exists and means something else.
// `entity` is what the fact is ABOUT — a subscription, shared by its status and
// its amount — while `external_id` is WHICH observation this is. crm/state.js
// writes entity = `${kind}:${external_id}` today and nothing has ever read it.
//
// observed_at is IN the key, and that is what keeps the timeline. A status that
// changes appends a new row because its observed_at differs; only a re-send of
// the same observation at the same valid time collides. Without it, a fact with
// a stable external_id could hold exactly one row ever and `history()` would
// have nothing to return.
//
// The column ONLY. The unique index that enforces it lives in 004, after the
// existing rows have adopted their identity from `entity` and been deduped —
// creating it here would look harmless (nothing has an external_id yet, so it
// builds over zero rows) and then reject 004's backfill outright, because the
// history it adopts contains 171,858 rows left by re-runs from before there was
// anything to resolve against.
//
// PARTIAL when it does arrive, so nothing changes for a writer that does not opt
// in: geolocation, journeys and people leave external_id null and keep appending
// exactly as before.
export const up = knex => knex.schema.alterTable('whitebox_facts', t => {
  t.string('external_id', 256)
})

export const down = knex => knex.schema.alterTable('whitebox_facts', t => {
  t.dropColumn('external_id')
})
