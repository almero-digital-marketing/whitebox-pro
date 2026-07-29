// A journey = a trigger + a step graph (jsonb — walked in memory by the
// executor, never queried by sub-field, same convention as
// whitebox_campaigns.message / whitebox_audiences.rule). An enrollment is
// one passport's run through a journey; step_runs is its append-only audit
// log — the discipline campaigns' own insertSend() never got wired up to.

export const up = async knex => {
  await knex.schema.createTable('whitebox_journeys', t => {
    t.uuid('id').primary()
    t.text('name').notNullable()
    t.text('status').notNullable().defaultTo('draft')   // draft | active | paused | archived
    t.jsonb('trigger').notNullable()
    t.jsonb('steps').notNullable()
    t.jsonb('dedupe')
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
    t.index('status')
  })

  await knex.schema.createTable('whitebox_journey_enrollments', t => {
    t.uuid('id').primary()
    t.uuid('journey_id').notNullable().references('id').inTable('whitebox_journeys').onDelete('CASCADE')
    t.uuid('passport_id').notNullable()
    t.text('status').notNullable().defaultTo('active')   // active | waiting | completed | exited | failed
    t.text('current_step_id')
    t.jsonb('context').notNullable().defaultTo('{}')
    t.timestamp('next_action_at', { useTz: true })
    t.timestamp('enrolled_at', { useTz: true }).defaultTo(knex.fn.now())
    t.timestamp('completed_at', { useTz: true })
    t.timestamp('exited_at', { useTz: true })
    t.text('exit_reason')
    t.index(['journey_id', 'passport_id'])
    t.index(['journey_id', 'status'])
    t.index('passport_id')
  })

  await knex.schema.createTable('whitebox_journey_step_runs', t => {
    t.uuid('id').primary()
    t.uuid('enrollment_id').notNullable().references('id').inTable('whitebox_journey_enrollments').onDelete('CASCADE')
    t.uuid('journey_id').notNullable()   // denormalized — cheap per-journey audit queries without a join
    t.text('step_id').notNullable()
    t.text('kind').notNullable()
    t.jsonb('result')
    t.timestamp('ran_at', { useTz: true }).defaultTo(knex.fn.now())
    t.index(['enrollment_id', 'ran_at'])
    t.index(['journey_id', 'ran_at'])
  })
}

export const down = async knex => {
  await knex.schema.dropTableIfExists('whitebox_journey_step_runs')
  await knex.schema.dropTableIfExists('whitebox_journey_enrollments')
  await knex.schema.dropTableIfExists('whitebox_journeys')
}
