// An audience trigger now lists MULTIPLE audiences (an array, picked via
// toggles in the UI, combined by an any/all op — see journeys.js's Trigger
// schema) rather than one `audience_id`. Existing rows still carry the old
// single-id shape; wrap each into a one-element `audience_ids` array with
// `op: 'any'` so they keep working unchanged. The stale `audience_id` key
// must be REMOVED, not just left alongside the new one — the schema is
// `.strict()`, so an unrecognized leftover key blocks every future save
// (the exact bug migration 003 had to clean up for `passport_path`).

export const up = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = (trigger - 'audience_id')
      || jsonb_build_object('audience_ids', jsonb_build_array(trigger->>'audience_id'), 'op', 'any')
    WHERE trigger->>'kind' = 'audience' AND jsonb_exists(trigger, 'audience_id') AND NOT jsonb_exists(trigger, 'audience_ids')
  `)
}

export const down = async knex => {
  await knex.raw(`
    UPDATE whitebox_journeys
    SET trigger = (trigger - 'audience_ids' - 'op') || jsonb_build_object('audience_id', trigger->'audience_ids'->>0)
    WHERE trigger->>'kind' = 'audience' AND jsonb_exists(trigger, 'audience_ids')
  `)
}
