// The registry was aggregate-only (one row per type, a count + first/last
// seen) — you could see a name existed, never what actually happened. This
// converts it into a real per-occurrence log: one row per event, carrying
// its full payload and (when present) the passport it happened to. The
// aggregate view list() still stays available — derived with a
// GROUP BY over the log rather than stored as its own row.

export const up = async knex => {
  await knex.schema.alterTable('whitebox_event_registry', t => {
    t.dropPrimary()
    t.uuid('id')
    t.jsonb('data')
    t.string('passport_id', 64)
    t.timestamp('occurred_at', { useTz: true })
  })
  // Existing rows are aggregate-only (a count, not individual occurrences) —
  // there's nothing to faithfully split into real log entries. This table
  // was always documented as a rolling, retention-pruned window, not
  // permanent history, so starting the log fresh here is consistent with
  // that design, not a data-loss regression.
  await knex('whitebox_event_registry').del()
  await knex.schema.alterTable('whitebox_event_registry', t => {
    t.dropColumn('first_seen_at')
    t.dropColumn('last_seen_at')
    t.dropColumn('count')
    t.primary(['id'])
    t.index('type')
    t.index('occurred_at')
    t.index('passport_id')
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_event_registry', t => {
    t.dropPrimary()
    t.dropColumn('id')
    t.dropColumn('data')
    t.dropColumn('passport_id')
    t.dropColumn('occurred_at')
    t.timestamp('first_seen_at', { useTz: true })
    t.timestamp('last_seen_at', { useTz: true })
    t.integer('count').defaultTo(0)
  })
  await knex('whitebox_event_registry').del()
  await knex.schema.alterTable('whitebox_event_registry', t => {
    t.primary(['type'])
  })
}
