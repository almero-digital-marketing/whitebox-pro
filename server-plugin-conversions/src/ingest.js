// Ingest — the core of the plugin. Takes a raw event off the wire, validates it
// against the shared schemas, records it as a first-party awareness signal, and
// (consent permitting) fans it out to the ad networks. Idempotent by event_id.
//
// Trust model: the passport_id is the one the client carries (minted at
// /sessions/resolve) — we trust it as the identifier, same as the rest of the
// browser ingress. No session lookup.

import { randomUUID } from 'node:crypto'
import { validateEvent, validateCustom } from 'whitebox-pro-adnetworks/schemas'

import * as store from './store.js'

let awareness, reporter, consentOk, logger, resolvePassport, notify

export function init(deps) {
  awareness = deps.awareness
  reporter  = deps.reporter
  consentOk = deps.consentOk            // async (passportId) => boolean
  logger    = deps.logger
  resolvePassport = deps.resolvePassport // async (id) => survivor id (merge chain)
  notify = deps.notify
}

// A readable, embeddable one-liner so the conversion is queryable via recall
// ("who purchased?", "interest in whitening"). This is what gets EMBEDDED, and
// what a monitoring feed shows as the event's preview.
//
// It used to be the event name and nothing else. A page view recorded the text
// "Conversion: page view" — identical on every row, on every page, forever — so
// the one question this data exists to answer ("who looked at the booking page?")
// could not be answered by recall at all. Compare an engagement row, which embeds
// the sentence the person actually read.
//
// So WHAT they were looking at goes in, from the page title the client sends
// (client-plugin-conversions), falling back to the decoded path. The url alone is
// not a fix: `/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7…` is not language and embeds as
// noise, while "Запазване на час" is the thing someone would actually search for.
//
// The "Conversion: <name>" prefix stays, and stays first: recall relies on the
// verb ("who purchased?") being in the text. Core strips that leading echo for
// DISPLAY (see stripTypeEcho in event-catalog.js), so the feed shows the
// substance while the embedding keeps both.
function describe(name, p, ctx = {}) {
  const bits = [`Conversion: ${name.replace(/_/g, ' ')}`]
  const where = ctx.title || decodedPath(ctx.url)
  if (where)                  bits.push(where)
  if (p.value != null)        bits.push(`${p.value}${p.currency ? ' ' + String(p.currency).toUpperCase() : ''}`)
  if (p.num_items != null)    bits.push(`${p.num_items} item${p.num_items === 1 ? '' : 's'}`)
  // Skipped when it would just repeat the title — a caller that sets
  // content_name to the page name shouldn't produce it twice.
  if (p.content_name && p.content_name !== where) bits.push(p.content_name)
  if (p.content_ids?.length)  bits.push(p.content_ids.join(', '))
  if (p.search_string)        bits.push(`"${p.search_string}"`)
  return bits.join(' — ')
}

// The path, percent-decoded, so a Bulgarian route reads as words rather than as
// escape sequences. Local to ingest because this feeds the EMBEDDING, where
// event-format's display cap and hostname fallback are both wrong.
function decodedPath(url) {
  if (!url) return null
  try {
    const { pathname } = new URL(url)
    if (pathname === '/') return null            // the homepage adds nothing here
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

// Process one raw wire event for a passport.
//   raw: { standard|event, event_id?, ts?, url?, ...payload }
// Returns { event_id, name, status: 'recorded'|'duplicate', networks }.
export async function ingestEvent(passportId, raw = {}, reqCtx = {}) {
  // Canonicalize the client-supplied passport through the merge chain (no session
  // lookup — we still trust the id) so a stale/absorbed id maps to its survivor
  // for the awareness record, audit row, and ad-network fan-out alike.
  if (resolvePassport) passportId = await resolvePassport(passportId)

  const { standard, event: customName, ts, url, title, ...payloadIn } = raw

  // Validate against the right schema (unknown keys — standard/ts/url/title are
  // already destructured out; the schema strips anything else into nothing).
  // `title` rides alongside `url` for exactly that reason: it is context about
  // where the event happened, not part of any network's event schema.
  let name, kind, clean
  if (standard) {
    name = standard; kind = 'standard'
    clean = validateEvent(standard, payloadIn)        // throws on invalid
  } else if (customName) {
    name = customName; kind = 'custom'
    clean = validateCustom(payloadIn)
  } else {
    throw new Error('conversions: event needs a `standard` or `event` name')
  }

  const eventId = clean.event_id || randomUUID()
  const when = ts ? new Date(ts) : new Date()

  // Idempotency: the browser may double-fire (sendBeacon on unload), and the
  // pixel dedupes on the same id — so do too.
  const existing = await store.seen(eventId)
  if (existing) return { event_id: eventId, name, status: 'duplicate', networks: existing.networks || {} }

  // First-party recording always happens — it's the user's own action. Consent
  // only gates the ad-network fan-out below.
  await awareness.record({
    passport_id: passportId,
    ts:          when,
    channel:     'web',
    direction:   'conversion',
    source:      'conversion',
    content_id:  `conversion:${name}:${eventId}`,
    content_url: url || null,
    text:        describe(name, clean, { url, title }),
    meta:        { kind, event_id: eventId, ...clean },
  }).catch(err => logger?.warn?.({ err }, 'conversions: awareness.record failed'))

  // Fan out to the networks, consent permitting.
  let networks = {}
  if (await consentOk(passportId)) {
    const canonical = {
      [kind === 'standard' ? 'standard' : 'event']: name,
      event_id: eventId,
      ts: when.toISOString(),
      value: clean.value, currency: clean.currency,
      content_ids: clean.content_ids, num_items: clean.num_items,
      transaction_id: clean.transaction_id,
    }
    networks = await reporter.report(passportId, canonical, {
      signals: reqCtx.signals || {}, ip: reqCtx.ip, user_agent: reqCtx.user_agent,
      // For the adnetwork event's own detail line, not for the networks — see
      // the note at its notify(). Deliberately not folded into `canonical`,
      // which is the payload we transmit.
      url,
    })
  } else {
    networks = { skipped: 'consent' }
  }

  await store.insert({
    passport_id: passportId,
    event_id:    eventId,
    name, kind,
    value:    clean.value ?? null,
    currency: clean.currency ?? null,
    url:      url || null,
    networks,
    payload:  clean,
  }).catch(err => logger?.warn?.({ err }, 'conversions: audit insert failed'))

  // Distinctly-named event — otherwise a conversion is only ever visible as
  // the generic awareness.recorded (no name/value in that payload).
  notify?.(`conversion.${name}`, {
    type: `conversion.${name}`,
    data: { event_id: eventId, passport_id: passportId, kind, value: clean.value ?? null, currency: clean.currency ?? null, url: url || null, networks },
  })

  logger?.info?.(
    { eventId, name, kind, passportId, value: clean.value ?? null, currency: clean.currency ?? null, networks },
    'Conversion %s: %s', name, networks.skipped ? `skipped (${networks.skipped})` : Object.keys(networks).join(', ') || 'awareness-only',
  )
  return { event_id: eventId, name, status: 'recorded', networks }
}

// Process a batch; each event is independent — one bad event doesn't sink the
// rest. Returns one result per event (validation failures included).
export async function ingestBatch(passportId, events = [], reqCtx = {}) {
  const results = []
  for (const raw of events) {
    try {
      results.push(await ingestEvent(passportId, raw, reqCtx))
    } catch (err) {
      results.push({ status: 'invalid', error: err.message })
    }
  }
  return results
}
