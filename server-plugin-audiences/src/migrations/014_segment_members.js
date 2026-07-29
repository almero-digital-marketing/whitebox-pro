// Static-list segments — the third segment source, alongside `select` and
// `funnel`. Those two are QUERIES: a segment stores a predicate and its
// membership is recomputed on every resolve, which is why nothing in this
// plugin has ever stored a person-to-segment row. A list is the opposite: its
// membership IS the stored rows, so people can be cherry-picked onto it by
// hand and it still composes into audiences like any other segment.
//
// The FK to whitebox_passports is what makes this safe under identity changes,
// not decoration: core's passports.merge()/erase() discover their tables from
// the FK catalog, so declaring it enrols this table in both for free — a merge
// moves the absorbed person's list rows to the survivor, and an erase deletes
// them. `unique(segment_id, passport_id)` is also discovered (passportUniques),
// so a merge where BOTH passports are on the same list dedupes row-wise instead
// of throwing on the constraint.
export const up = knex => knex.schema.createTable('whitebox_audience_segment_members', t => {
  t.increments('id')
  t.uuid('segment_id').notNullable()
    .references('id').inTable('whitebox_audience_segments').onDelete('CASCADE')
  t.uuid('passport_id').notNullable()
    .references('id').inTable('whitebox_passports').onDelete('CASCADE')
  t.timestamp('added_at', { useTz: true }).defaultTo(knex.fn.now())
  t.string('added_by', 200)                 // who cherry-picked them, for provenance
  t.unique(['segment_id', 'passport_id'])   // on a list once
  t.index('passport_id')                    // "which lists is this person on?"
})

export const down = knex => knex.schema.dropTable('whitebox_audience_segment_members')
