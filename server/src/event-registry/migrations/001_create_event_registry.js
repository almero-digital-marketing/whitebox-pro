export const up = knex => knex.schema.createTable('whitebox_event_registry', t => {
  t.string('type', 128).primary()
  t.timestamp('first_seen_at', { useTz: true }).notNullable()
  t.timestamp('last_seen_at', { useTz: true }).notNullable()
  t.integer('count').notNullable().defaultTo(0)
  t.index('last_seen_at')
})

export const down = knex => knex.schema.dropTable('whitebox_event_registry')
