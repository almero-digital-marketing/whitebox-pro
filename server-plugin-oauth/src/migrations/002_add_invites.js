// Invite-only registration + a single admin/non-admin distinction (no role
// system — see server-plugin-oauth's README for why). A user created via an
// invite has no password yet; `password_hash IS NULL` IS the "pending" state,
// so there's no separate status column to keep in sync.

export const up = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.string('password_hash', 255).nullable().alter()
    t.string('password_salt', 64).nullable().alter()
    t.boolean('is_admin').notNullable().defaultTo(false)
    // Single-use, expiring — same shape as authorization codes/refresh tokens.
    t.string('invite_token', 64).nullable().unique()
    t.timestamp('invite_expires_at').nullable()
    t.timestamp('invited_at').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.dropColumn('invited_at')
    t.dropColumn('invite_expires_at')
    t.dropColumn('invite_token')
    t.dropColumn('is_admin')
    t.string('password_hash', 255).notNullable().alter()
    t.string('password_salt', 64).notNullable().alter()
  })
}
