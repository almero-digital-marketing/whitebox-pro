// Marks a client as self-registered via Dynamic Client Registration (RFC 7591) rather than
// created by an operator.
//
// The flag exists to make pruning safe. DCR has no "get or create" — every POST /register
// mints a NEW client_id — so a reinstall, a cleared cache or a second machine each leave
// another row behind, and the table grows without bound. Pruning is the answer, but it must
// never touch a client an operator registered deliberately and hasn't used yet.
//
// `created_at` already exists (001), so age needs no new column; only provenance does.

export const up = async knex => {
  await knex.schema.alterTable('whitebox_oauth_clients', t => {
    t.boolean('dynamic').notNullable().defaultTo(false)
  })
  // Every existing row predates DCR and was therefore operator-created. The default above
  // already gives them `false`; this is only stated so the intent survives a reader who
  // wonders whether old rows are prunable. They are not.
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_oauth_clients', t => {
    t.dropColumn('dynamic')
  })
}
