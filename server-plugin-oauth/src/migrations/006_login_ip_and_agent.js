// Captures the requesting IP + raw User-Agent alongside each login row (see
// 005_logins.js) — display-only context for the admin's login-history view,
// parsed into a readable browser/OS at read time (see userAgent.js).

export const up = async knex => {
  await knex.schema.alterTable('whitebox_oauth_logins', t => {
    t.string('ip', 64).nullable()
    t.text('user_agent').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_oauth_logins', t => {
    t.dropColumn('user_agent')
    t.dropColumn('ip')
  })
}
