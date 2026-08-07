// A real, per-occurrence LOG of published events. Populated purely by
// observation: notify.js calls record(type, payload) the instant an event
// actually publishes, storing the full payload (and, when present, the passport
// it happened to) as its own row — not just bumping a per-type counter.
// Retention-pruned (see sweep()) rather than kept forever, since this reflects
// recent activity, not permanent history. recent() exposes the actual
// occurrences for anyone who needs to see what really happened, not just that it
// happened.
//
// The log is still not a catalog, and it cannot be: plugins can't enumerate every
// event they might ever publish, because some — conversions, crm — forward names
// supplied by the client or an external system. That observation was right, but
// the conclusion drawn from it was wrong. Observation was made the ONLY source of
// the type vocabulary, so anything offering event types to a human could offer
// only what had already happened, and the journeys trigger picker was unusable
// for a new install.
//
// list() therefore merges this log with the DECLARED catalog and publishes the
// open-ended prefixes separately. See list() for what each source answers.

import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'node:crypto'
import createAuth from '../auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TABLE = 'whitebox_event_registry'
const OPEN = (req, res, next) => next()

let db, logger, retentionDays, sweepIntervalMs, eventCatalog
let sweepQueue

export function init(deps) {
  db = deps.db
  logger = deps.logger
  // Optional: without it list() degrades to observation only, which is what this
  // was before. Held as DATA — the registry still has no opinion about what a
  // type means (see the note below aggregation); it only needs the vocabulary.
  eventCatalog = deps.eventCatalog ?? null
  const cfg = deps.config?.eventRegistry || {}
  retentionDays = cfg.retentionDays ?? 90
  sweepIntervalMs = cfg.sweepIntervalMs ?? 24 * 60 * 60_000
}

export async function migrate() {
  await db.migrate.latest({
    directory: path.join(__dirname, 'migrations'),
    tableName: 'whitebox_event_registry_migrations',
  })
}

function retentionCutoff() {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60_000)
}

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? null

// Fire-and-forget by design (see notify.js) — must never throw into a real
// notify() call just because the log write hiccuped.
//
// Stores the payload VERBATIM, deliberately. This is the durable record: core
// has no opinion about which of a producer's fields are sensitive, and the same
// payload is already going to webhook subscribers and every events.subscribe()
// consumer (journeys' triggers read the bus, not this table), so redacting only
// the stored copy would make the log disagree with the bus while protecting
// nothing.
//
// Deciding what a CLIENT may see is the transport's job, not the log's. This
// route is therefore the MACHINE seam and nothing else: gate it with a static
// secret (see config.eventRegistry.auth) and do not re-serve it to a browser.
//
// Said plainly because the previous version of this comment claimed a projection
// was in place — "see server-plugin-live, its /events/log projects rather than
// dumping" — and that route was never in live. A reader auditing the log's safety
// found a sentence saying it was handled. The scrubber it referred to has been
// removed along with the browser route that used it; the surface a browser gets is
// server-plugin-live's feed, whose rows carry a distilled one-line `detail` and no
// payload at all.
export async function record(type, payload) {
  await db(TABLE).insert({
    id: randomUUID(), type, data: JSON.stringify(payload ?? null),
    passport_id: payload?.data?.passport_id ?? null, occurred_at: new Date(),
  })
}

