// A real, per-occurrence log of recently-published events — NOT a
// declared/curated catalog (plugins can't enumerate every event they might
// ever publish up front; some, like conversions/crm, forward client- or
// external-system-supplied names). Populated purely by observation: notify.js
// calls record(type, payload) the instant an event actually publishes, storing
// the full payload (and, when present, the passport it happened to) as its
// own row — not just bumping a per-type counter. Retention-pruned (see
// sweep()) rather than kept forever, since this reflects recent activity, not
// permanent history. list() derives the same {type, count, first/last_seen}
// shape the Journeys trigger picker already consumes, via a GROUP BY over the
// log; recent() exposes the actual occurrences for anyone who needs to see
// what really happened, not just that it happened.

import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'node:crypto'
import createAuth from '../auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TABLE = 'whitebox_event_registry'
const OPEN = (req, res, next) => next()

let db, logger, retentionDays, sweepIntervalMs
let sweepQueue

export function init(deps) {
  db = deps.db
  logger = deps.logger
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
export async function record(type, payload) {
  await db(TABLE).insert({
    id: randomUUID(), type, data: JSON.stringify(payload ?? null),
    passport_id: payload?.data?.passport_id ?? null, occurred_at: new Date(),
  })
}

// The aggregate view — same shape the Journeys trigger picker already
// consumes, now derived from the log rather than stored as its own row.
export async function list() {
  const rows = await db(TABLE).where('occurred_at', '>=', retentionCutoff())
    .groupBy('type').select('type')
    .min('occurred_at as first_seen_at').max('occurred_at as last_seen_at').count('* as count')
    .orderBy('type')
  return rows.map(r => ({ ...r, count: Number(r.count) }))
}

// The actual occurrences — optionally scoped to one event type — most recent
// first. This is the point of being a log rather than just a registry: you
// can see what really happened, not just that something did.
export async function recent({ type, limit = 50 } = {}) {
  let q = db(TABLE).where('occurred_at', '>=', retentionCutoff()).orderBy('occurred_at', 'desc').limit(limit)
  if (type) q = q.andWhere({ type })
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
