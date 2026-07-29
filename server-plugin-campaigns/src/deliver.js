// The default bulk delivery, used when no `deliver` hook is supplied.
//
// This exists because an optional hook that nobody wires is a hole, not a seam:
// campaigns' entire job is "send this to this audience", and with no hook that
// action threw `live delivery is not configured` while every other path — the
// per-passport activation journeys use — worked fine. The hook remains an
// override for a host that wants its own delivery; this just means the product
// sends out of the box.
//
// It stays a thin mapping, deliberately. Everything that makes a send correct
// already lives in the channel plugins: dedupe by normalised address,
// suppression and invalid-address filtering, batching, queueing, retry. All
// this does is turn a cohort of passport ids into recipients and hand over the
// campaign's own identity for attribution.
const CONTACT = { email: 'email', sms: 'phone' }

export function makeDeliver({ mail, sms, passports, logger }) {
  return async function deliver({ campaign, channel, subject, message, passportIds }) {
    const svc = channel === 'sms' ? sms : mail
    if (typeof svc?.bulkSend !== 'function') {
      const e = new Error(`the ${channel} plugin is not wired — cannot deliver this campaign`)
      e.status = 500
      throw e
    }

    // Resolve each passport to the address for this channel. A passport with
    // no email (or no phone) is dropped here rather than sent an empty
    // address: it's a targeting gap, not a delivery failure, and the channel
    // plugins would only reject it later with less context.
    const type = CONTACT[channel] || 'email'
    const recipients = []
    let noContact = 0
    for (const passportId of passportIds) {
      const rows = await passports.identities(passportId)
      const to = rows.find(r => r.type === type)?.value
      if (!to) { noContact++; continue }
      // passportId rides along so the outbox row is tied to a PERSON, not just
      // an address — that's what puts it in reach of merge/erase and of
      // "what has this person received"
      recipients.push({ to, passportId })
    }
    if (noContact) logger?.info('campaigns: %d of %d had no %s — skipped', noContact, passportIds.length, type)
    if (!recipients.length) return { batch_id: null, accepted: 0, no_contact: noContact }

    // campaignId is the whole point of stamping attribution: it's what
    // getResults() reads, and the only link between a campaign and the rows
    // its bulk send produced.
    const res = channel === 'sms'
      ? await svc.bulkSend({ body: message?.text, recipients, campaignId: campaign.id })
      : await svc.bulkSend({ subject, html: message?.html, text: message?.text, recipients, campaignId: campaign.id })

    return { ...res, no_contact: noContact }
  }
}
