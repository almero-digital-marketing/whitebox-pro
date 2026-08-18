const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

/**
 * The parameters hiding in the FRAGMENT, when a tracking template appended them after
 * an anchor.
 *
 * A URL is positional: the first `#` closes the query string, and everything after it
 * is fragment however many `?` and `&` it contains. So an ad platform that builds a
 * click URL by concatenating a template onto a landing page that already ends in an
 * anchor produces
 *
 *   https://example.com/#club?utm_source=adwords&utm_campaign=BG-Search-Sofia
 *                       └──────────── all of this is the fragment ──────────┘
 *
 * and the parameters are invisible twice over: the browser never sends a fragment to
 * the server, and it is not in `location.search` where anything reading UTMs looks.
 *
 * Measured on live Google Ads traffic: 211,000 clicks in a fortnight produced 46,103
 * attributed sessions, and 45,963 of those were the ONE campaign whose final URL had no
 * anchor. Eighteen others — Search, Display, PMAX, Demand Gen — produced 70 between
 * them. The same account, the same template, the difference being a `#` in the landing
 * page. The giveaway was `gclid` and the UTMs disagreeing inside a single recorded URL:
 * auto-tagging inserts its parameter structurally, so it lands before the anchor, while
 * the template just joins strings.
 *
 * Read here rather than fixed only at the source because the fragment is the one part of
 * the URL the server can never see. If the browser does not recover it, nothing can —
 * and a misconfiguration that costs 78% of a channel's attribution should not be
 * unrecoverable while the visitor is still on the page. The platform config is still the
 * real fix: a fragment stops the parameters reaching server-side ingestion, CAPI and the
 * logs, all of which this cannot help.
 */
function fragmentParams() {
  const hash = window.location.hash || ''
  const q = hash.indexOf('?')
  if (q === -1) return null
  return new URLSearchParams(hash.slice(q + 1))
}

export function extractUtms() {
  if (typeof window === 'undefined') return {}
  const query = new URLSearchParams(window.location.search)
  const fragment = fragmentParams()
  const utms = {}
  for (const k of UTM_FIELDS) {
    // The QUERY STRING WINS. A parameter that arrived where parameters belong is the
    // more trustworthy of the two, and reading the fragment is a rescue, not a
    // preference — a hash-routed app whose route happens to carry `?utm_source` must not
    // override the real campaign.
    const v = query.get(k) || fragment?.get(k)
    if (v) utms[k] = v
  }
  return utms
}

export function getReferrer() {
  if (typeof document === 'undefined') return null
  return document.referrer || null
}
