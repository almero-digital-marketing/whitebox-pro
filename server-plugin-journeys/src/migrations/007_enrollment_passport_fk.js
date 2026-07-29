// `whitebox_journey_enrollments.passport_id` is a real reference that was never
// declared as one, so core's `passports.merge()` — which finds the tables it
// must re-point from the Postgres FK catalog — skipped it entirely. A merge
// therefore left enrollments pointing at the absorbed tombstone, where the
// service's re-enrollment dedupe (which looks them up by the SURVIVOR's id)
// could no longer see them: the same person could be enrolled twice into a
// journey they had already run.
//
// Declaring the FK fixes merge and, with CASCADE, makes erase() reach it too —
// deleting a person takes their enrollments, and `whitebox_journey_step_runs`
// already cascades from enrollments, so the run history goes with them.
//
// Safe to add: verified against the dev DB, zero enrollments point at a
// merged-away passport.
const TABLE = 'whitebox_journey_enrollments'

export async function up(knex) {
  // passport_id is NOT NULL here, so an orphan can't be nulled — it has to go.
  // An enrollment whose passport no longer exists is unrunnable anyway: the
  // executor resolves the passport on every step.
  await knex.raw(`
    DELETE FROM ${TABLE} e
    WHERE NOT EXISTS (SELECT 1 FROM whitebox_passports p WHERE p.id = e.passport_id)
  `)
  await knex.schema.alterTable(TABLE, (t) => {
    t.foreign('passport_id').references('id').inTable('whitebox_passports').onDelete('CASCADE')
  })
}

export async function down(knex) {
  await knex.schema.alterTable(TABLE, (t) => t.dropForeign('passport_id'))
}
