const CC = /\b(?:\d[ -]*?){13,19}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/g

export function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(CC, '[REDACTED-CC]')
    .replace(SSN, '[REDACTED-SSN]')
    .replace(IBAN, '[REDACTED-IBAN]')
}

/**
 * A URL reduced to what identifies the PAGE — scheme, host, path — with the
 * query string and fragment dropped.
 *
 * A query string is whatever the site put in front of the visitor, and a page
 * view records it verbatim. On one live deployment that meant Stripe
 * `payment_intent_client_secret` values sitting in an analytics table for
 * months: a return-URL parameter nobody chose to store, kept because the URL
 * was stored whole. Session tokens, password-reset keys and prefilled form
 * fields arrive the same way. None of it is answerable analytics, and every one
 * of them is a credential in a table read by dashboards.
 *
 * `keep` is the deliberate exception, because query strings are not ALL noise.
 * Ad-click identifiers (gclid, fbclid) are the only record of which click led
 * to a visit, and unlike utm_* — which whitebox already stores as columns on
 * the session — they live nowhere else. Dropping them silently would take away
 * conversion attribution to buy privacy the operator did not ask for. So the
 * default is to keep NOTHING, and a deployment that needs a parameter names it:
 *
 *   awareness: { url: { keep: ['gclid', 'fbclid'] } }
 *
 * Named parameters are matched case-insensitively and re-emitted in the order
 * given, so the same visit always canonicalises to the same string — this value
 * is grouped and counted, and two spellings of one page would split every
 * total that mentions it.
 */
export function canonicalUrl(url, { keep = [] } = {}) {
  if (typeof url !== 'string' || url === '') return url
  const cut = url.search(/[?#]/)
  if (cut === -1) return url                      // nothing to strip
  const base = url.slice(0, cut)
  if (!keep.length) return base

  // Parsed by hand rather than with `new URL`: content_url is whatever a caller
  // sent, and a relative path ("/checkout?x=1") throws there. A regex over the
  // raw query keeps relative and absolute URLs on one path.
  const query = url.slice(cut + 1).split('#')[0]
  if (!query) return base
  const wanted = keep.map(k => String(k).toLowerCase())
  const found = new Map()
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const name = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase()
    if (wanted.includes(name) && !found.has(name)) found.set(name, pair)
  }
  const kept = wanted.map(k => found.get(k)).filter(Boolean)
  return kept.length ? `${base}?${kept.join('&')}` : base
}
