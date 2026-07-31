// Reporter — resolves a passport into the hashed PII + signals the adapters
// consume, then fires one canonical event to every eligible network. Transport
// only; the trigger (which conversion, consent) is the route's concern.
//
// This is the standard-event fan-out that used to live (dormant) in the
// analytics plugin — its natural home is here, next to /conversions/events.

import { hashEmail, hashPhone, composeManifest } from 'whitebox-pro-adnetworks'

// networks: composed server descriptors — [ meta({…}), google({…}), … ] —
// each { name, signals, eligible, sendEvent }. No central registry.
export function createReporter({ networks = [], passports, logger, notify }) {
  const adapters = networks

  // Hashed PII comes from passport identities (never from awareness text, which
  // is redacted). external_id falls back to the passport id so even an anonymous
  // passport has a stable match key.
  async function resolveIds(passportId, signals = {}, extra = {}) {
    const ids = await passports.identities(passportId).catch(() => [])
    const find = t => ids.find(i => i.type === t)?.value || null
    return {
      email_sha256: hashEmail(find('email')),
      phone_sha256: hashPhone(find('phone')),
      external_id:  find('external_id') || passportId,
      signals,
      ip: extra.ip,
      user_agent: extra.user_agent,
    }
  }

  // Fire one canonical event ({ standard|event, event_id, ts, value?, … }) to
  // every eligible network. Returns { meta: 'accepted'|'rejected'|'skipped'|'error', … }.
  async function report(passportId, canonical, opts = {}) {
    const ids = await resolveIds(passportId, opts.signals || {}, opts)
    const eventName = canonical.standard || canonical.event || null
    const out = {}
    for (const a of adapters) {
      if (!a.eligible) { out[a.name] = 'skipped'; continue }
      const res = await a.sendEvent(canonical, ids).catch(e => ({ status: 'error', error: e.message }))
      out[a.name] = res.status
      if (res.error) logger?.warn?.({ network: a.name, error: res.error }, 'conversions: network rejected event')

      // One event per NETWORK CALL, distinct from the conversion that triggered
      // it. The conversion is the visitor's action (inbound); this is our own
      // outbound HTTP to Meta/TikTok/GA4, which succeeds or fails entirely
      // independently — a rejected CAPI send is an operational problem the
      // conversion event can't express, because it already counted as a success.
      // `adnetwork.${status}` mirrors mail/sms's `${channel}.${status}` shape, so
      // it classifies and reads the same way in the monitoring view.
      notify?.(`adnetwork.${res.status || 'error'}`, {
        type: `adnetwork.${res.status || 'error'}`,
        data: {
          network: a.name,
          status: res.status || 'error',
          event: eventName,
          event_id: canonical.event_id ?? null,
          passport_id: passportId,
          // WHICH page. "tiktok · page_view" is unreadable on a busy feed —
          // page_view of what? Taken from opts rather than added to `canonical`
          // on purpose: canonical is what we transmit to Meta/TikTok/GA4, and
          // this is for our own monitoring, not something to start sending them.
          url: opts.url ?? null,
          // Present only on a failure — the reason is the whole value of the event.
          error: res.error ?? null,
        },
      })?.catch?.(() => {})
    }
    return out
  }

  return {
    adapters,
    report,
    manifest: () => composeManifest(adapters),
    networks: () => adapters.map(a => ({ name: a.name, eligible: a.eligible, transport: a.transport || 'http' })),
  }
}
