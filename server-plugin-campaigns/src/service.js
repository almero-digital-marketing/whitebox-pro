// Service layer — the single implementation REST (and, later, MCP) calls. No transport here.
//
// Cross-plugin: campaigns reuse the AUDIENCES plugin's service (injected as deps.audiences) for
// audience resolution + consent gating — we never re-implement set algebra or consent. The UI
// owns the audience binding (many-to-many) + scheduling; Mikser upserts the content (by external_id).
// Executing LOCKS the campaign and stamps real stats. Bulk delivery is dry-run by default (the
// `dryRun` config switch) and goes live through the host-wired `deliver` hook (→ mail/sms plugins).
//
// activateForPassport() is a SEPARATE delivery mode — one campaign's content, ONE passport,
// independent of the bulk schedule/lock lifecycle (any status works, not just draft/scheduled).
// It calls mail/sms's queueSend directly (never `.send` — that bypasses consent) rather than the
// `deliver` hook, and honors the same `dryRun` switch. Used by Journeys' `trigger_campaign` step,
// and exposed as its own REST/MCP action for direct per-customer sends.

import { randomUUID } from 'node:crypto'
import { validateInput, validateUpsert, fromRow, isLocked } from './campaigns.js'

let store, audiences, deliver, dryRun, logger, mail, sms, passports, notify

export function init(deps) {
  ({ store, audiences, deliver, dryRun, logger, mail, sms, passports, notify } = deps)
}

// --- read ---
export const listCampaigns = async () => (await store.listCampaigns()).map(fromRow)
export async function searchCampaigns(opts = {}) {
  const { total, rows } = await store.searchCampaigns(opts)
  return { total, rows: rows.map(fromRow) }
}

// Full campaign: + its attached audiences (id, name, size) + a resolved analytics_prompt.
export async function getCampaign(id) {
  const row = await store.getCampaign(id)
  if (!row) return null
  const c = fromRow(row)
  c.audiences = await attachedAudiences(id)
  c.analytics_prompt = c.analytics_prompt || defaultPrompt(c, c.audiences.map(a => a.name))
  return c
}

// the attached audiences with a best-effort live size (resolved via the audiences plugin)
async function attachedAudiences(campaignId) {
  const ids = await store.audienceIds(campaignId)
  return Promise.all(ids.map(async (audience_id) => {
    let name = audience_id, size = null
    try { const a = await audiences.getAudience(audience_id); if (a) name = a.name } catch { /* deleted */ }
    try { size = (await audiences.resolveAudience(audience_id)).count } catch { /* best-effort */ }
    return { id: audience_id, name, size }
  }))
}

// --- write (UI) ---
export async function saveCampaign(input) {
  const a = validateInput(input)
  if (!a.name || !a.channel) { const e = new Error('name and channel are required'); e.status = 400; throw e }
  const row = await store.insertCampaign({
    id: randomUUID(), source: 'ui', name: a.name, channel: a.channel,
    subject: a.subject ?? null, scheduled_at: a.scheduled_at ?? null,
    message: a.message ? JSON.stringify(a.message) : null,
    analytics_prompt: a.analytics_prompt ?? null,
  })
  return getCampaign(row.id)
}

export async function patchCampaign(id, input) {
  await loadEditable(id)
  const a = validateInput({ ...input, id })
  const fields = {}
  for (const k of ['name', 'channel', 'subject', 'scheduled_at', 'analytics_prompt', 'report_id']) {
    if (a[k] !== undefined) fields[k] = a[k]
  }
  if (a.message !== undefined) fields.message = a.message ? JSON.stringify(a.message) : null
  if (a.objective !== undefined) fields.objective = a.objective ? JSON.stringify(a.objective) : null
  // Light response (no audience cohort resolution) — a field edit doesn't change the audience
  // set, so don't pay to re-resolve every attached audience's size on every keystroke/toggle.
  return fromRow(await store.updateCampaign(id, fields))
}

