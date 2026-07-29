// Login history — one row per successful authorization_code redemption (a
// real login), NOT per refresh_token grant (a silent renewal of an existing
// session). See routes.js's handleAuthCodeGrant, the only caller of
// store.recordLogin().

export const up = async knex => {
  await knex.schema.createTable('whitebox_oauth_logins', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.uuid('user_id').notNullable().references('id').inTable('whitebox_oauth_users').onDelete('CASCADE')
    t.string('client_id', 64).notNullable().references('client_id').inTable('whitebox_oauth_clients').onDelete('CASCADE')
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['user_id', 'created_at'])
  })
}

export const down = async knex => {
  await knex.schema.dropTableIfExists('whitebox_oauth_logins')
}
