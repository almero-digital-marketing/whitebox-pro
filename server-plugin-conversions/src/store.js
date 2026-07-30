// Store — the conversion-events audit log. Module-level singleton (init() once),
// matching the core pattern. Gives us idempotency (seen by event_id) plus a
// queryable record of what we sent where.

const TABLE = 'whitebox_conversion_events'

let db
let logger

export function init(deps) {
  db = deps.db
  logger = deps.logger
}

// Has this event_id already been processed? (sendBeacon may double-fire.)
export async function seen(eventId) {
  return db(TABLE).where({ event_id: eventId }).first()
}

export async function insert(row) {
  const [out] = await db(TABLE).insert(row).returning('*')
  return out
}

// Recent events for a passport, newest first.
export async function listForPassport(passportId, { limit = 50, offset = 0 } = {}) {
  return db(TABLE)
    .where({ passport_id: passportId })
    .orderBy('received_at', 'desc')
    .limit(limit)
    .offset(offset)
}

// Recent events across the base, newest first.
export async function list({ limit = 50, offset = 0 } = {}) {
  return db(TABLE)
    .orderBy('received_at', 'desc')
    .limit(limit)
    .offset(offset)
}

const asDate = v => (v instanceof Date ? v : new Date(v))

// Windowed event totals. `received_at` is when we took the event in — the only
// timestamp this table has, and the one "did anything arrive recently" asks about.
//
// `consent_skipped` counts events that reached NO network at all: when consent is
// withheld, ingest writes the whole verdict as `{ skipped: 'consent' }`, a
// pseudo-key where every other key in `networks` is a network name. So a
// top-level `skipped` key is exactly the shape of "recorded first-party, sent
// nowhere" — and it must not be counted as a network called "skipped" below.
export async function stats({ since } = {}) {
  const q = db(TABLE)
  if (since) q.where('received_at', '>=', asDate(since))
  const [row] = await q.select(
    db.raw(`count(*)::int                                                  AS events`),
    db.raw(`count(*) FILTER (WHERE networks->>'skipped' IS NOT NULL)::int   AS consent_skipped`),
  )
  return row
}

// One row per (network, verdict): { network: 'meta', verdict: 'rejected', calls: 2 }.
//
// The per-network verdicts live INSIDE the `networks` jsonb
// ({ meta: 'accepted', google: 'rejected' }) — there is no column to group by —
// so counting them means expanding that object into rows. The consent pseudo-key
// is excluded here because stats() above already owns it.
export async function networkStats({ since } = {}) {
  const q = db(TABLE)
    .joinRaw(`CROSS JOIN LATERAL jsonb_each_text(networks) AS net(network, verdict)`)
    .whereRaw(`net.network <> 'skipped'`)
    .select('net.network', 'net.verdict')
    .count('* as calls')
    .groupBy('net.network', 'net.verdict')
  if (since) q.where('received_at', '>=', asDate(since))
  const rows = await q
  return rows.map(r => ({ network: r.network, verdict: r.verdict, calls: Number(r.calls) }))
}

// The verdicts an adapter can return (reporter.js), in reading order. Anything
// else a future adapter invents still shows up — see describeNetworks().
const VERDICTS = ['accepted', 'rejected', 'error', 'skipped']

// The one-liner under the row. WHICH network is refusing events is the actionable
// half of `rejected` — "2 rejected" doesn't tell an operator whose access token to
// go and look at. Networks with failures are named first, for the same reason the
// metrics put them early.
function describeNetworks(rows) {
  if (!rows?.length) return null
  const byNetwork = new Map()
  for (const r of rows) {
    const tally = byNetwork.get(r.network) || {}
    tally[r.verdict] = (tally[r.verdict] || 0) + r.calls
    byNetwork.set(r.network, tally)
  }
  const failures = t => (t.rejected || 0) + (t.error || 0)
  return [...byNetwork.entries()]
    .sort(([an, at], [bn, bt]) => failures(bt) - failures(at) || an.localeCompare(bn))
    .map(([network, tally]) => {
      const order = [...VERDICTS, ...Object.keys(tally).filter(v => !VERDICTS.includes(v))]
      return `${network} ${order.filter(v => tally[v]).map(v => `${tally[v]} ${v}`).join(', ')}`
    })
    .join(' · ')
}

// Self-describing health, for any monitoring surface (see docs/10-plugin-status.md).
//
// `rejected` is the number that justifies this card. A conversion is recorded
// first-party and answered 200 to the browser whatever the networks say, so a CAPI
// call Meta refuses is a silent failure: the event counted as a success everywhere
// else, and the ad platform simply never learns about the sale. `errors` is the
// same failure one step earlier — the adapter never got an answer at all.
//
// Neither query may take the board down. They're caught independently, so a
// broken lateral still leaves the event totals on screen and the note says which
// half is missing, rather than the whole plugin vanishing from the surface.
export async function status({ since } = {}) {
  const totals = await stats({ since }).catch(err => {
    logger?.warn?.({ err }, 'conversions: status event totals unavailable')
    return null
  })
  const perNetwork = await networkStats({ since }).catch(err => {
    logger?.warn?.({ err }, 'conversions: status per-network breakdown unavailable')
    return null
  })

  const by = {}
  for (const r of perNetwork || []) by[r.verdict] = (by[r.verdict] || 0) + r.calls

  const missing = [!totals && 'event totals', !perNetwork && 'per-network verdicts'].filter(Boolean)

  return {
    label: 'conversions',
    metrics: [
      { key: 'events', value: totals?.events ?? 0 },
      { key: 'accepted', value: by.accepted || 0 },
      // Non-zero means conversions the rest of the system believes were reported
      // were not, in fact, reported.
      { key: 'rejected', value: by.rejected || 0, severity: 'bad' },
      { key: 'errors', value: by.error || 0, severity: 'bad' },
      // Not failures: a network that isn't configured or eligible, and consent
      // withheld, are both the system doing exactly what it was told.
      { key: 'skipped', value: by.skipped || 0 },
      { key: 'consent withheld', value: totals?.consent_skipped ?? 0 },
    ],
    note: missing.length
      ? `${missing.join(' and ')} unavailable — the numbers above are incomplete`
      : describeNetworks(perNetwork),
  }
}
