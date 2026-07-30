// Self-describing health for any monitoring surface (see docs/10-plugin-status.md).
//
// This plugin owns NO tables — geo becomes core facts, and lookups are answered
// from the provider's own data source — so there is no history to query and
// nothing here is windowed. `since` is accepted (the surface passes it to every
// plugin) and deliberately ignored: the counts below are process-lifetime, reset
// only by a restart, and a file's age is live state by definition. Pretending
// either was windowed would be a lie about where the number came from.
//
// The number that actually matters is the database's age. A GeoIP database
// degrades SILENTLY: a stale .mmdb keeps answering every lookup with a
// plausible-looking city, it just answers with last year's IP allocations, and no
// error is ever raised. Nobody notices for months. So the age is reported as a
// number an operator can read, and the staleness judgement gets a metric of its
// own so it is machine-visible rather than only prose in a note.
//
// Module-level singleton reset by init(), matching the store/outbox pattern used
// across the repo.

// MaxMind ships GeoLite2 updates twice a week and geoipupdate is normally a daily
// cron, so a month without a new file means the update path has stopped — not
// that there was nothing to download.
const DEFAULT_STALE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

let provider
let logger
let staleAfterDays

// Every lookup the onResolve hook attempted since boot. `misses` and `errors` are
// both subsets of `lookups`, so hits = lookups - misses - errors.
let lookups = 0
let misses = 0
let errors = 0

export function init(deps) {
  provider = deps.provider
  logger = deps.logger
  staleAfterDays = deps.staleAfterDays ?? DEFAULT_STALE_DAYS
  lookups = 0
  misses = 0
  errors = 0
}

export function recordHit() { lookups++ }
export function recordMiss() { lookups++; misses++ }    // provider had no data for the IP
export function recordError() { lookups++; errors++ }   // provider threw — the lookup produced nothing

export async function status({ since } = {}) {   // `since` unused on purpose — see the header
  // Every metric here is `live`. This plugin owns no tables: the three counters are
  // process-lifetime totals held in memory (they reset on restart and don't extend
  // to a second instance), and the database facts below are read off the file right
  // now. None of it can be windowed because none of it is stored per-event, so the
  // board must not show it under a window selector as though it were.
  const metrics = [
    { key: 'lookups', value: lookups, live: true,
      description: 'Visitors we tried to locate' },
    // No data for an IP is normal, not broken: private, reserved and unroutable
    // addresses all land here, and so do addresses MaxMind simply can't place.
    { key: 'no data', value: misses, live: true,
      description: 'Visitors whose location could not be found' },
    // The provider threw: a missing, unreadable or corrupt database, or a reader
    // that never opened. Each one is a visitor who got no geo at all.
    { key: 'failed', value: errors, severity: 'bad', live: true,
      description: 'Lookups that broke — those visitors got no location' },
  ]

  // Optional by design: health() is not part of the provider contract (that is
  // name + lookup), so a provider that can't describe its data source still gets
  // the counts above — it just can't contribute the age.
  let db = null
  try {
    db = provider?.health?.() ?? null
  } catch (err) {
    logger?.warn?.({ err }, 'geolocation: provider health() failed')
  }

  let note = null
  if (!db) {
    note = `provider "${provider?.name || 'unknown'}" does not report database health — lookup counts only`
  } else if (!db.loaded) {
    // Providers open their database lazily on first lookup, so "not loaded" with
    // no lookups yet is the normal state of a freshly booted process, not a
    // fault. `failed` above is what says the load actually broke.
    note = lookups
      ? `${db.dbPath}: database never loaded — every lookup so far has failed`
      : `${db.dbPath}: database not read yet — no lookup attempted since boot`
  } else if (db.mtimeMs == null) {
    note = `${db.dbPath}: database is loaded but its mtime could not be read — age unknown`
  } else {
    const ageDays = Math.floor((Date.now() - db.mtimeMs) / DAY_MS)
    const stale = ageDays > staleAfterDays
    metrics.push({ key: 'database age (days)', value: ageDays, live: true,
      description: 'How old the location database is, in days' })
    // A judgement expressed as a count, which is exactly what the contract's
    // "non-zero means something is wrong" wants: the age itself is always
    // non-zero and always fine until it isn't, so it can't carry the severity.
    metrics.push({ key: 'stale database', value: stale ? 1 : 0, severity: 'bad', live: true,
      description: `1 if the location data is over ${staleAfterDays} days old` })
    if (stale) {
      note = `${db.dbPath} is ${ageDays} days old — geoipupdate has probably stopped; lookups still answer, from stale allocations`
      if (!db.watching) note += ' (and the file is not watched — pass watch: true)'
    } else if (!db.watching) {
      note = `${db.dbPath} is not watched — pass watch: true so a geoipupdate file swap is picked up without a restart`
    }
  }

  return { label: 'geolocation', metrics, note }
}
