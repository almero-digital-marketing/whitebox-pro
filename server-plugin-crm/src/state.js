// Structured-state adapter over core facts.
//
// CRM used to own a `whitebox_crm_records` table; it no longer does. A record's
// structured state now lands in the core *facts* memory (ctx.facts), so the
// selector queries it directly (`{ fact: { subscription: { eq: "active" } } }`)
// and it time-travels + transitions for free (facts are append-only). The term
// "crm" stays out of core — facts only knows keys, values, sources and entities.
//
// Mapping a record { source, kind, external_id, status, starts_at, data }:
//   · status        → fact  key=kind        value=status        (the primary signal)
//   · each scalar in `data` → fact key=<field> value=<scalar>   (individually queryable)
//   · starts_at     → the fact's observed_at (the event time → matched_at)
//   · source/external_id → the fact's source + entity (`kind:external_id`)
// A status change just appends a new fact; the current view is the latest, the
// history powers temporal queries. Non-scalar `data` fields are skipped (not
// value-queryable); a record with neither status nor scalar data records a bare
// presence fact (key=kind, value=true) so it still exists in the timeline.

let facts
let logger
let notify
let db      // core's knex — only for reading back what we wrote (see stats())

export function init(deps) {
  facts = deps.facts
  logger = deps.logger
  notify = deps.notify
  db = deps.db
}

const isScalar = v => v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')

// Write one external record as facts. Returns { written } (number of fact rows).
export async function record({ source, kind, external_id, passport_id, status, starts_at, data }) {
  const observed_at = starts_at ? new Date(starts_at) : new Date()
  // The writer's handle for this observation. `kind:` prefixes it so two record
  // kinds sharing an id from the same source stay distinct, and it is what makes
  // a re-send resolvable — see core facts migrations/003.
  const common = { passport_id, observed_at, source, external_id: `${kind}:${external_id}` }

  const writes = []
  if (status != null) writes.push({ key: kind, value: status })
  for (const [k, v] of Object.entries(data || {})) {
    if (isScalar(v)) writes.push({ key: k, value: v })
    else logger?.debug?.({ source, kind, field: k }, 'CRM: skipping non-scalar data field (not value-queryable)')
  }
  if (writes.length === 0) writes.push({ key: kind, value: true })   // bare presence

  // One INSERT for the whole record, not one per field.
  //
  // This was a loop over facts.record(), which is a round trip to Postgres per
  // field. A record with a status and half a dozen scalars is seven trips, and a
  // caller publishing a customer's history sends many records back to back — the
  // gpoint import measured 7.5 customers a minute that way, most of it latency.
  //
  // The batch is all-or-nothing where the loop was per-field tolerant. That is
  // the better failure for structured state: a record half-written is a customer
  // whose status landed and whose amount did not, which reads as real data and
  // is worse than a record that visibly failed and can be re-sent.
  //
  // `resolve: 'replace'` is what finally makes "re-sending is free" TRUE. This
  // endpoint has always described itself as an upsert by
  // (source, kind, external_id) — routes.js says so, ingest.js says so, and the
  // line that used to sit here said so. Nothing implemented it: every re-send
  // appended a second set of rows. gpoint's import ran four times in three days
  // and left 813,624 booking observations spread across 1,756,015 rows.
  //
  // 'replace' rather than 'skip' because that is what an upsert means — a record
  // re-sent with corrected data should correct what is stored. observed_at is
  // part of the identity (core facts migrations/003), so a record whose starts_at
  // moved still APPENDS: the status timeline survives, and only a re-send of the
  // same record at the same instant collapses.
  //
  // `written` is now rows WRITTEN, not rows sent — a re-send that replaces
  // reports what it touched, and the two numbers were never the same thing.
  let written = 0
  try {
    const rows = await facts.recordBatch(writes.map(w => ({ ...common, ...w })), { resolve: 'replace' })
    written = rows.length
  } catch (err) {
    logger?.error?.({ err, source, kind, external_id }, 'CRM: facts.recordBatch failed')
  }

  // The primary signal (see header comment) — a distinctly-named event per
  // record kind, so a Journey can trigger on e.g. `crm.subscription` and
  // branch on data.status, rather than everything folding into one generic
  // "a CRM record landed" event. Not fired for the bare-presence case (no
  // status, no scalar data) — that's not really a transition.
  if (status != null) {
    notify?.(`crm.${kind}`, { type: `crm.${kind}`, data: { passport_id, status, source, external_id, ...data } })
  }

  return { source, kind, external_id, passport_id, written }
}

// The passport's current structured state → { key: value }. (The facts memory is
// the source of truth; this is just the per-passport read CRM exposes.)
export async function current(passportId) {
  return facts.current(passportId)
}

// How much structured state landed through this adapter inside the window — the
// read side of record(), for the health card in ingest.js.
//
// Windowed on `recorded_at` (when we learned it), not `observed_at`: a record
// carries its own `starts_at`, so importing last year's subscriptions writes facts
// whose observed_at is a year old while the ingest happened a minute ago — and
// "is CRM ingest working" is a question about the latter.
//
// `records` counts DISTINCT entities, `facts` counts rows: one record fans out
// into one fact per status + scalar field (see record() above), so rows alone
// would make a two-field record look like twice the traffic. Restating the same
// entity twice in one window counts once — that's one thing we know about, said
// twice, which is exactly what the entity key means.
//
// ATTRIBUTION: core facts is deliberately channel-agnostic — it has a `source`
// (the external system: 'stripe', 'hubspot') but no `plugin` column, so unlike
// awareness nothing in the row says "crm wrote this". What is distinctive is
// `external_id`: this adapter always sets it (`kind:external_id`) and no other
// writer in the suite does — people, journeys and geolocation all leave it null.
// So identified rows are a proxy, not a guarantee, and it can only ever
// over-count (if some other source starts sending external ids). Hence the metric
// is named for what it counts rather than claimed as exact.
export async function stats({ since } = {}) {
  const q = db('whitebox_facts').whereNotNull('external_id')
  if (since) q.where('recorded_at', '>=', since instanceof Date ? since : new Date(since))
  const [row] = await q.select(
    db.raw(`count(*)::int                 AS facts`),
    db.raw(`count(DISTINCT external_id)::int AS records`),
  )
  return row
}
