// Shortener client plugin — the landing-page half of a personalized short link.
//
// When a click arrives via a short link, the server's redirect left a single-use
// claim token in the URL (`?wb=` or `#wb=`). This plugin redeems it: the server
// returns the customer the link was bound to (merging this browser's anonymous
// passport into them server-side), and we adopt that passport for the session +
// expose the link's prefill data as `wb.shortener.data()`.
//
// `data`/`bound` are methods (not plain properties) so core's namespace proxy
// can defer a pre-attach call to `wb.shortener.data()` — a bare property has
// nowhere to queue an early read to. They return plain values, not Promises:
// the proxy itself is what wraps the pre-attach case in a Promise.

// Read the claim token synchronously, at plugin-construction time — this
// runs the instant `shortener()` is called while building a `plugins: [...]`
// array, i.e. before any app/router bootstrapping. It must NOT move into
// install(): core's init() awaits each plugin's install() in sequence
// (so a later plugin can read state an earlier one attached), and an
// earlier plugin doing real async work (e.g. geolocation's session-resolve
// round trip) can push this plugin's install() well past the point where
// the host app's router has already normalized/replaced the URL and
// dropped the fragment the token rides in. Reading here instead is immune
// to plugin order and install timing entirely.
const initialToken = typeof location === 'undefined' ? null
  : new URL(location.href).searchParams.get('wb')
    || new URLSearchParams(location.hash.replace(/^#/, '')).get('wb')

export default function shortenerPlugin() {
  return {
    name: 'shortener',

    async install(core) {
      const { http, getPassportId, setPassportId, attach, logger } = core

      // Covers both SSR (no `location`) and no-token: initialToken is only
      // non-null when a real browser location had a `wb` token to read.
      if (!initialToken) return attach('shortener', noClaim())
      const token = initialToken

      // Redeem the ticket — pass our current (anonymous) passport so the server
      // can merge it into the customer the link belongs to.
      const res = await http.request('/shortener/claim', {
        method: 'POST',
        body: { token, passport_id: getPassportId?.() },
      }).catch(err => { logger?.warn?.('shortener: claim failed', err); return null })

      // Scrub the token from the address bar so it can't be re-shared/re-claimed.
      // Re-derive from the current location (not the one captured above) —
      // the URL may have moved on by the time this runs.
      const url = new URL(location.href)
      url.searchParams.delete('wb')
      if (url.hash.includes('wb=')) url.hash = ''
      try { history.replaceState(null, '', url.toString()) } catch {}

      // Become that customer, and expose the prefill.
      if (res?.bound && res.passport_id) setPassportId?.(res.passport_id)
      const data = res?.data ?? null
      const bound = !!res?.bound
      attach('shortener', { data: () => data, bound: () => bound })
    },
  }
}

function noClaim() {
  return { data: () => null, bound: () => false }
}
