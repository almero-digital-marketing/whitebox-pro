// CRM ingest. Two independent pipelines, one shared identity gate.
//
//   ingestRecords({ source, customer, records[] })
//     → writes each record's structured state into core facts (via state.js)
//     → returns { passport_id, passport_created, records: { accepted, dropped } }
//
//   ingestFacts({ source, customer, facts[] })
//     → feeds each free-text note to awareness as channel='crm', direction='observation'
//       with stable content_id = ${source}:fact:${kind}:${id}
//     → returns { passport_id, passport_created, facts:   { accepted, dropped } }
//
//   resolvePassport({ source, ...customer })
//     Shared identity gate. Returns { passportId, created } or null when
//     the customer block has no usable identity (no email / parseable
//     phone / external_id). Both ingest functions drop with reason
//     'no_identity' in that case.
//
// Identity resolution:
//   1. If any identity already belongs to a passport → reuse it; backfill
//      any missing identities onto it via passports.link().
//   2. No match but at least one identity provided → mint a new passport
//      and link every identity the CRM gave us.
//   3. No usable identity at all → drop the entire request.

import { parsePhoneNumber } from 'libphonenumber-js'

import * as state from './state.js'

function normalizePhone(raw, defaultCountry = 'US') {
  try {
    const pn = parsePhoneNumber(String(raw).trim(), defaultCountry)
    return pn?.isPossible?.() ? pn.format('E.164') : null
  } catch { return null }
}

function buildClaims({ source, email, phone, country, external_id }) {
  const claims = []
  if (email) claims.push({ type: 'email', name: 'address', value: String(email).toLowerCase() })
  const phoneE164 = phone ? normalizePhone(phone, country) : null
  if (phoneE164) claims.push({ type: 'phone', name: 'e164', value: phoneE164 })
  if (external_id && source) {
    claims.push({ type: 'user', name: source, value: `${source}:${external_id}` })
  }
  return claims
}

// Dependencies captured once via init() — module-level singletons. `state` (the
// facts adapter) is imported directly above and inits itself in index.js; only
// non-module values (passports, awareness, logger) come through init.
let passports, awareness, logger, db

export function init(deps) {
  passports = deps.passports
  awareness = deps.awareness
  logger = deps.logger
  db = deps.db          // core's knex — only for reading our own rows back (status())
}

export async function resolvePassport(customer = {}) {
  const claims = buildClaims(customer)
  if (!claims.length) return null

  for (const c of claims) {
    const existing = await passports.findByIdentity(c.type, c.value)
    if (existing) {
      await passports.link(existing.id, claims).catch(err =>
        logger.warn({ err }, 'CRM: failed to backfill identities on existing passport'))
      return { passportId: existing.id, created: false }
    }
  }

  const passportId = await passports.identify(null)
  await passports.link(passportId, claims).catch(err =>
    logger.warn({ err, passportId }, 'CRM: failed to link identities on new passport'))
  return { passportId, created: true }
}

export async function ingestRecords({ source, customer, records: incoming = [] }) {
  if (!source) throw new Error('source is required')
  if (!Array.isArray(incoming) || !incoming.length) {
    return { reason: 'empty_payload', records: { accepted: 0, dropped: 0 } }
  }

  const resolved = await resolvePassport({ source, ...customer })
  if (!resolved) {
    logger.info({ source }, 'CRM records dropped — no identity information')
    return { reason: 'no_identity', records: { accepted: 0, dropped: incoming.length } }
  }
  const { passportId, created } = resolved

  let accepted = 0
  for (const r of incoming) {
    try {
      await state.record({
        source,
        kind: r.kind,
        external_id: String(r.external_id),
        passport_id: passportId,
        status: r.status ?? null,
        starts_at: r.starts_at ? new Date(r.starts_at) : null,
        data: r.data ?? {},
      })
      accepted++
    } catch (err) {
      logger.error({ err, record: { kind: r.kind, external_id: r.external_id } },
        'Failed to record CRM state')
    }
  }

  logger.info(
    { source, passportId, passportCreated: created, accepted, dropped: incoming.length - accepted },
    'CRM records ingested: %d from %s', accepted, source,
  )
  return {
    passport_id: passportId,
    passport_created: created,
    records: { accepted, dropped: incoming.length - accepted },
  }
}

export async function ingestFacts({ source, customer, facts: incoming = [] }) {
  if (!source) throw new Error('source is required')
  if (!Array.isArray(incoming) || !incoming.length) {
    return { reason: 'empty_payload', facts: { accepted: 0, dropped: 0 } }
  }

  const resolved = await resolvePassport({ source, ...customer })
  if (!resolved) {
    logger.info({ source }, 'CRM facts dropped — no identity information')
    return { reason: 'no_identity', facts: { accepted: 0, dropped: incoming.length } }
  }
  const { passportId, created } = resolved

  let accepted = 0
  for (const f of incoming) {
    if (!f?.body) continue
    const meta = { kind: f.kind }
    if (f.ref) {
      // The ref carries the external identity (kind + id). Structured state is now
      // facts keyed by `entity = kind:external_id`, so a note and the state it
      // refers to join on that entity — no separate record_id lookup needed.
      meta.ref = { kind: f.ref.kind, external_id: String(f.ref.external_id), entity: `${f.ref.kind}:${f.ref.external_id}` }
    }
    try {
      await awareness.record({
        passport_id: passportId,
        session_id: null,
        ts: f.ts ? new Date(f.ts) : new Date(),
        channel: 'crm',
        direction: 'observation',
        source,
        content_id: `${source}:fact:${f.kind}:${f.id}`,
        text: f.body,
        meta,
      })
      accepted++
    } catch (err) {
      logger.warn({ err, fact: { id: f.id, kind: f.kind } },
        'awareness.record failed for CRM fact')
    }
  }

  logger.info(
    { source, passportId, passportCreated: created, accepted, dropped: incoming.length - accepted },
    'CRM facts ingested: %d from %s', accepted, source,
  )
  return {
    passport_id: passportId,
    passport_created: created,
    facts: { accepted, dropped: incoming.length - accepted },
  }
}

