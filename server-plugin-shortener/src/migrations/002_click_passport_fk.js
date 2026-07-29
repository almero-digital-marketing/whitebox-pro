// `whitebox_short_clicks.passport_id` was created deliberately without a FK
// ("who claimed it (audit; denormalized, no FK)"). Revisiting that, because two
// operations need to find this table and both discover their targets from the
// Postgres FK catalog:
//
//   · merge()  — a click attributed to an absorbed passport must follow to the
//                survivor, or click attribution fragments across a merge.
//   · erase()  — a click row holds passport_id, ip AND user_agent. That's
//                personal data; a right-to-be-forgotten delete that skips it is
//                incomplete.
//
// The original reason for skipping the FK still holds and is respected: the row
// is written BEFORE identity is known, so `passport_id` stays nullable — a NULL
// satisfies the constraint, so the insert path is unchanged. The check only
// costs anything on the later claim UPDATE, which is low-volume by design
// (one per actual claim, not per click).
const TABLE = 'whitebox_short_clicks'

export async function up(knex) {
  // A non-null passport_id whose passport no longer exists would be rejected by
  // the constraint. Null it rather than dropping the row — the click itself is
  // still a real event worth keeping, it just has no one to attribute it to.
  await knex.raw(`
    UPDATE ${TABLE} c SET passport_id = NULL
    WHERE c.passport_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM whitebox_passports p WHERE p.id = c.passport_id)
  `)
  await knex.schema.alterTable(TABLE, (t) => {
    t.foreign('passport_id').references('id').inTable('whitebox_passports').onDelete('CASCADE')
  })
}

export async function down(knex) {
  await knex.schema.alterTable(TABLE, (t) => t.dropForeign('passport_id'))
}
