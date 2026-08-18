import { describe, it, expect } from 'vitest'
import { extractUtms, getReferrer } from '../src/utms.js'

describe('extractUtms', () => {
  it('extracts present UTMs from the URL', () => {
    history.replaceState({}, '', '/?utm_source=google&utm_medium=cpc&utm_campaign=spring')
    expect(extractUtms()).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring',
    })
  })

  it('returns empty object when no UTMs', () => {
    history.replaceState({}, '', '/no-utms')
    expect(extractUtms()).toEqual({})
  })

  it('ignores non-UTM query params', () => {
    history.replaceState({}, '', '/?foo=bar&utm_source=x')
    expect(extractUtms()).toEqual({ utm_source: 'x' })
  })
})

// UTMs stranded in the FRAGMENT.
//
// A URL is positional: the first `#` closes the query string, and everything after it is
// fragment however many `?` and `&` it contains. An ad platform that builds a click URL
// by appending a tracking template to a landing page that already ends in an anchor
// produces exactly that, and the parameters go invisible twice over — a fragment is
// never sent to the server, and it is not in `location.search` where anything reading
// UTMs looks.
//
// Measured on live Google Ads traffic: 211,000 clicks in a fortnight produced 46,103
// attributed sessions, and 45,963 of those were the ONE campaign whose landing page had
// no anchor. Eighteen others produced 70 between them. Same account, same template; the
// difference was a `#`.
describe('extractUtms: parameters appended after an anchor', () => {
  it('recovers them from the fragment', () => {
    // The real recorded shape. gclid landed correctly because auto-tagging inserts it
    // structurally; the template's own parameters fell past the `#`.
    history.replaceState({}, '', '/?gad_source=1&gclid=Cj0KCQ#club?utm_source=adwords&utm_campaign=BG-Search-Sofia')
    expect(extractUtms()).toEqual({ utm_source: 'adwords', utm_campaign: 'BG-Search-Sofia' })
  })

  it('handles a fragment that is nothing but parameters', () => {
    history.replaceState({}, '', '/#?utm_source=adwords&utm_term=laser')
    expect(extractUtms()).toEqual({ utm_source: 'adwords', utm_term: 'laser' })
  })

  it('lets the QUERY STRING win — the fragment is a rescue, not a preference', () => {
    // A hash-routed app whose route carries ?utm_source must not override the campaign
    // that actually arrived.
    history.replaceState({}, '', '/?utm_source=real#/somewhere?utm_source=from-a-route&utm_campaign=only-in-hash')
    expect(extractUtms()).toEqual({ utm_source: 'real', utm_campaign: 'only-in-hash' })
  })

  it('leaves a plain anchor alone', () => {
    history.replaceState({}, '', '/?utm_source=adwords#club')
    expect(extractUtms()).toEqual({ utm_source: 'adwords' })
  })

  it('takes no non-UTM parameter from the fragment either', () => {
    history.replaceState({}, '', '/?gclid=abc#club?utm_source=adwords&secret=hunter2')
    expect(extractUtms()).toEqual({ utm_source: 'adwords' })
  })

  it('finds nothing in a fragment that has none', () => {
    history.replaceState({}, '', '/#club?section=2&open=true')
    expect(extractUtms()).toEqual({})
  })
})

describe('getReferrer', () => {
  it('returns document.referrer or null', () => {
    // happy-dom defaults referrer to ''
    expect(getReferrer()).toBeNull()
  })
})
