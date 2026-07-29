// `whitebox_audience_suppression.passport_id` has always been a real reference
// to `whitebox_passports(id)` but was never declared as one. That matters
// because core's `passports.merge()` discovers the tables it must re-point from
// the Postgres FK catalog ("no hardcoded table list, new plugin tables included
// for free") — so without the constraint, merging two passports silently left
// the suppression row pointing at the absorbed tombstone and **the suppressed
// person became targetable again**.
//
// Declaring the FK is the fix: merge (and now erase) pick the table up
// automatically, and any future table that declares its own FK is covered the
// same way. Safe to add — checked against the dev DB, zero rows point at a
// merged-away passport.
//
// ON DELETE CASCADE deliberately: a passport erased for a right-to-be-forgotten
// request must take its suppression row with it, which is exactly what
// docs/08-consent-privacy.md already says should happen.
const TABLE = 'whitebox_audience_suppression'

export async function up(knex) {
  // Drop any row whose passport no longer exists — the constraint would reject
  // it, and an orphan here is unreachable anyway (nothing can resolve to it).
  await knex.raw(`
    DELETE FROM ${TABLE} s
    WHERE NOT EXISTS (SELECT 1 FROM whitebox_passports p WHERE p.id = s.passport_id)
  `)
  await knex.schema.alterTable(TABLE, (t) => {
    t.foreign('passport_id').references('id').inTable('whitebox_passports').onDelete('CASCADE')
  })
}

export async function down(knex) {
  await knex.schema.alterTable(TABLE, (t) => t.dropForeign('passport_id'))
}