// The vocabulary anything offering event types to a human needs: DECLARED and
// OBSERVED, together, plus the families that can never be enumerated.
//
// This used to be observation alone, and that made the journeys trigger picker
// unusable for exactly the events people most want to automate on. Its empty
// state read "trigger one anywhere in the app and it'll show up here to pick
// from" — so you could not build "when a booking arrives, do X" until a booking
// had already arrived. Same flaw the Live channel filter had: a list derived from
// what happened lately means the control is useless precisely when it's new.
//
// So three sources, and each answers something the others can't:
//
//   declared   every exact type a loaded plugin says it emits — offerable on a
//              fresh install, before anything has happened.
//   observed   what has actually occurred, with counts. The only source for a
//              type from an OPEN vocabulary (crm.booking, conversion.signup),
//              and the only thing that can say "this is really being used".
//   families   the prefixes — `crm.`, `conversion.` — whose members are the host
//              system's vocabulary, not ours. Nothing can list them in advance;
//              publishing the prefix lets a caller offer free-text entry under it
//              instead of a dead end. This is the answer to "what about the
//              events that aren't predefined".
//
// A row's `count` distinguishes them without the caller needing to care: 0 means
// declared but never seen.
export async function list() {
  const rows = await db(TABLE).where('occurred_at', '>=', retentionCutoff())
    .groupBy('type').select('type')
    .min('occurred_at as first_seen_at').max('occurred_at as last_seen_at').count('* as count')
    .orderBy('type')

  const observed = rows.map(r => ({ ...r, count: Number(r.count) }))
  const seen = new Set(observed.map(r => r.type))
  const declaredTypes = eventCatalog?.types ?? []

  const unseen = declaredTypes
    .filter(t => !seen.has(t))
    .map(type => ({ type, count: 0, first_seen_at: null, last_seen_at: null }))

  // `module` and `direction` come free from the catalog and save every caller
  // re-deriving them from the type string — grouping by the dot-prefix is what
  // the picker was doing, and that is not the same as the owning module
  // (`journey.*` is owned by `journeys`).
  const declared = new Set(declaredTypes)
  const annotate = (e) => {
    const spec = eventCatalog ? lookupSpec(e.type) : null
    return {
      ...e,
      declared: declared.has(e.type),
      module: spec?.module ?? null,
      direction: typeof spec?.direction === 'string' ? spec.direction : null,
    }
  }

  return {
    events: [...observed, ...unseen].map(annotate).sort((a, b) => a.type.localeCompare(b.type)),
    families: eventCatalog?.families ?? [],
  }
}

// The catalog's own matching rule, without importing its lookup() — the registry
// takes the catalog as data and has no opinion about what a type MEANS (see the
// note below aggregation).
function lookupSpec(type) {
  if (eventCatalog.byType?.has(type)) return eventCatalog.byType.get(type)
  for (const p of eventCatalog.prefixes ?? []) {
    if (type === p || type.startsWith(p)) return eventCatalog.byPrefix.get(p)
  }
  return null
}

// ── aggregation, for monitoring reads ───────────────────────────────────────
//
// Still no opinion about what a type MEANS. Whether `mail.sent` counts as
// outbound traffic is a product judgement that belongs to whoever is asking
// (see server-plugin-live's classify.js), not to the log that merely recorded
// it. Core counts; the caller interprets.
//
// What both DO carry is the direction/channel the producer already recorded in
// the payload. That's not interpretation — it's stored data, and it's the only
// place some of it exists: `awareness.recorded` is one type covering both
// inbound and outbound touches, distinguished solely by its own
// `direction` field. Aggregating by type alone therefore collapses the single
// highest-volume type in WhiteBox into one undifferentiated bucket, which is
// what made live's "coming in / going out" cards read empty while the feed
// beside them showed inbound traffic. Grouping by the recorded facet fixes
// that without core deciding what any of it means — the caller still maps
// `observation` → `in` itself.
//
// Rows are keyed by (type, recorded_direction, recorded_channel); both facets
// are null for the many types that record neither. Additive: existing readers
// of `.type`/`.count` are unaffected.
const RECORDED_DIRECTION = `data -> 'data' ->> 'direction'`
const RECORDED_CHANNEL = `data -> 'data' ->> 'channel'`

// How many of each type since `since` — the breakdown behind every card.
export async function countsByType({ since, passportId } = {}) {
  const q = db(TABLE)
    .select('type')
    .select(db.raw(`${RECORDED_DIRECTION} AS recorded_direction`))
    .select(db.raw(`${RECORDED_CHANNEL} AS recorded_channel`))
    .count('* as n')
    .groupByRaw(`type, ${RECORDED_DIRECTION}, ${RECORDED_CHANNEL}`)
    .orderBy('n', 'desc')
  if (since) q.where('occurred_at', '>=', since instanceof Date ? since : new Date(since))
  // Scope every aggregate to one person, so the cards and the feed can agree
  // while you are looking at a single passport (see server-plugin-live's
  // makeFilter). An indexed column, and always paired with the window.
  if (passportId) q.where({ passport_id: passportId })
  return (await q).map(r => ({
    type: r.type,
    count: Number(r.n),
    recorded_direction: r.recorded_direction ?? null,
    recorded_channel: r.recorded_channel ?? null,
  }))
}

