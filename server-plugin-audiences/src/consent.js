// Consent guard. Nothing is forwarded to an ad network unless the passport is
// (a) not suppressed and (b) has the required consent category. See docs/08-consent-privacy.md.

import * as store from './store.js'

let passports, config

export function init(deps) {
  passports = deps.passports
  config = deps.config || {}
}

// Batched gate for a whole cohort — one query for the set (not N sequential
// round-trips). The consent check only runs on the survivors, and only when a
// category is required (skipped otherwise), so the common case is a single DB
// call. Returns { deliverable: pid[], suppressed, no_consent }.
export async function allowedCohort(ids) {
  const suppressedSet = await store.suppressedAmong(ids)
  const category = config.requireConsentCategory
  const deliverable = []
  let suppressed = 0, no_consent = 0
  for (const pid of ids) {
    if (suppressedSet.has(pid)) { suppressed++; continue }
    if (category && !(await hasConsent(pid, category))) { no_consent++; continue }
    deliverable.push(pid)
  }
  return { deliverable, suppressed, no_consent }
}

// Marketing consent per passport. Wire this to however you store consent —
// e.g. a passport flag written at /sessions/resolve from the client consent
// module, or a context provider. Default-deny when a category is required.
async function hasConsent(passportId, category) {
  if (typeof passports.hasConsent === 'function') {
    return passports.hasConsent(passportId, category)
  }
  return false   // safe default: no consent source wired ⇒ do not forward
}
