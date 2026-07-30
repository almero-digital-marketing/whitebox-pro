// Which way is the data flowing?
//
// The whole module rests on this one question, and the honest answer differs by
// event kind — so this is a small, explicit, testable map rather than a clever
// heuristic buried in a query.
//
//   in       — something arrived from the outside world. A visitor read a page,
//              a reply landed, a CRM pushed state, a conversion fired.
//   out      — WhiteBox reached out. A mail or SMS left, a webhook fired.
//   internal — orchestration that touched nobody outside: an enrollment, a
//              campaign activating, a step running.
//
// `internal` exists because collapsing it into in/out is the easy way to make a
// monitoring view lie. `journey.enrolled` is not traffic; counting it as either
// direction inflates a number an operator is using to judge whether the system
// is actually talking to anyone.

// Awareness is the exception, and deliberately so: it already carries its own
// direction, recorded at the point of the touch. Re-deriving it from the event
// type would be a second source of truth for something core already decided.
//
//   exposure     — we reached them            → out
//   expression   — they acted                 → in
//   conversion   — they converted             → in
//   observation  — state observed about them  → in
//   conversation — two-way (a call)           → in, see below
//
// A conversation is genuinely both. It counts as `in` because the operational
// question this view answers is "is anything coming back?", and a call is the
// strongest possible yes.
const AWARENESS_DIRECTION = {
  exposure: 'out',
  expression: 'in',
  conversion: 'in',
  observation: 'in',
  conversation: 'in',
}

// Matched longest-prefix-first, so `mail.bulk.queued` can differ from `mail.`
// without the order of this object mattering.
const BY_PREFIX = {
  // ── out: we reached someone ─────────────────────────────────────────────
  'mail.sent': 'out',
  'mail.queued': 'out',
  'mail.bulk.queued': 'out',
  'mail.failed': 'out',
  'sms.sent': 'out',
  'sms.queued': 'out',
  'sms.bulk.queued': 'out',
  'sms.failed': 'out',
  'webhook.sent': 'out',
  // The fate of a message WE sent, reported back by the provider rather than by
  // the person — still part of the outbound leg, not a reply.
  'mail.delivered': 'out',
  'mail.bounced': 'out',
  'sms.delivered': 'out',
  'sms.bounced': 'out',
  // Our own server-to-server calls to Meta/TikTok/GA4. Outbound even when they
  // fail — the call left the building, which is exactly what makes a rejection
  // worth seeing here rather than only in a log.
  'adnetwork.accepted': 'out',
  'adnetwork.rejected': 'out',
  'adnetwork.error': 'out',

  // ── in: something arrived ───────────────────────────────────────────────
  'mail.received': 'in',
  'sms.received': 'in',
  // Singular: the conversions plugin emits `conversion.${name}` (see its
  // ingest.js), so the old plural 'conversions.' matched no event that has ever
  // existed and every conversion counted as `unknown`.
  'conversion.': 'in',
  'crm.': 'in',
  'engagement.': 'in',
  'voip.call': 'in',
  'voip.ring': 'in',
  'shortener.': 'in',
  // A person arriving. Emitted by core on a genuine mint / new session only (not
  // per request), so this is new-visitors and new-sessions — the most basic
  // "is anything happening" signal there is, and inbound by any reading.
  'passport.created': 'in',
  'session.started': 'in',
  // Recipient actions on a message we sent. Filed as `in` by this file's own
  // stated test — "is anything coming back?" — which is also why a conversation
  // counts as `in` above. Note this deliberately differs from how AWARENESS
  // records an open (as `exposure`, i.e. content reaching them): that answers
  // "was this content seen", a different question from "did someone react".
  // If you'd rather the two agreed, move opened/engaged up to `out`.
  'mail.opened': 'in',
  'mail.clicked': 'in',
  'mail.engaged': 'in',
  'mail.complained': 'in',
  'mail.unsubscribed': 'in',

  // ── internal: orchestration ─────────────────────────────────────────────
  'journey.': 'internal',
  'journeys.': 'internal',
  'campaigns.': 'internal',
  'audiences.': 'internal',
  'mail.bulk.cancelled': 'internal',
  'sms.bulk.cancelled': 'internal',
  'voip.pick': 'internal',
  'awareness.forgotten': 'internal',
  'queue.': 'internal',
  // Deliberately NOT out: nothing was sent. A network we chose to skip (not
  // eligible, or no consent) counted as outbound traffic would make the CAPI
  // fan-out look healthy precisely when it isn't running.
  'adnetwork.skipped': 'internal',
}

const PREFIXES = Object.keys(BY_PREFIX).sort((a, b) => b.length - a.length)

/**
 * @param {string} type     the event type, e.g. 'mail.sent'
 * @param {object} payload  the notify() payload — read only for awareness
 * @returns {'in'|'out'|'internal'|'unknown'}
 */
export function direction(type, payload) {
  if (type === 'awareness.recorded') {
    // core's own recorded direction wins; an unrecognised one is not guessed
    return AWARENESS_DIRECTION[payload?.data?.direction] ?? 'unknown'
  }
  for (const p of PREFIXES) {
    if (type === p || type.startsWith(p)) return BY_PREFIX[p]
  }
  // Deliberately NOT defaulted to 'internal'. A plugin added tomorrow shows up
  // as `unknown` and is visibly missing from this map — which is a prompt to
  // classify it, rather than a number quietly drifting wrong.
  return 'unknown'
}

// The channel a row belongs to (web / mail / sms / voip / crm / …), for the
// per-channel breakdown. Awareness again carries its own; everything else takes
// the first segment of the type, which is how these names are constructed.
export function channel(type, payload) {
  if (type === 'awareness.recorded' && payload?.data?.channel) return payload.data.channel
  return String(type).split('.')[0]
}

export const DIRECTIONS = ['in', 'out', 'internal', 'unknown']