// A time series, one row per (bucket, type). `bucketSeconds` is interpolated
// rather than bound because date_trunc/to_timestamp arithmetic can't take a
// parameter there — so it's coerced to an integer first and never reaches SQL
// as caller-supplied text.
export async function series({ since, bucketSeconds = 60, passportId } = {}) {
  const secs = Math.max(1, Math.floor(Number(bucketSeconds) || 60))
  const bucket = `to_timestamp(floor(extract(epoch from occurred_at) / ${secs}) * ${secs})`
  const q = db(TABLE)
    .select(db.raw(`${bucket} AS bucket`))
    .select('type')
    // Same recorded facets as countsByType, for the same reason — otherwise the
    // sparkline splits by direction exactly as badly as the cards did.
    .select(db.raw(`${RECORDED_DIRECTION} AS recorded_direction`))
    .select(db.raw(`${RECORDED_CHANNEL} AS recorded_channel`))
    .count('* as n')
    .groupByRaw(`${bucket}, type, ${RECORDED_DIRECTION}, ${RECORDED_CHANNEL}`)
    .orderBy('bucket', 'asc')
  if (since) q.where('occurred_at', '>=', since instanceof Date ? since : new Date(since))
  if (passportId) q.where({ passport_id: passportId })
  return (await q).map(r => ({
    bucket: r.bucket,
    type: r.type,
    count: Number(r.n),
    recorded_direction: r.recorded_direction ?? null,
    recorded_channel: r.recorded_channel ?? null,
  }))
}

// Counts of one PAYLOAD FIELD for one event type — "which utm_source did this
// window's sessions come from". Still no interpretation: the caller names the
// type and the field, core just groups the values it already stored.
//
// `field` is bound, never interpolated: it reaches this from a query string in
// practice, and `data -> 'data' ->> ${field}` would be an injection point. The
// allow-list is belt-and-braces on top of the binding.
export async function countsByPayloadField({ since, type, field, limit = 20 } = {}) {
  if (!/^[a-z][a-z0-9_]{0,63}$/i.test(String(field ?? ''))) {
    throw new Error(`event-registry: invalid payload field "${field}"`)
  }
  const q = db(TABLE)
    .select(db.raw(`data -> 'data' ->> ? AS value`, [field]))
    .count('* as n')
    .whereNotNull(db.raw(`data -> 'data' ->> ?`, [field]))
    // GROUP BY 1 — the select's first output column — NOT a second copy of the
    // expression. Each `?` is its own placeholder ($1 in the select, $3 in a
    // group-by), and Postgres won't assume two parameters hold the same value,
    // so `group by data -> 'data' ->> $3` does not cover `... ->> $1`: it fails
    // with "column data must appear in the GROUP BY clause". Grouping by
    // position sidesteps the comparison entirely and keeps `field` bound rather
    // than interpolated.
    .groupByRaw('1')
    .orderBy('n', 'desc')
    .limit(Math.min(100, Math.max(1, Math.floor(Number(limit) || 20))))
  if (type) q.where({ type })
  if (since) q.where('occurred_at', '>=', since instanceof Date ? since : new Date(since))
  return (await q).map(r => ({ value: r.value, count: Number(r.n) }))
}

// Distinct people touched in the window — "N active right now". Counts only
// rows that carry a passport; plenty of events are about the system, not a
// person, and folding those in would inflate it.
export async function activePassports({ since, passportId } = {}) {
  const q = db(TABLE).whereNotNull('passport_id').countDistinct('passport_id as n')
  if (since) q.where('occurred_at', '>=', since instanceof Date ? since : new Date(since))
  // Trivially 1 when scoped to one passport, but computed rather than assumed:
  // the answer is 0 if that passport did nothing in the window, and a header
  // reading "1 active" for someone who was idle would be a small lie.
  if (passportId) q.where({ passport_id: passportId })
  const [row] = await q
  return Number(row.n)
}

