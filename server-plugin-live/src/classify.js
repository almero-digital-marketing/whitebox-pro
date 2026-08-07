// Classification, as a CONSUMER.
//
// This file used to BE the classification: a map of sixteen other modules' event
// namespaces, maintained here, describing plugins this one has no business
// knowing about. It is now a thin read over the catalog those modules declare
// for themselves (server/src/event-catalog.js) — live contributes nothing to it.
//
// That change is not cosmetic. The old map was wrong in five ways at once and
// none of them were visible from inside this file:
//   · voip.click missing        → click-to-call classified `unknown`
//   · 'conversions.' (plural)   → matched nothing; every conversion `unknown`
//   · mail.clicked declared     → never emitted (the status is 'engaged')
//   · adnetwork.skipped declared→ never emitted (skips return before notify)
//   · webhook. queue. engagement. audiences. declared → emitted by NOBODY, and
//     three of them showed up as channel filter options that could never match
// Every one of those is a statement about somebody else's plugin that only that
// plugin could have got right.
//
// The `unknown` bucket stays, and stays un-defaulted: an event nobody declares
// is visibly unclassified rather than quietly folded into `internal`. That is
// what surfaced voip.click in the first place.

import { direction as catalogDirection, channel as catalogChannel, severity as catalogSeverity, severityTypes as catalogSeverityTypes } from 'whitebox-pro-server/event-catalog'

// Handed over by live's register() from ctx.eventCatalog. Module-level, matching
// how the rest of this plugin takes its dependencies (see service.js init).
let catalog = null

export function init(deps = {}) {
  catalog = deps.eventCatalog ?? null
}

/**
 * Which way was this flowing?
 * @param {string} type     the event type, e.g. 'mail.sent'
 * @param {object} payload  the notify() payload — read only when a declaration
 *                          says the direction lives in it (awareness)
 * @returns {'in'|'out'|'internal'|'unknown'}
 */
export function direction(type, payload) {
  return catalogDirection(catalog, type, payload)
}

/** The channel a row belongs to (web / mail / sms / voip / crm / …). */
export function channel(type, payload) {
  return catalogChannel(catalog, type, payload)
}

/**
 * Bad news, per the module that emits it: 'error' | 'warn' | null.
 *
 * Read here for the same reason direction is — this plugin holds no opinion
 * about which of mail's eleven event types is a failure, and any list it kept
 * would be a copy of somebody else's, stale from the day a plugin was added.
 */
export function severity(type, payload) {
  return catalogSeverity(catalog, type, payload)
}

/**
 * Which types carry a severity at all, for narrowing the query rather than the
 * page. `{ types, prefixes }` — see the catalog accessor for why the feed cannot
 * do this client-side.
 */
export function severityTypes() {
  return catalogSeverityTypes(catalog)
}

export const DIRECTIONS = ['in', 'out', 'internal', 'unknown']

/**
 * Every channel the system HAS, for the filter list — union of what every module
 * declared, not a query over recent traffic.
 *
 * A function rather than the constant this used to be, because the answer now
 * depends on which plugins are loaded. Same reasoning as status() discovery: a
 * new channel appears here without this file changing.
 *
 * Empty until init() runs, which is deliberate — an empty filter list is a
 * visible "nothing declared yet", where a hard-coded fallback would look correct
 * while being detached from what's actually installed.
 */
export function channels() {
  return catalog?.channels ?? []
}