// Mikser create-or-update (idempotent on external_id). Owns all content; never the audiences.
export async function upsertCampaign(input) {
  const a = validateUpsert(input)
  const existing = await store.getCampaignByExternalId(a.external_id)
  const fields = {
    name: a.name, channel: a.channel, subject: a.subject ?? null,
    scheduled_at: a.scheduled_at ?? null, message: a.message ? JSON.stringify(a.message) : null,
  }
  if (existing) {
    if (isLocked(fromRow(existing))) { const e = new Error('campaign is locked (already sent)'); e.status = 409; throw e }
    await store.updateCampaign(existing.id, { ...fields, source: 'mikser' })
    return getCampaign(existing.id)
  }
  const row = await store.insertCampaign({ id: randomUUID(), source: 'mikser', external_id: a.external_id, ...fields })
  return getCampaign(row.id)
}

export async function deleteCampaign(id) { return store.deleteCampaign(id) }

// --- audiences (many-to-many; UI only) ---
export async function attachAudience(id, audienceId) {
  await loadEditable(id)
  if (!audienceId) { const e = new Error('audience_id required'); e.status = 400; throw e }
  await store.attachAudience(id, audienceId)
  return getCampaign(id)
}
export async function detachAudience(id, audienceId) {
  await loadEditable(id)
  await store.detachAudience(id, audienceId)
  return getCampaign(id)
}

// --- delivery preview: consent-gated UNION of the attached audiences (counts only) ---
export async function previewDelivery(id) {
  await getOr404(id)
  const ids = await unionPassports(id)
  return audiences.previewCohort(ids)
}

async function unionPassports(campaignId) {
  const audIds = await store.audienceIds(campaignId)
  const seen = new Set()
  for (const audId of audIds) {
    try { for (const pid of (await audiences.resolveAudience(audId)).ids) seen.add(pid) }
    catch (err) { logger?.warn?.({ err, audId }, 'campaigns: resolveAudience failed') }
  }
  return [...seen]
}

// --- schedule: commit the campaign for delivery at its scheduled_at and LOCK it for edits.
// If the send time has already passed (or is now), delivery fires immediately and the campaign
// goes straight to 'sent' (stats + sent_at) — a report only makes sense once it's been delivered.
// A future time stays 'scheduled' (locked, awaiting the send worker; no report yet). Either way
// you don't "send" from the UI — you schedule, and a past time is just due.
export async function schedule(id, { counts } = {}) {
  const c = fromRow(await getOr404(id))
  if (isLocked(c)) { const e = new Error('campaign already scheduled'); e.status = 409; throw e }
  const ready = c.channel === 'sms' ? !!c.message?.text : !!c.message?.html
  const audIds = await store.audienceIds(id)
  if (!audIds.length) { const e = new Error('attach at least one audience first'); e.status = 400; throw e }
  if (!ready) { const e = new Error('the message is not ready yet'); e.status = 400; throw e }
  if (!c.scheduled_at) { const e = new Error('set a send date and time first'); e.status = 400; throw e }

  // Reuse the reach the UI already previewed (server-computed moments ago) — only resolve the
  // cohort here if it wasn't supplied. And return LIGHT (no audience re-resolution). Together
  // these drop the lock from ~two full cohort resolves to ~zero.
  let n = counts
  if (!n || n.deliverable == null) n = await audiences.previewCohort(await unionPassports(id))

  const due = new Date(c.scheduled_at).getTime() <= Date.now()    // past/now ⇒ deliver immediately
  if (!due) {
    // committed for a future time — project the reach; dry_run reflects the configured mode.
    const stats = { resolved: n.resolved, suppressed: n.suppressed, no_consent: n.no_consent, reach: n.deliverable, dry_run: dryRun }
    return fromRow(await store.updateCampaign(id, { status: 'scheduled', stats: JSON.stringify(stats) }))
  }
  const stats = await runDelivery(c, n)   // dry-run records; live hands off to the deliver hook
  return fromRow(await store.updateCampaign(id, { status: 'sent', sent_at: new Date().toISOString(), stats: JSON.stringify(stats) }))
}

