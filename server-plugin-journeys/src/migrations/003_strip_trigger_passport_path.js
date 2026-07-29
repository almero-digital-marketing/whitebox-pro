// The event trigger's `passport_path` option was removed from the schema
// (journeys.js's Trigger no longer declares it — data.passport_id is the only
// shape triggers.js ever reads). Existing rows still carry the stale key,
// which the now-strict schema rejects on save — strip it so those journeys
// stay editable.

// knex's .raw() treats a bare `?` as its own placeholder syntax, which
// collides with Postgres's `?` JSONB key-existence operator — use
// jsonb_exists() instead to sidestep that entirely.
export const up = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = trigger - 'passport_path'
    WHERE jsonb_exists(trigger, 'passport_path')
  `)
}

export const down = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = trigger || '{"passport_path": "data.passport_id"}'::jsonb
    WHERE trigger->>'kind' = 'event' AND NOT jsonb_exists(trigger, 'passport_path')
  `)
}
