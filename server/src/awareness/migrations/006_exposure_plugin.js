// Which subsystem collected an exposure was never recorded — only `source`
// (a content label the calling plugin picks: 'text', 'booking', 'image'…) and
// `channel` ('web', 'crm'…). Neither identifies the plugin: 'web' alone covers
// engagement, conversions and shortener. Going forward the loader stamps this
// automatically (see server/src/plugins.js), so no plugin has to remember to
// pass it.
//
// The backfill below maps the historical `source` values to the plugin that
// emitted them. That map is deliberately confined to this migration — it
// describes history, which can't change. Live rows get the real value from the
// loader instead, so the map never has to be kept in sync with new plugins.
const SOURCE_TO_PLUGIN = {
  text: 'engagement', link: 'engagement', image: 'engagement', video: 'engagement',
  page: 'engagement', section: 'engagement', form: 'engagement',
  booking: 'crm', client: 'crm', deal: 'crm', subscription: 'crm',
  conversion: 'conversions',
  shortlink: 'shortener',
  email: 'mail',
  sms: 'sms',
  call: 'voip', outbound: 'voip', inbound: 'voip',
}

// Fallback for rows whose `source` is a campaign/ad label rather than a
// content type ('newsletter', 'promo', 'instagram'…): the channel identifies
// the subsystem unambiguously for everything except 'web', which several
// plugins share. Those stay null rather than being guessed.
const CHANNEL_TO_PLUGIN = { mail: 'mail', sms: 'sms', voip: 'voip', crm: 'crm' }

export async function up(knex) {
  const has = await knex.schema.hasColumn('whitebox_awareness_exposures', 'plugin')
  if (!has) {
    await knex.schema.alterTable('whitebox_awareness_exposures', (t) => {
      t.string('plugin').nullable().index()
    })
  }
  // every statement is whereNull-guarded, so re-running this is a no-op
  for (const [source, plugin] of Object.entries(SOURCE_TO_PLUGIN)) {
    await knex('whitebox_awareness_exposures').where({ source }).whereNull('plugin').update({ plugin })
  }
  for (const [channel, plugin] of Object.entries(CHANNEL_TO_PLUGIN)) {
    await knex('whitebox_awareness_exposures').where({ channel }).whereNull('plugin').update({ plugin })
  }
}

export async function down(knex) {
  const has = await knex.schema.hasColumn('whitebox_awareness_exposures', 'plugin')
  if (has) await knex.schema.alterTable('whitebox_awareness_exposures', (t) => t.dropColumn('plugin'))
}