// --- manual send: deliver to the attached audiences' union RIGHT NOW, WITHOUT locking or
// stamping status/sent_at. Deliberately a SEPARATE action from schedule(), not a "scheduled_at set
// to now" special case of it — schedule()'s lock exists because committing to a bulk send is
// meant to be a one-time, protect-from-accidental-edits event. A manual send has no such
// intent: it's repeatable (tweak the message, send again), matching how a Journey's
// `trigger_campaign` step can also activate this campaign at any time, any number of times,
// independent of its bulk lifecycle. `stats` still gets stamped (so a preview number reflects the
// last run), but the campaign stays in whatever status it already was — always 'draft' in
// practice, since a locked campaign never reaches this function at all.
export async function sendManual(id, { counts } = {}) {
  const c = fromRow(await getOr404(id))
  if (isLocked(c)) { const e = new Error('campaign is locked (scheduled or sent)'); e.status = 409; throw e }
  const ready = c.channel === 'sms' ? !!c.message?.text : !!c.message?.html
  if (!ready) { const e = new Error('the message is not ready yet'); e.status = 400; throw e }
  const audIds = await store.audienceIds(id)
  if (!audIds.length) { const e = new Error('attach at least one audience first'); e.status = 400; throw e }

  let n = counts
  if (!n || n.deliverable == null) n = await audiences.previewCohort(await unionPassports(id))
  const stats = await runDelivery(c, n)
  return fromRow(await store.updateCampaign(id, { stats: JSON.stringify(stats) }))
}

// Deliver a DUE campaign and return the stats to stamp. `dryRun` (config; default ON) is the
// safety switch: it records the projected reach as "sent" WITHOUT sending. Live mode resolves the
// consent-gated deliverable cohort and hands it to the host `deliver` hook (→ mail/sms plugins).
async function runDelivery(c, n) {
  const base = { resolved: n.resolved, suppressed: n.suppressed, no_consent: n.no_consent }
  if (dryRun) return { ...base, sent: n.deliverable, dry_run: true }
  if (typeof deliver !== 'function') {
    const e = new Error('live delivery is not configured — set campaigns.dryRun=true or wire the deliver hook')
    e.status = 500; throw e
  }
  const passportIds = await audiences.deliverableCohort(await unionPassports(c.id))
  // The hook receives the whole campaign because it MUST stamp campaign_id on
  // the rows it creates (mail/sms migration 015/005) — that column is the only
  // thing getResults() reads. A hook that ignores it delivers fine and reports
  // nothing.
  const res = await deliver({ campaign: c, channel: c.channel, subject: c.subject, message: c.message, passportIds })
  const stats = { ...base, sent: passportIds.length, batch_id: res?.batch_id ?? res?.id ?? null, dry_run: false }
  notify?.('campaigns.sent', { type: 'campaigns.sent', data: { campaign_id: c.id, channel: c.channel, ...stats } })
  return stats
}

// --- results ---
// What actually happened, as opposed to previewDelivery()'s "what would".
//
// Campaigns never reads mail's or sms's tables: it asks each plugin for its own
// funnel, the same way it asks them to queueSend. That boundary is what lets a
// deployment run without one of them — a missing channel plugin yields an
// `unavailable` note rather than a crash, matching every other optional
// dependency here.
//
// Dry runs are excluded outright. They stamp a send row for the audit trail but
// nothing left the building, so counting them would report reach that never
// existed.
export async function getResults(id) {
  const c = await getOr404(id)
  const runs = (await store.listSends(id)).filter(s => !s.dry_run)

  // pre-flight reach, summed across runs: who resolved, and why the rest fell
  // out. Already recorded per run — this is the only place it's ever surfaced.
  const reach = runs.reduce((a, r) => ({
    resolved: a.resolved + (r.resolved || 0),
    deliverable: a.deliverable + (r.deliverable || 0),
    suppressed: a.suppressed + (r.suppressed || 0),
    no_consent: a.no_consent + (r.no_consent || 0),
  }), { resolved: 0, deliverable: 0, suppressed: 0, no_consent: 0 })

  // Both channels are asked about this campaign, not just the one the campaign
  // currently says it uses: its channel is editable after a send, and a journey
  // can activate it per-passport with no send run at all. Each plugin answers
  // for its own table by campaign_id; a channel with no rows is dropped below,
  // so asking costs one cheap indexed count.
  const delivery = {}
  for (const [channel, svc] of [['email', mail], ['sms', sms]]) {
    if (typeof svc?.funnel !== 'function') {
      // only worth saying when this channel plausibly sent something
      if (c.channel === channel) {
        delivery[channel] = { unavailable: `the ${channel} plugin is not wired on this deployment` }
      }
      continue
    }
    try {
      const f = await svc.funnel({ campaignId: id })
      if (f.total > 0) delivery[channel] = f
    } catch (err) {
      logger?.warn({ err }, 'campaigns: %s funnel failed for campaign %s', channel, id)
      delivery[channel] = { unavailable: err.message }
    }
  }

  return {
    campaign_id: id,
    channel: c.channel,
    runs: runs.map(r => ({
      id: r.id, channel: r.channel, batch_id: r.batch_id, status: r.status, sent_at: r.sent_at,
      resolved: r.resolved, deliverable: r.deliverable, suppressed: r.suppressed, no_consent: r.no_consent,
    })),
    reach,
    delivery,
  }
}

