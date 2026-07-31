// What an event was ABOUT, in one short line — as a CONSUMER.
//
// This file used to BE the descriptions: 200 lines reading the payload fields of
// twelve other modules. A feed of type names answers "something happened" and
// nothing more, so the detail column is what makes the feed usable — but live can
// only ever guess at the shape of somebody else's payload, and it guessed wrong
// in ways nobody could see from here:
//
//   · voip     read `caller` and `line`, and knew nothing of `number` — which is
//              what the number POOL calls the same field. Every click-to-call
//              showed a blank column while carrying both the number and the tag.
//   · journeys were described by `name || title || slug || id`, and the payloads
//              carry NONE of those four (they carry `journey_id`, so even the id
//              fallback missed). Every journey row had a blank column, since the
//              feed existed.
//   · audiences had a branch, sharing journeys' — and audiences emits no events
//              at all, so a third of that branch was permanently dead.
//   · shortener had no branch, so a claim showed as a bare type name.
//
// Each module now describes its own events (a `detail` map beside `events`; see
// server/src/event-catalog.js), and this is the one call that dispatches to them.
// The generic formatting helpers those declarations share — trim, money, pathOf —
// live in server/src/event-format.js, because `pathOf` alone encodes two bug
// fixes and a second copy would only have one of them.
import { detail as catalogDetail } from 'whitebox-pro-server/event-catalog'

let catalog = null
let logger = null

export function init(deps = {}) {
  catalog = deps.eventCatalog ?? null
  logger = deps.logger ?? null
}

/**
 * @param {string} type     the event type, e.g. 'mail.sent'
 * @param {object} payload  the notify() payload
 * @returns {string|null}   null when the emitting module has nothing to say —
 *                          "—" in the UI is honest, an invented summary is worse
 *                          than no summary.
 */
export function describe(type, payload) {
  return catalogDetail(catalog, type, payload, { logger })
}
