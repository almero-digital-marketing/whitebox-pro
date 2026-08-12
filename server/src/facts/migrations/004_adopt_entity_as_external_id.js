// Adopt `entity` as `external_id`, dedupe, index, drop.
//
// 003 adds the column; this fills it, and the order matters more than it looks.
// `entity` already holds `${kind}:${external_id}` on every CRM row — 6,257,936
// of 6,257,936 on gpoint, 100% — written by crm/state.js and read by nothing but
// its own stats(). That string IS the identity 003 wants, and it is the ONLY
// place a historical row's identity survives: a fact stores key, value and
// observed_at, and nothing else that could reconstruct which record it came from.
//
// Drop `entity` without adopting it first and every existing row becomes
// permanently unidentifiable. The next publish cannot resolve against them, so
// it appends a second identified copy of a history already present — and the
// nightly republish rewrites each active customer's WHOLE history, so that
// happens to ~2,000 customers a night. The only way back would be wiping
// source='gpoint' and re-running a three-hour backfill. Adopting first makes it
// an UPDATE.
//
// BATCHED, and transaction: false, because the single statement does not work.
// Rehearsed against a branch of production: one `UPDATE … WHERE entity IS NOT
// NULL` over 6.26M rows exceeded the statement timeout and rolled back, adopting
// nothing. A 200k batch finishes comfortably. Postgres rewrites every row it
// touches (MVCC), so the cost is real and has to be paid in pieces.
//
// Resumable for the same reason: each batch commits on its own, and the filter
// is `external_id IS NULL`, so a boot interrupted halfway continues from where
// it stopped rather than starting over or wedging the migration.
//
// The dedupe is the price of the index. 6,086,078 distinct identities are spread
// over 6,257,936 rows — 171,858 surplus across 152,332 identities, up to 5 copies
// each, left by re-runs from before there was anything to resolve against. The
// index cannot be built over them, and there is no judgement to make: rows
// sharing (source, external_id, key, observed_at) are the same observation of the
// same thing at the same instant. Lowest id survives — the one recorded first.
//
// What this does NOT fix is the customer aggregates. Those rows are honest about
// their own instant — they were observed when the backfill ran — but gpoint now
// anchors them at the customer's last TERMINAL booking, which for 99.1% of
// customers is EARLIER than the rows already here (median 2025-12-27 against
// 2026-08-11). `current` takes the latest observed_at, so the old rows keep
// winning and the new anchoring reads as a no-op. Removing them is a deployment
// step, not a migration: it is gpoint's data, it needs a republish behind it to
// refill what it removes, and neither belongs in a boot path.
export const config = { transaction: false }

const BATCH = 200_000

export const up = async knex => {
  for (;;) {
    const { rowCount } = await knex.raw(`
      WITH t AS (
        SELECT id FROM whitebox_facts
         WHERE entity IS NOT NULL AND external_id IS NULL
         ORDER BY id LIMIT ?
      )
      UPDATE whitebox_facts f SET external_id = f.entity
        FROM t WHERE f.id = t.id
    `, [BATCH])
    if (!rowCount) break
  }

  // Self-join on id rather than a window function: no sort over the jsonb value,
  // and the survivor rule is the whole predicate.
  await knex.raw(`
    DELETE FROM whitebox_facts a
     USING whitebox_facts b
     WHERE a.external_id IS NOT NULL
       AND a.source      = b.source
       AND a.external_id = b.external_id
       AND a.key         = b.key
       AND a.observed_at = b.observed_at
       AND a.id          > b.id
  `)

  // CONCURRENTLY is available here precisely because this migration runs outside
  // a transaction — 002 could not, and said so. Worth it: the plain form takes a
  // write lock on a table this size for the length of the build.
  await knex.raw(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS whitebox_facts_external_identity_uidx
      ON whitebox_facts (source, external_id, key, observed_at)
      WHERE external_id IS NOT NULL
  `)

  await knex.schema.alterTable('whitebox_facts', t => {
    t.dropColumn('entity')
  })
}

// Restores the column and its values; the rows the dedupe removed are gone, which
// is what a dedupe is.
export const down = async knex => {
  await knex.schema.alterTable('whitebox_facts', t => {
    t.string('entity', 256)
  })
  await knex.raw('DROP INDEX IF EXISTS whitebox_facts_external_identity_uidx')
  await knex.raw(`UPDATE whitebox_facts SET entity = external_id WHERE external_id IS NOT NULL`)
}
