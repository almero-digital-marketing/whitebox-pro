// A journey's event trigger now lists MULTIPLE event names (an array, picked
// via toggles in the UI) rather than one free-typed string — see journeys.js's
// Trigger schema. Existing rows still carry the old single-string shape;
// wrap each into a one-element array so they keep working unchanged.

export const up = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = jsonb_set(trigger, '{event}', to_jsonb(ARRAY[trigger->>'event']))
    WHERE trigger->>'kind' = 'event' AND jsonb_typeof(trigger->'event') = 'string'
  `)
}

export const down = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = jsonb_set(trigger, '{event}', to_jsonb(trigger->'event'->>0))
    WHERE trigger->>'kind' = 'event' AND jsonb_typeof(trigger->'event') = 'array'
  `)
}
