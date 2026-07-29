// Who asked for this message. `batch_id` only ever answers that for a BULK
// run — a per-passport send (campaigns' activateForPassport, which is how a
// journey's trigger_campaign step delivers) carries no batch at all, so those
// sends were invisible to any report: not to the campaign that owns the
// content, and not to the journey that fired it.
//
// Both nullable and both plain uuids, deliberately not FKs: sms is a channel
// plugin and must keep working in a deployment with no campaigns or journeys
// plugin installed. Denormalised attribution, same reasoning as
// whitebox_short_clicks.passport_id.
export const up = async knex => {
  await knex.schema.alterTable('whitebox_sms_outbox', t => {
    t.uuid('campaign_id').nullable().index()
    t.uuid('journey_id').nullable().index()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_sms_outbox', t => {
    t.dropColumn('journey_id')
    t.dropColumn('campaign_id')
  })
}
