// Display helpers for event detail lines — the generic half of what used to be
// server-plugin-live/src/describe.js.
//
// A plugin writing a `detail` function (see event-catalog.js) needs these, and
// they must be shared: `pathOf` in particular encodes two bug fixes that took a
// while to find, and a second copy would only have one of them.
//
// Nothing here knows about any specific event. Anything that does belongs in the
// declaration of the module that emits it.

// A SAFETY cap, not a layout decision. Only the browser knows how wide the detail
// column actually is — truncating to a display width here clipped text with half
// the row still empty, and the ellipsis was the server's guess rather than the
// real boundary. So send the whole thing and let `text-overflow: ellipsis` cut it
// at the true edge; this bound exists only so a pathological payload can't put a
// kilobyte into every feed row. Matches core's PREVIEW_CHARS (160) with room for
// a "<kind> · " prefix.
export const MAX = 200

/** Normalise to a non-empty single-line-ish string, or null. Applied automatically
 *  to whatever a `detail` function returns, so no plugin has to remember MAX. */
export const trim = (s) => {
  if (s === null || s === undefined) return null
  const str = String(s).trim()
  if (!str) return null
  return str.length > MAX ? `${str.slice(0, MAX - 1)}…` : str
}

/** Payloads are nested one level: notify(type, { type, data }) — so the useful
 *  fields live at payload.data. Tolerates a bare payload too. */
export const body = (payload) => payload?.data ?? payload ?? {}

export const money = (value, currency) =>
  value === null || value === undefined || value === '' ? null : `${value}${currency ? ` ${currency}` : ''}`

/** Real page text arrives with newlines and runs of whitespace from the DOM; a
 *  feed row is one line, so flatten before truncating. */
export const collapse = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s)

// Percent-decoded for display. A non-ASCII path arrives encoded from the browser
// — gpoint.bg's routes are Bulgarian, so `/запазване-час` reaches us as
// `/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81`,
// which is both unreadable and long enough to crowd out the rest of the row.
//
// Decoding is DISPLAY-only: nothing here is stored, and nothing downstream matches
// on it. decodeURIComponent throws on a malformed sequence (a lone `%`, a
// truncated escape), and a feed row must never be the thing that breaks — so a
// failure keeps the raw string rather than losing the whole detail.
export function decodePath(s) {
  if (!s || !s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A url reduced to something that fits: path only, query dropped. */
export function pathOf(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    return trim(decodePath(u.pathname === '/' ? u.hostname : u.pathname))
  } catch {
    return trim(decodePath(url))
  }
}

/**
 * The PATH, always — where pathOf() substitutes the hostname when the path is
 * just `/`.
 *
 * That substitution is right for a link whose host is the point (a short link, a
 * referrer). It is wrong for a page view on your own site, where it turned
 * "someone viewed the homepage" into the word `localhost` — the host is the same
 * on every row and says nothing, while `/` at least says which page.
 */
export function urlPath(url) {
  if (!url) return null
  try {
    return trim(decodePath(new URL(url).pathname)) || '/'
  } catch {
    return trim(decodePath(url))
  }
}

/** A uuid cut to something a person can compare at a glance. The feed links out
 *  to the full record; eight characters is enough to tell two rows apart. */
export const short = (id) => (id ? String(id).slice(0, 8) : null)

/**
 * WHY this happened, when the payload says.
 *
 * Attribution is the question a feed is worst at answering: twenty sends look
 * identical, and the one that matters is the one nobody expected. A campaign or
 * journey id turns "we emailed someone" into "the July promo emailed someone",
 * which is the difference between a row you scroll past and a row you act on.
 *
 * Shared so it reads the same on every event that has it. Prefers a NAME when the
 * producer carries one — an id says "automated", a name says which.
 */
export function attribution(d = {}) {
  if (d.campaign_name) return `via campaign ${d.campaign_name}`
  if (d.campaign_id)   return `via campaign ${short(d.campaign_id)}`
  if (d.journey_name)  return `via journey ${d.journey_name}`
  if (d.journey_id)    return `via journey ${short(d.journey_id)}`
  // UTMs, for anything that carries the session's own attribution.
  const src = d.utm_source || null
  const camp = d.utm_campaign || null
  if (src && camp) return `${src} / ${camp}`
  if (src) return src
  return null
}

/** Letters/digits only (Latin + Cyrillic), so punctuation, case and word
 *  separators can't hide a match. */
export const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, '')
