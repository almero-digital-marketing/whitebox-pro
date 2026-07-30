// Data access. Thin knex wrappers — no business logic. init() + free functions.

import { pagedList } from 'whitebox-pro-server/pagination'

let db

const CAMPAIGNS = 'whitebox_campaigns'
const CAMPAIGN_AUDIENCES = 'whitebox_campaign_audiences'
const SENDS = 'whitebox_campaign_sends'

export function init({ db: knex }) { db = knex }

// --- campaigns ---
export const listCampaigns = () => db(CAMPAIGNS).orderBy('created_at', 'desc')
// One page for the rail, with the real total — see the audiences store for why
// the unpaged list stays beside it.
export const searchCampaigns = opts => pagedList(db(CAMPAIGNS), { ...opts, fields: ['name'] })
export const getCampaign = id => db(CAMPAIGNS).where({ id }).first()
export const getCampaignByExternalId = external_id => db(CAMPAIGNS).where({ external_id }).first()
export async function insertCampaign(c) {
  const [row] = await db(CAMPAIGNS).insert(c).returning('*')
  return row
}
export async function updateCampaign(id, fields) {
  const [row] = await db(CAMPAIGNS).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteCampaign = id => db(CAMPAIGNS).where({ id }).del()

// --- campaign ⇄ audience (many-to-many) ---
export const audienceIds = campaign_id =>
  db(CAMPAIGN_AUDIENCES).where({ campaign_id }).orderBy('created_at').pluck('audience_id')
export const attachAudience = (campaign_id, audience_id) =>
  db(CAMPAIGN_AUDIENCES).insert({ campaign_id, audience_id }).onConflict(['campaign_id', 'audience_id']).ignore()
export const detachAudience = (campaign_id, audience_id) =>
  db(CAMPAIGN_AUDIENCES).where({ campaign_id, audience_id }).del()
export const clearAudiences = campaign_id => db(CAMPAIGN_AUDIENCES).where({ campaign_id }).del()

// --- health (see ../../docs/10-plugin-status.md) ---
// One grouped read over the campaigns table, carrying both shapes of number the
// status card needs — separated deliberately, because they mean different things:
//
//   · `sent` / `dry_run` are WINDOWED on sent_at. A delivery is an event that
//     happened at a time, so it belongs to a window.
//   · `draft` / `scheduled` / `overdue` are CURRENT STATE and take no `since`.
//     A campaign sitting in draft didn't happen at a time — it just is — and
//     `status` holds only where the campaign is now, not when it got there.
//
// `overdue` is the one worth waking up for. schedule() only delivers a campaign
// whose send time has already passed at the moment it is scheduled; a campaign
// committed for a FUTURE time is parked at status='scheduled' to await a send
// worker, and this plugin ships none. So a scheduled campaign whose
// `scheduled_at` is now in the past is one nothing will ever send, and nothing
// else in the system will say so.
//
// `dry_run` reads stats->>'dry_run', stamped by runDelivery() on every send.
// It is NOT a failure — it's the configured safety mode doing its job — so it's
// reported plainly and the note explains it.
export const healthCounts = async (since) => {
  const [row] = await db(CAMPAIGNS).select(
    db.raw(`count(*) FILTER (WHERE sent_at >= ?)::int                                      AS sent`, [since]),
    db.raw(`count(*) FILTER (WHERE sent_at >= ? AND stats->>'dry_run' = 'true')::int       AS dry_run`, [since]),
    db.raw(`count(*) FILTER (WHERE status = 'scheduled')::int                              AS scheduled`),
    db.raw(`count(*) FILTER (WHERE status = 'draft')::int                                  AS draft`),
    db.raw(`count(*) FILTER (WHERE status = 'scheduled' AND scheduled_at <= now())::int    AS overdue`),
  )
  return row
}

// --- send audit ---
// Newest first: a campaign can be sent more than once and the results block
// leads with the latest run.
export const listSends = campaign_id =>
  db(SENDS).where({ campaign_id }).orderBy('sent_at', 'desc')

export async function insertSend(s) {
  const [row] = await db(SENDS).insert(s).returning('*')
  return row
}