// When did anything last happen — regardless of window. This is what lets a
// caller distinguish "quiet" from "broken", which is the whole difference
// between a useful monitoring view and a wall of zeros.
export async function lastEventAt() {
  const [row] = await db(TABLE).max('occurred_at as at')
  return row?.at ?? null
}

// The actual occurrences — optionally scoped to one event type — most recent
// first. This is the point of being a log rather than just a registry: you
// can see what really happened, not just that something did.
export async function recent({ type, types, prefixes, limit = 50, passportId } = {}) {
  let q = db(TABLE).where('occurred_at', '>=', retentionCutoff()).orderBy('occurred_at', 'desc').limit(limit)
  if (type) q = q.andWhere({ type })
  // A SET of types, for a caller narrowing to a category rather than one name —
  // live's problems-only feed asks for every type its catalog marks error or
  // warn. Same reasoning as passportId below, and the same reason it is not done
  // after the fact: a rare type filtered out of the most recent fifty rows
  // returns nothing while the counters say otherwise.
  //
  // Prefixes come as a separate list because a declaration ending in a dot
  // covers names chosen at runtime, which no IN () can enumerate.
  if (types?.length || prefixes?.length) {
    q = q.andWhere(b => {
      if (types?.length) b.whereIn('type', types)
      for (const p of prefixes || []) b.orWhere('type', 'like', `${p}%`)
    })
  }
  // Scoped at the QUERY, not by filtering the page afterwards: a passport with
  // three events in a busy window would otherwise return three rows out of the
  // most recent fifty and look like it had gone quiet.
  if (passportId) q = q.andWhere({ passport_id: passportId })
  const rows = await q
  return rows.map(r => ({ ...r, data: p(r.data) }))
}

// Deletes rows past the retention window — belt-and-suspenders alongside
// list()'s/recent()'s own cutoff filter, so the table doesn't grow forever
// even if the sweep job falls behind.
export async function sweep() {
  return db(TABLE).where('occurred_at', '<', retentionCutoff()).del()
}

// Registers the repeatable sweep job. Idempotent across restarts — BullMQ
// dedupes repeatable jobs that share the same jobId + repeat options (same
// convention as journeys' triggers.js:startSweep()).
export function initQueue(queueModule) {
  sweepQueue = queueModule.createQueue('event-registry')
  queueModule.createWorker('event-registry', () =>
    sweep().catch(err => logger?.error?.({ err }, 'event-registry: sweep failed')))
}

export async function startSweep() {
  await sweepQueue.add('sweep', {}, { repeat: { every: sweepIntervalMs }, jobId: 'event-registry-sweep' })
}

// Core-mounted REST surface — no plugin owns this (it's core infra, like
// QUERY) — same auth seam as query/index.js: config.eventRegistry.auth.secret
// gates it, omitting it mounts open with a loud dev-only warning.
export function register(app, { config = {}, logger: parentLogger }) {
  const log = (parentLogger || logger).child?.({ component: 'event-registry' }) || parentLogger || logger
  const secret = config.eventRegistry?.auth?.secret
  if (!secret) log?.warn?.('Event registry mounted WITHOUT auth — set config.eventRegistry.auth.secret (dev only)')
  const requireAuth = secret ? createAuth({ secret, logger: log }) : OPEN

  app.get(config.eventRegistry?.path ?? '/events/registry', requireAuth, async (req, res) => {
    try {
      res.json(await list())
    } catch (err) {
      log?.error?.({ err }, 'event-registry: list failed')
      res.status(500).json({ error: 'event registry list failed' })
    }
  })

  // The actual log — recent occurrences (optionally scoped to one type),
  // full payload included. Same auth seam as the aggregate route above.
  app.get(config.eventRegistry?.logPath ?? '/events/log', requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined
      res.json(await recent({ type: req.query.type, limit }))
    } catch (err) {
      log?.error?.({ err }, 'event-registry: recent failed')
      res.status(500).json({ error: 'event log fetch failed' })
    }
  })
}