// Client-reported observations (browser SDK via whitebox-pro-client-plugin-crm).
// The passport is ALREADY known — from the authenticated socket connection or
// an explicit passport_id — so there's no customer/identity block to resolve.
// These are LOW-TRUST: things the client app witnessed in the UI, not
// authoritative state. Recorded as awareness observations tagged source='client'
// so downstream (ask, audiences) can weigh them as self-reported. Authoritative
// state must still come through ingestRecords (the bearer-authed webhook).
export async function ingestObservations({ passport_id, source = 'client', observations = [] }) {
  if (!passport_id) {
    return { reason: 'no_identity', observations: { accepted: 0, dropped: observations.length } }
  }
  if (!Array.isArray(observations) || !observations.length) {
    return { passport_id, observations: { accepted: 0, dropped: 0 } }
  }

  let accepted = 0
  for (const o of observations) {
    if (!o?.body) continue
    try {
      await awareness.record({
        passport_id,
        session_id: null,
        ts: o.ts ? new Date(o.ts) : new Date(),
        channel: 'crm',
        direction: 'observation',
        source,
        content_id: `${source}:obs:${o.kind}:${o.id}`,
        text: o.body,
        meta: { kind: o.kind, client: true, ...(o.meta || {}) },
      })
      accepted++
    } catch (err) {
      logger.warn({ err, obs: { id: o.id, kind: o.kind } },
        'awareness.record failed for client observation')
    }
  }

  return { passport_id, observations: { accepted, dropped: observations.length - accepted } }
}

const EXPOSURES = 'whitebox_awareness_exposures'

// The notes side of the ingest, inside the window. Attribution here IS exact,
// unlike the facts side (see state.stats): the plugin loader stamps `plugin` on
// every awareness row a plugin records (server/src/plugins.js), so a row marked
// 'crm' is unambiguously one of ours.
//
// Client observations are split out rather than folded in: they're low-trust
// things the browser SDK witnessed, and counting them with the authoritative
// webhook notes would make a CRM that has stopped pushing look busy. The split
// keys on `meta->>'client'` — set by ingestObservations() above — rather than on
// `source`, which is a caller-supplied label on that path.
//
// Windowed on `created_at`, not `ts`: a note carries the sender's own timestamp
// (f.ts), so backfilling a year of history is recent INGEST with old event times.
export async function noteStats({ since } = {}) {
  const q = db(EXPOSURES).where({ plugin: 'crm' })
  if (since) q.where('created_at', '>=', since instanceof Date ? since : new Date(since))
  const [row] = await q.select(
    db.raw(`count(*) FILTER (WHERE meta->>'client' IS NULL)::int      AS notes`),
    db.raw(`count(*) FILTER (WHERE meta->>'client' IS NOT NULL)::int  AS observations`),
  )
  return row
}

// Self-describing health (see docs/10-plugin-status.md). CRM owns no table — its
// records land in core facts and its notes in awareness (migration 002 retired the
// records table) — so this reads both of those back, and it is the only status()
// in the suite that also has to say what it CANNOT see.
//
// Nothing here is marked `severity: 'bad'`, and that is not an oversight: every
// number CRM can count is a success. Its failures are a payload dropped with
// `202 no_identity` (well-formed, no usable email/phone/external_id — a sender bug
// that silently loses data) and a per-record facts write that threw. Both exist
// only in the HTTP response the sender has already discarded and in the log; no
// counter survives them. A zero would therefore read as "nothing was dropped"
// when the truth is "nobody is counting", so the note says that instead of
// inventing the number.
//
// Each query is caught on its own — a broken half degrades to a partial answer
// rather than dropping the plugin off the board.
export async function status({ since } = {}) {
  const structured = await state.stats({ since }).catch(err => {
    logger?.warn?.({ err }, 'CRM: status record counts unavailable')
    return null
  })
  const notes = await noteStats({ since }).catch(err => {
    logger?.warn?.({ err }, 'CRM: status note counts unavailable')
    return null
  })

  const missing = [!structured && 'record counts', !notes && 'note counts'].filter(Boolean)
  const note = [
    missing.length ? `${missing.join(' and ')} unavailable — the numbers above are incomplete` : null,
    'payloads dropped for no identity (202 no_identity) are counted nowhere — only the log has them',
  ].filter(Boolean).join('; ')

  return {
    label: 'crm',
    metrics: [
      { key: 'records', value: structured?.records ?? 0,
        description: 'Distinct CRM entities written through this window' },
      { key: 'state facts', value: structured?.facts ?? 0,
        description: 'Field values from those records, several each' },
      { key: 'notes', value: notes?.notes ?? 0,
        description: 'Notes from the CRM itself' },
      // Low-trust, client-reported — kept separate so they can't flatter the
      // authoritative counts above.
      { key: 'observations', value: notes?.observations ?? 0,
        description: 'Notes reported by a client SDK — lower trust' },
    ],
    note,
  }
}
