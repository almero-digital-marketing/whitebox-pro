// Data layer for links + clicks. Module-level singleton (init once), matching
// the core pattern.

const LINKS = 'whitebox_short_links'
const CLICKS = 'whitebox_short_clicks'

let db

export function init(deps) { db = deps.db }

// ── links ──────────────────────────────────────────────────────────────────

export async function insertLink(row) {
  const [out] = await db(LINKS).insert(row).returning('*')
  return out
}

export const getLink = (code) => db(LINKS).where({ code }).first()

export const bumpClicks = (code) => db(LINKS).where({ code }).increment('click_count', 1)

export const consumeIdentity = (code, when) =>
  db(LINKS).where({ code }).whereNull('identity_consumed_at').update({ identity_consumed_at: when })

export const listLinks = ({ limit = 50, offset = 0 } = {}) =>
  db(LINKS).orderBy('created_at', 'desc').limit(limit).offset(offset)

// ── clicks ─────────────────────────────────────────────────────────────────

export async function insertClick(row) {
  const [out] = await db(CLICKS).insert(row).returning('*')
  return out
}

export const getClick = (claim_token) => db(CLICKS).where({ claim_token }).first()

// Single-use: win the ticket atomically — set claimed_at only if still null.
// Returns the updated-row count (1 = we won the race, 0 = already claimed).
export const claimToken = (claim_token, when) =>
  db(CLICKS).where({ claim_token }).whereNull('claimed_at').update({ claimed_at: when })

// Stamp who claimed it (after the bind resolves the passport).
export const setClickPassport = (claim_token, passport_id) =>
  db(CLICKS).where({ claim_token }).update({ passport_id })

export async function clickStats(code) {
  const [{ total }] = await db(CLICKS).where({ code }).count('* as total')
  const [{ claimed }] = await db(CLICKS).where({ code }).whereNotNull('claimed_at').count('* as claimed')
  const last = await db(CLICKS).where({ code }).orderBy('ts', 'desc').first()
  return { total: Number(total), claimed: Number(claimed), last_at: last?.ts || null }
}

// ── health ─────────────────────────────────────────────────────────────────

// Windowed counts for the monitoring card (see service.status).
//
// Two queries, not one join: links are windowed on `created_at` and clicks on
// `ts`, and a link created inside the window is routinely clicked outside it (and
// the reverse). Joining them would both mis-window and double-count every link
// that has more than one click.
export async function healthStats({ since } = {}) {
  const from = since ? (since instanceof Date ? since : new Date(since)) : null

  const linkQ = db(LINKS)
  if (from) linkQ.where('created_at', '>=', from)
  const [links] = await linkQ.select(
    db.raw('count(*)::int AS created'),
    // Personalized = can bind identity on click: a bound passport, or an
    // `identify` payload to resolve at click time. The rest are plain campaign
    // links that redirect and nothing more.
    db.raw('count(*) FILTER (WHERE passport_id IS NOT NULL OR identify IS NOT NULL)::int AS personalized'),
  )

  const clickQ = db(CLICKS)
  if (from) clickQ.where('ts', '>=', from)
  const [clicks] = await clickQ.select(
    db.raw('count(*)::int AS total'),
    db.raw('count(claimed_at)::int AS claimed'),
    // Token expired with no claim: the redirect worked, but the destination page
    // never redeemed it. Link scanners and mail-client prefetchers do this all
    // day, so on its own it is NOT a failure — only "all of them, always" is,
    // which is why it carries no severity and sits next to `claimed`.
    db.raw('count(*) FILTER (WHERE claimed_at IS NULL AND expires_at < now())::int AS expired_unclaimed'),
    // The ticket was burned and nobody was bound: claim() won the single-use
    // race and then failed to attribute (the link was gone, or it threw between
    // claimToken and setClickPassport — the two are not one transaction). The
    // minute of grace keeps a claim that is in flight RIGHT NOW out of the count,
    // so this can't flap on a healthy system.
    db.raw(`count(*) FILTER (WHERE claimed_at IS NOT NULL AND claimed_at < now() - interval '1 minute' AND passport_id IS NULL)::int AS unbound`),
  )

  return { links, clicks }
}
