// The standalone Rule entity (whitebox_audience_rules + its matches/deliveries
// audit trail) was fully wired — a BullMQ worker, a daily keep-warm sweep,
// REST + MCP CRUD — but never adopted: no UI ever wrote to it, and the live
// Audiences feature (segments composed into whitebox_audiences) is a
// completely separate table. Dropping it as unused surface area.
// Drop order respects the FK: matches -> rules.
export const up = async knex => {
  await knex.schema.dropTableIfExists('whitebox_audience_matches')
  await knex.schema.dropTableIfExists('whitebox_audience_deliveries')
  await knex.schema.dropTableIfExists('whitebox_audience_rules')
}

// Recreates the final (post-007/008) shape, for a clean rollback.
export const down = async knex => {
  await knex.schema.createTable('whitebox_audience_rules', t => {
    t.string('id', 64).primary()
    t.string('name', 200).notNullable()
    t.boolean('enabled').notNullable().defaultTo(false)

    t.jsonb('selector').nullable()
    t.jsonb('funnel').nullable()
    t.string('slot', 32).nullable()
    t.string('status', 16).nullable()

    t.integer('ttl_days').notNullable().defaultTo(30)
    t.string('policy', 32).notNullable().defaultTo('non_sensitive')
    t.jsonb('delivery').notNullable().defaultTo('{}')

    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
    t.string('updated_by', 200)
    t.index('enabled')
  })

  await knex.schema.createTable('whitebox_audience_matches', t => {
    t.bigIncrements('id')
    t.string('rule_id', 64).notNullable().references('id').inTable('whitebox_audience_rules').onDelete('CASCADE')
    t.uuid('passport_id').notNullable()

    t.boolean('qualified').notNullable().defaultTo(false)
    t.float('score')
    t.text('reason')
    t.jsonb('evidence')

    t.timestamp('first_matched_at', { useTz: true })
    t.timestamp('last_evaluated_at', { useTz: true }).defaultTo(knex.fn.now())
    t.timestamp('last_fired_at', { useTz: true })
    t.jsonb('fired').notNullable().defaultTo('{}')

    t.unique(['rule_id', 'passport_id'])
    t.index(['rule_id', 'qualified'])
    t.index('passport_id')
    t.index('last_fired_at')
  })

  await knex.schema.createTable('whitebox_audience_deliveries', t => {
    t.bigIncrements('id')
    t.string('rule_id', 64).notNullable()
    t.uuid('passport_id').notNullable()
    t.string('network', 16).notNullable()
    t.string('event_name', 64).notNullable()
    t.string('event_id', 64).notNullable()
    t.string('status', 16).notNullable()
    t.jsonb('matched_via')
    t.text('error')
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.index(['rule_id', 'created_at'])
    t.index(['network', 'status'])
    t.index('passport_id')
  })
}
