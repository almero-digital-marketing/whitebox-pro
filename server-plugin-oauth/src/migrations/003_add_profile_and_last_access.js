// Self-reported profile (set once, at accept-invite time, alongside the
// password) + a last-access timestamp, touched on every GET /me — which
// fires on login and on every silent refresh, so it tracks activity without
// a write on every single authenticated request.

export const up = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.string('first_name', 255).nullable()
    t.string('last_name', 255).nullable()
    t.string('phone', 32).nullable()
    t.timestamp('last_access_at').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.dropColumn('last_access_at')
    t.dropColumn('phone')
    t.dropColumn('last_name')
    t.dropColumn('first_name')
  })
}
