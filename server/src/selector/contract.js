// THE API CONTRACT — a number a caller can pin, distinct from the package version.
//
// Five breaking changes shipped in about a day, every one of them correct: the result moved
// from the root into `data`, bookings moved from facts to event attrs, the window anchor
// default changed from `last` to `min`, JSON parsing became strict, and operators were
// added. Nothing built on this API could pin behaviour across any of them, because there
// was no version anywhere — not in the request, not in the response, not in the grammar.
//
// The package version is the wrong thing to pin: it moves for a bug fix in an unrelated
// plugin. This moves only when a caller's working query would answer differently, or stop
// working. So it is answerable — "was I built against 1 or 2" is a question a client can
// hold, "was I built against 2.28.3" is not.
//
// HONEST ABOUT WHAT IS SUPPORTED. Pinning cannot conjure back behaviour nobody kept: the
// booking_* facts are deleted, so no version can serve a query against them. What a
// contract CAN do is (a) tell a caller which state answered them, (b) serve the one older
// shape that is cheap to keep, and (c) refuse loudly rather than silently answering a
// different question than the one the caller was written for.
export const CONTRACT = 2

// What each contract means, and what a caller written against it gets. Ordered oldest
// first; the notes are the changelog entries a client would need to read.
export const CONTRACTS = {
  1: {
    status: 'supported',
    response: 'the result at the ROOT — no { data, applied, warnings } envelope',
    since: 'the beginning',
    until: 'analytics 0.16.0',
    note: 'Kept because it is the only breaking change that stops a client PARSING a ' +
          'response rather than merely changing a number. Everything else in contract 1 ' +
          'behaves as contract 2 — the differences are in the data, and old data is gone.',
  },
  2: {
    status: 'current',
    response: '{ data, applied, warnings } — always, empty when there is nothing to report',
    since: 'analytics 0.16.0',
    changes: [
      'the result moved from the root into `data` (analytics 0.16.0)',
      'unparseable JSON is refused instead of answered with the whole population (0.16.1)',
      'booking_* facts became booking EVENT attrs — attr:location, cost, paid, first (server 2.24.0)',
      'a declared window anchor is honoured, so first_booked_at reads `min` not `last` (2.24.0)',
      'attrs took the fact operator set; first_seen/last_seen aggregates added (2.30.0+)',
    ],
  },
}

// The pinned contract for one request, or an error naming what is on offer.
//
// An UNKNOWN version is refused rather than rounded to the nearest — a client pinning 3
// was built against something that does not exist here, and answering it with 2 is
// answering a question it did not ask.
export function resolveContract(requested) {
  if (requested == null) return CONTRACT
  const n = typeof requested === 'string' ? Number(requested) : requested
  if (!Number.isInteger(n) || !CONTRACTS[n]) {
    const e = new Error(
      `unknown api version ${JSON.stringify(requested)} — this deployment serves ` +
      `${Object.keys(CONTRACTS).join(' and ')} (current: ${CONTRACT}). ` +
      `See CHANGELOG.md, or call analytics_grammar for what the current one accepts.`)
    e.status = 400
    throw e
  }
  return n
}

// What every response carries, so a number can always be traced to the state that produced
// it. `contract` is the pinnable part; `server` is for a bug report.
export function versionInfo(serverVersion, contract = CONTRACT) {
  return {
    contract,
    current: CONTRACT,
    server: serverVersion || null,
    deprecated: contract !== CONTRACT ? CONTRACTS[contract]?.until ?? true : undefined,
    changelog: 'https://github.com/almero-digital-marketing/whitebox-pro/blob/main/CHANGELOG.md',
  }
}
