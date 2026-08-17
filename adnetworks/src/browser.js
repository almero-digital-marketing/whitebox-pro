// Client-safe browser helpers used by the network packages' client (pixel)
// modules to read ad cookies/click-ids and shape payloads. Pure — no node deps,
// safe to bundle.

export function cookie(name) {
  if (typeof document === 'undefined') return null
  const esc = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1')
  const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

export function param(name) {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

// Click ids arrive ONCE, on the landing page, and every network reads them with
// param(). That works only if the conversion happens on that same page view —
// which is exactly what a conversion usually isn't. By the time someone books,
// the id has been gone for several page loads, so the hit goes up without it and
// the network cannot attribute the sale to the click that produced it.
//
// Meta papers over this with its own `_fbc` cookie and Google with `_gcl_*`, but
// both depend on that vendor's tag being present and on its cookie format. This
// is the same trick without either dependency: first sight wins, and it is
// remembered for `ttl` days.
//
// Deliberately in the AD-NETWORK package, not in core: core has no business
// knowing what a gclid is. Each network names its own ids in its spec, and the
// mechanism here stays generic.
const STORE_PREFIX = 'wb:ad:'
const DEFAULT_TTL_DAYS = 90            // Google's offline-conversion window

function readStore(key) {
  try {
    const raw = window.localStorage?.getItem(STORE_PREFIX + key)
    if (!raw) return null
    const { v, exp } = JSON.parse(raw)
    if (exp && Date.now() > exp) {
      window.localStorage.removeItem(STORE_PREFIX + key)
      return null
    }
    return v ?? null
  } catch { return null }             // private mode / disabled storage / bad JSON
}

function writeStore(key, value, ttlDays) {
  try {
    window.localStorage?.setItem(STORE_PREFIX + key, JSON.stringify({
      v: value,
      exp: Date.now() + ttlDays * 864e5,
    }))
  } catch { /* nothing to do — the URL value is still returned this page view */ }
}

/**
 * A URL parameter that survives the landing page. Reads the URL first (a fresh
 * click always wins, so a second campaign is not attributed to the first), then
 * falls back to what was remembered.
 */
export function stickyParam(name, { ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (typeof window === 'undefined') return null
  const fresh = param(name)
  if (fresh) {
    writeStore(name, fresh, ttlDays)
    return fresh
  }
  return readStore(name)
}

/**
 * Every click id the given networks declare, as `{ type, name, value }` identity
 * claims — the shape core's `identify()` forwards without interpreting.
 *
 * `clickid` is a WEAK identity type, which matters: weak identities attach to one
 * passport and never drive a merge. Click ids look unique but are not — measured
 * on live traffic, 2,237 distinct gclid values had been seen by more than one
 * passport (one by nine of them), and gbraid is coarser still at 48%, because it
 * identifies a campaign rather than a click when consent limits tracking. As a
 * strong (merge-key) type those would have fused thousands of unrelated people.
 */
export function clickIdClaims(networks = []) {
  const claims = []
  const seen = new Set()
  for (const net of networks) {
    for (const spec of (net?.signals || [])) {
      if (!spec?.clickId || spec.from !== 'url' || seen.has(spec.name)) continue
      seen.add(spec.name)
      const value = stickyParam(spec.name)
      if (value) claims.push({ type: 'clickid', name: spec.name, value })
    }
  }
  return claims
}

export const removeUndefined = obj => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v
  return out
}

// Normalise the canonical payload's product refs into a single item list.
export const toItems = p => {
  if (p.contents?.length) return p.contents
  if (p.content_ids?.length) return p.content_ids.map(id => ({ id }))
  return undefined
}
