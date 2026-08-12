// `entity` goes; `external_id` (003) says the same thing and says it plainly.
//
// 001 introduced it as "optional link to an external entity, e.g.
// 'subscription:sub_123'" — meaning what the fact is ABOUT, as distinct from
// which observation it is. That distinction never earned its keep: the only
// writer was crm/state.js, which set it to `${kind}:${external_id}` — an
// external id with its kind on the front — and the only reader was that same
// plugin's stats(), using "entity is not null" as a proxy for "crm wrote this".
//
// So one column was carrying an external identifier under a name that suggested
// something subtler, and every consumer had to be told which of the two it
// actually was. Both jobs belong to external_id, which is named for what it
// holds and is now the thing an integrator resolves against.
//
// NOT backfilled into external_id, deliberately. The values would fit, but
// 003's unique index covers exactly the rows where external_id is not null, and
// the existing rows are the duplicated ones — gpoint's re-run left 22,897
// booking observations holding two to six rows each. Backfilling would either
// fail on the index or force a dedupe decision inside a migration, where it
// cannot be reviewed. History keeps its provenance in `source`; new writes get
// the handle.
export const up = knex => knex.schema.alterTable('whitebox_facts', t => {
  t.dropColumn('entity')
})

export const down = knex => knex.schema.alterTable('whitebox_facts', t => {
  t.string('entity', 256)
})