// Self-describing health, for any monitoring surface (see
// docs/10-plugin-status.md). The board holds no campaigns knowledge: this names
// its own numbers and says which one is bad news.
//
// `sent` and `dry run` are windowed on sent_at; the state counts are not
// windowed and can't be — see store.healthCounts for which is which and why.
//
// A dry-run send is deliberately NOT marked bad. dryRun defaults ON, so on a
// deployment that hasn't gone live every send is a dry run: flagging it would
// paint the whole card red for a system behaving exactly as configured. The note
// says so instead, which is the part an operator actually needs to know.
//
// `whitebox_campaign_sends` is not read here. insertSend() has never been
// called by any path (see getResults, which reads an always-empty table), so
// counting run rows would report a hard zero as if it were news.
//
// Never throws: a failed read reports no metrics and says so, rather than
// zeros — zero means "nothing happened", which is a different claim.
export async function status({ since } = {}) {
  const from = since instanceof Date ? since : since ? new Date(since) : new Date(0)
  let c
  try {
    c = await store.healthCounts(from)
  } catch (err) {
    logger?.warn?.({ err }, 'campaigns: status counts failed')
    return { label: 'campaigns', metrics: [], note: 'campaign counts could not be read — see the server log' }
  }

  return {
    label: 'campaigns',
    metrics: [
      // Windowed: both FILTER on sent_at >= since (store.healthCounts).
      { key: 'sent', value: c.sent },
      { key: 'dry run', value: c.dry_run },
      // Current state: these three count by `status`, which has no timestamp to
      // window. A draft created last year is still a draft today, so widening the
      // window can't change them — hence `live`.
      { key: 'scheduled', value: c.scheduled, live: true },
      { key: 'drafts', value: c.draft, live: true },
      // Committed to a send time that has passed, and still sitting there —
      // there is no worker that will pick it up.
      { key: 'overdue', value: c.overdue, severity: 'bad', live: true },
    ],
    // No `of` on any of these: a campaign has no ceiling, so there is nothing for
    // a ratio to be measured against and a denominator would invent one.
    note: c.overdue
      ? `${c.overdue} campaign${c.overdue === 1 ? '' : 's'} past ${c.overdue === 1 ? 'its' : 'their'} send time and still scheduled — nothing will deliver ${c.overdue === 1 ? 'it' : 'them'}`
      : dryRun
        ? 'delivery is dry-run — a send records the reach it would have had without leaving the building'
        : null,
  }
}

// link the Analytics report built from this campaign (allowed post-send)
export async function setReport(id, reportId) {
  await getOr404(id)
  return fromRow(await store.updateCampaign(id, { report_id: reportId }))   // light — no audience re-resolve
}

// Unlock a SCHEDULED campaign back to an editable draft — pull it back before it's delivered.
// A delivered (sent) campaign is final and can't be unlocked (delete it instead). Clears the
// send stamp + stats so it reads as a draft again; the linked report (if any) is kept.
export async function unlockCampaign(id) {
  const c = fromRow(await getOr404(id))
  if (c.status === 'sent') { const e = new Error('a delivered campaign is final and can’t be unlocked'); e.status = 409; throw e }
  return fromRow(await store.updateCampaign(id, { status: 'draft', sent_at: null, stats: null }))   // light
}

// --- per-customer activation: trigger this campaign's content for ONE passport, independent of
// the bulk schedule/lock lifecycle (a campaign already sent in bulk once can still be triggered
// per-customer indefinitely after — e.g. a "Welcome Email" campaign a journey re-triggers for
// every new signup). Consent/suppression is still a hard gate; audience MEMBERSHIP is not — the
// caller (a journey enrollment, or a direct API call) already decided this passport should get it.
export async function activateForPassport(id, passportId, opts = {}) {
  if (!passportId) { const e = new Error('passport_id required'); e.status = 400; throw e }
  const c = fromRow(await getOr404(id))
  const ready = c.channel === 'sms' ? !!c.message?.text : !!c.message?.html
  if (!ready) { const e = new Error('the message is not ready yet'); e.status = 400; throw e }

  const [deliverableId] = await audiences.deliverableCohort([passportId])
  if (!deliverableId) return { sent: false, reason: 'suppressed_or_no_consent' }

  if (dryRun) {
    notify?.('campaigns.activated', { type: 'campaigns.activated', data: { campaign_id: id, passport_id: passportId, channel: c.channel, dry_run: true } })
    return { sent: true, dry_run: true }
  }

  const to = await resolveIdentity(passportId, c.channel === 'sms' ? 'phone' : 'email')
  if (!to) return { sent: false, reason: 'no_contact' }

  // Attribution (migration 015 / 005): this path stamps no batch — it's one
  // passport, not a run — so without these the send would be invisible to both
  // this campaign's results and the journey's. `journeyId` comes from the
  // caller because campaigns doesn't know who invoked it.
  const idempotencyKey = opts.idempotencyKey
  const attribution = { campaignId: id, journeyId: opts.journeyId || null }
  if (c.channel === 'sms') {
    if (!sms) { const e = new Error('sms service not wired'); e.status = 500; throw e }
    await sms.queueSend({ to, body: c.message.text, passportId, idempotencyKey, ...attribution })
  } else {
    if (!mail) { const e = new Error('mail service not wired'); e.status = 500; throw e }
    await mail.queueSend({ to, subject: c.subject, html: c.message.html, passportId, idempotencyKey, ...attribution })
  }
  notify?.('campaigns.activated', { type: 'campaigns.activated', data: { campaign_id: id, passport_id: passportId, channel: c.channel, dry_run: false } })
  return { sent: true, dry_run: false }
}

async function resolveIdentity(passportId, type) {
  const rows = await passports.identities(passportId)
  return rows.find(r => r.type === type)?.value || null
}

// --- helpers ---
async function getOr404(id) {
  const row = await store.getCampaign(id)
  if (!row) { const e = new Error('campaign not found'); e.status = 404; throw e }
  return row
}
async function loadEditable(id) {
  const row = await getOr404(id)
  if (isLocked(fromRow(row))) { const e = new Error('campaign is locked (already sent)'); e.status = 409; throw e }
  return row
}

// The default, user-extendable report prompt — built from the campaign's OBJECTIVES (goals +
// notes) so the AI report measures what the campaign was actually for, plus channel/audience/size.
function defaultPrompt(c, audienceNames = []) {
  const when = c.sent_at || c.scheduled_at
  const date = when ? new Date(when).toISOString().slice(0, 10) : ''
  const who = audienceNames.length ? ` to ${audienceNames.join(', ')}` : ''
  const n = c.stats?.sent != null ? `${c.stats.sent} people` : 'its recipients'
  const goals = (c.objective?.goals || [])
  const objBits = [goals.join(', '), c.objective?.notes].filter(Boolean).join(' — ')
  const objLine = objBits ? ` Its objectives were: ${objBits}.` : ''
  const measure = goals.length
    ? `Build charts that measure performance against each objective (${goals.join(', ')})`
    : 'Build charts measuring delivery and open/click rates, the bookings and revenue it drove'
  return `Report on the "${c.name}" ${c.channel} campaign${date ? ` sent ${date}` : ''}${who} (${n}).${objLine} ${measure}, and show which audiences responded best.`
}
