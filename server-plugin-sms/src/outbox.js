import { z } from 'zod'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as sender from './sender.js'
import { toE164 } from './phone.js'

const TABLE = 'whitebox_sms_outbox'

// queued → sent → delivered / undelivered / failed (terminal); cancelled via batch.
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, undelivered: 2, failed: 2, cancelled: 3 }
const ADVANCEABLE = ['queued', 'sent']                 // statuses a DLR/status callback may advance from
const STATUS_AT = { sent: 'sent_at', delivered: 'delivered_at', undelivered: 'failed_at', failed: 'failed_at' }

const DEFAULT_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 5000

// Rough segment count: any non-ASCII char ⇒ UCS-2 (70/segment), else GSM (160).
function segmentCount(body) {
  if (!body) return 0
  let unicode = false
  for (let i = 0; i < body.length; i++) { if (body.charCodeAt(i) > 127) { unicode = true; break } }
  const per = unicode ? 70 : 160   // UCS-2 (e.g. Cyrillic) vs GSM-7
  return Math.max(1, Math.ceil(body.length / per))
}

const outboxSchema = z.object({
  to: z.string().min(3),
  from: z.string().optional().nullable(),
  body: z.string().optional(),
  template: z.string().optional().nullable(),
  media: z.array(z.string().url()).optional(),
  passport_id: z.string().uuid().optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
}).refine(d => d.body || d.template, { message: 'body or template is required' })

// Dependencies captured once via init() — module-level singletons.
let db, q, templates, passports, sessions, awareness, notify, config, logger
let attempts
export let outboxQueue

export function init(deps) {
  ;({ db, q, templates, passports, sessions, awareness, notify, config, logger } = deps)
  attempts = config.sms?.outbox?.attempts ?? DEFAULT_ATTEMPTS

  outboxQueue = q.createQueue('sms:outbox')

  q.createWorker('sms:outbox', async job => processSingle(job.data.id, job.attemptsMade + 1), {
    limiter: {
      max: config.sms?.outbox?.rate?.max ?? 10,
      duration: config.sms?.outbox?.rate?.duration ?? 1000,
    },
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: config.sms?.outbox?.backoffMs ?? DEFAULT_BACKOFF_MS },
      removeOnComplete: true,
    },
  }).on('failed', async (job, err) => {
    if (!job?.data?.id) return
    const attemptsMade = job.attemptsMade
    const terminal = attemptsMade >= (job.opts.attempts ?? attempts)
    try {
      const row = await failed(job.data.id, { reason: err.message, attempts: attemptsMade, terminal })
      if (terminal && row) await notify('sms.failed', { type: 'sms.failed', data: row })
    } catch (e) {
      logger.error({ err: e }, 'Failed to record sms failure: %s', job.data.id)
    }
  })
}

const defaultCountry = () => config.sms?.defaultCountry

async function buildMessage(row) {
  const session = row.session_id && sessions?.findById
    ? await sessions.findById(row.session_id).catch(() => null)
    : null
  const body = row.body ?? (row.template && templates
    ? await templates.renderText({ layout: row.template, ...row, session, ...(row.data || {}) })
    : null)
  return { to: row.to, from: row.from || null, body, media: row.media || null, segments: segmentCount(body) }
}

async function recordSent(sentRow) {
  await notify('sms.sent', { type: 'sms.sent', data: sentRow })
  if (awareness && sentRow.passport_id) {
    await awareness.record({
      passport_id: sentRow.passport_id,
      session_id: sentRow.session_id,
      ts: sentRow.sent_at,
      channel: 'sms',
      direction: 'exposure',
      source: 'sms',
      content_id: `sms-outbox:${sentRow.id}`,
      text: sentRow.body || '',
      meta: { to: sentRow.to, from: sentRow.from, provider: sentRow.provider, provider_message_id: sentRow.provider_message_id },
    }).catch(err => logger.warn({ err, outboxId: sentRow.id }, 'awareness.record failed'))
  }
}

async function markInvalidIfPermanent(row, errLike, provider) {
  const c = provider?.classifyError?.(errLike) ?? invalid.classifyError(errLike)
  if (c.permanent) {
    await invalid.add({
      phone: row.to,
      reason: 'undeliverable',
      source: provider?.name || 'provider',
      errorMessage: `${c.statusCode ? `[${c.statusCode}] ` : ''}${c.message}`.slice(0, 512),
    }).catch(e => logger.error({ err: e }, 'Failed to record invalid number: %s', row.to))
  }
  return c
}

async function processSingle(id, attemptsMade) {
  const row = await find(id)
  if (!row || row.status !== 'queued') return

  const blockReason = await preflightBlock(row.to)
  if (blockReason) {
    const failedRow = await failed(id, { reason: blockReason, attempts: attemptsMade, terminal: true })
    if (failedRow) await notify('sms.failed', { type: 'sms.failed', data: failedRow })
    return
  }

  try {
    await resolveRecipient(row)
  } catch (err) {
    logger.warn({ err }, 'Failed to identify/link sms recipient: %s', row.to)
  }

  const msg = await buildMessage(row)
  let info
  try {
    info = await sender.send(msg)
  } catch (err) {
    const c = await markInvalidIfPermanent(row, err, sender.providerFor(row.to))
    if (c.permanent) {
      const failedRow = await failed(id, { reason: `rejected:${c.message}`, attempts: attemptsMade, terminal: true })
      if (failedRow) await notify('sms.failed', { type: 'sms.failed', data: failedRow })
      return   // swallow — no retry
    }
    throw err   // transient — let BullMQ retry
  }

  if (!info.messageId) logger.error({ outboxId: id }, 'Provider returned no messageId — DLR/status will not match')
  const sentRow = await sent(id, { providerMessageId: info.messageId, provider: info.provider, segments: msg.segments })
  logger.info(
    { outboxId: id, to: row.to, provider: info.provider, providerMessageId: info.messageId, segments: msg.segments, attempts: attemptsMade },
    'SMS sent: %s via %s', row.to, info.provider,
  )
  await recordSent(sentRow)
}

async function preflightBlock(phone) {
  const inv = await invalid.check(phone).catch(() => null)
  if (inv) return `invalid:${inv.reason}`
  const sup = await suppressions.check(phone).catch(() => null)
  if (sup) return `suppressed:${sup.reason}`
  return null
}

// Resolve an outbox recipient to a passport via the phone identity (reuse the
// existing owner rather than minting a duplicate), persist it on the row.
export async function resolveRecipient(row) {
  const passportId = row.passport_id
    ?? (await passports.findByIdentity('phone', row.to))?.id
    ?? await passports.identify(null)
  if (!passportId || !row.to) return passportId

  await passports.link(passportId, [{ type: 'phone', name: 'e164', value: row.to }]).catch(err => {
    logger.warn({ err }, 'Failed to link sms recipient to passport: %s', row.to)
  })
  if (passportId !== row.passport_id) {
    await db(TABLE).where({ id: row.id }).update({ passport_id: passportId })
    row.passport_id = passportId
  }
  return passportId
}

export async function create({ passportId, sessionId, to, from, body, template, media, data, idempotencyKey, batchId, campaignId, journeyId }) {
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first()
    if (existing) return existing
  }
  try {
    const [row] = await db(TABLE).insert({
      passport_id: passportId || null,
      session_id: sessionId || null,
      to,
      from: from || null,
      body: body || null,
      template: template || null,
      media: media?.length ? media : null,
      data: data || null,
      idempotency_key: idempotencyKey || null,
      batch_id: batchId || null,
      // who asked for it — see migration 005. Set on every path, bulk or not.
      campaign_id: campaignId || null,
      journey_id: journeyId || null,
    }).returning('*')
    return row
  } catch (err) {
    if (idempotencyKey && /unique|duplicate/i.test(err.message)) {
      const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first()
      if (existing) return existing
    }
    throw err
  }
}

export async function createMany(items) {
  if (!items.length) return []
  return await db(TABLE).insert(items.map(item => ({
    passport_id: item.passportId || null,
    session_id: item.sessionId || null,
    to: item.to,
    from: item.from || null,
    body: item.body || null,
    template: item.template || null,
    media: item.media?.length ? item.media : null,
    data: item.data || null,
    batch_id: item.batchId || null,
    campaign_id: item.campaignId || null,
    journey_id: item.journeyId || null,
  }))).returning('*')
}

export async function sent(id, { providerMessageId, provider, segments }) {
  const [row] = await db(TABLE).where({ id }).update({
    provider_message_id: providerMessageId,
    provider: provider || null,
    segments: segments ?? null,
    status: 'sent',
    sent_at: new Date(),
  }).returning('*')
  return row
}

export async function failed(id, { reason, attempts: attemptsMade, terminal }) {
  const trimmed = String(reason).slice(0, 512)
  const entry = `[${new Date().toISOString()}] attempt ${attemptsMade}: ${trimmed}`
  const row = await db(TABLE).where({ id }).first()
  if (!row) return null
  const update = {
    attempts: attemptsMade,
    failure_reason: trimmed,
    failure_log: row.failure_log ? `${row.failure_log}\n${entry}` : entry,
  }
  if (terminal) { update.status = 'failed'; update.failed_at = new Date() }
  const [updated] = await db(TABLE).where({ id }).update(update).returning('*')
  return updated
}

// Advance status from a delivery callback (DLR). Matched by provider_message_id;
// only advances from queued/sent so a delivered/failed row never regresses.
export async function track(providerMessageId, status) {
  if (!providerMessageId) return null
  const targetRank = STATUS_RANK[status]
  if (targetRank == null) return null
  const advanceableFrom = ADVANCEABLE.filter(s => STATUS_RANK[s] < targetRank)
  if (!advanceableFrom.length) return null

  const field = STATUS_AT[status]
  const [updated] = await db(TABLE)
    .where({ provider_message_id: providerMessageId })
    .whereIn('status', advanceableFrom)
    .update({ status, ...(field ? { [field]: new Date() } : {}) })
    .returning('*')
  return updated || null
}

export async function find(id) {
  return await db(TABLE).where({ id }).first()
}

export async function markStuck(thresholdMs = 10 * 60 * 1000) {
  const cutoff = new Date(Date.now() - thresholdMs)
  const stuck = await db(TABLE).where('status', 'queued').where('queued_at', '<', cutoff)
    .update({ status: 'failed', failed_at: new Date(), failure_reason: 'stuck' }).returning('*')
  if (stuck.length) {
    logger.warn({ count: stuck.length }, 'Marked %d stuck sms row(s) as failed', stuck.length)
    for (const row of stuck) await notify('sms.failed', { type: 'sms.failed', data: row }).catch(() => {})
  }
  return stuck.length
}

export async function cancelBatch(batchId) {
  const cancelled = await db(TABLE).where({ batch_id: batchId, status: 'queued' })
    .update({ status: 'cancelled', cancelled_at: new Date(), failure_reason: 'cancelled' }).returning('*')
  if (cancelled.length && typeof outboxQueue.remove === 'function') {
    await Promise.all(cancelled.map(row => outboxQueue.remove(String(row.id)).catch(() => {})))
  }
  return { batch_id: batchId, cancelled: cancelled.length }
}

export async function batchStats(batchId) {
  const rows = await db(TABLE).where({ batch_id: batchId }).select('status').count('* as count').groupBy('status')
  const totals = {}
  for (const r of rows) totals[r.status] = parseInt(r.count, 10)
  return { batch_id: batchId, totals }
}

// The delivery funnel for a scope — the SMS half of a campaign's results
// block. Same reasoning as mail's funnel(): batchStats() above groups by the
// row's LATEST status, so counting the nullable timestamps is what makes the
// stages cumulative. Scoped by attribution only, never by batch — see mail's
// funnel() for why.
//
// There is no `opened` or `clicked` here and there never will be from this
// table — SMS has no open pixel, and a click is only knowable if the body
// carried a shortened link (whitebox_short_clicks), which is a different join.
export async function funnel({ campaignId, journeyId } = {}) {
  if (!campaignId && !journeyId) return { total: 0, sent: 0, delivered: 0, failed: 0, undelivered: 0, cancelled: 0 }
  const [row] = await db(TABLE).where(b => {
    if (campaignId) b.orWhere({ campaign_id: campaignId })
    if (journeyId) b.orWhere({ journey_id: journeyId })
  }).select(
    db.raw(`count(*)::int                                        AS total`),
    db.raw(`count(sent_at)::int                                  AS sent`),
    db.raw(`count(delivered_at)::int                             AS delivered`),
    db.raw(`count(failed_at)::int                                AS failed`),
    db.raw(`count(cancelled_at)::int                             AS cancelled`),
    // carrier accepted it but never delivered — terminal, and distinct from a
    // send failure on our side
    db.raw(`count(*) FILTER (WHERE status = 'undelivered')::int   AS undelivered`),
  )
  return row
}

// Delivery health for a TIME WINDOW rather than one campaign — what the Live
// dashboard's egress card reads. Same columns as funnel() above, and
// deliberately the same shape, so the two can't drift into disagreeing about
// what "delivered" counts.
//
// Windowed on queued_at — this table has no created_at; queued_at IS when the
// row was made. The question is "what did we try to send recently", so a
// message queued inside the window belongs to it even if it hasn't resolved
// yet: that pending gap is exactly what the card is for.
// Self-describing health, for any monitoring surface (see docs/10-plugin-status.md).
// The board used to know this shape; now it doesn't have to — this plugin names
// its own numbers and says which one is bad news, so adding a channel never means
// editing the dashboard.
export async function status({ since } = {}) {
  const s = await stats({ since })
  return {
    label: 'sms',
    metrics: [
      { key: 'queued', value: s.queued,
        description: 'Texts waiting to go out' },
      { key: 'sent', value: s.sent,
        description: 'Texts handed to the phone network' },
      { key: 'delivered', value: s.delivered,
        description: 'Texts confirmed on the phone — not all networks confirm' },
      // non-zero here is a problem, and the surface shows it with an icon and the
      // word — never colour alone
      { key: 'failed', value: s.failed, severity: 'bad',
        description: 'Texts that could not be sent at all' },
      { key: 'bounced', value: s.bounced, severity: 'bad',
        description: 'Texts the phone network rejected — unreachable number' },
    ],
  }
}

export async function stats({ since } = {}) {
  const q = db(TABLE)
  if (since) q.where('queued_at', '>=', since instanceof Date ? since : new Date(since))
  const [row] = await q.select(
    db.raw(`count(*)::int                                          AS total`),
    db.raw(`count(*) FILTER (WHERE status = 'queued')::int         AS queued`),
    db.raw(`count(sent_at)::int                                    AS sent`),
    db.raw(`count(delivered_at)::int                               AS delivered`),
    db.raw(`count(failed_at)::int                                  AS failed`),
    db.raw(`count(*) FILTER (WHERE status = 'bounced')::int        AS bounced`),
  )
  return row
}

// Programmatic send: normalize the recipient, resolve a session, create the row,
// enqueue it. Shared by the HTTP route and the MCP tool. Returns the row, or
// throws { status: 400 } on an unusable phone.
export async function queueSend({ to: rawTo, from, body, template, media, data, passportId, idempotencyKey, campaignId, journeyId }) {
  const to = toE164(rawTo, defaultCountry())
  if (!to) { const e = new Error('invalid phone number'); e.status = 400; throw e }

  const session = await sessions.resolve(passportId || null).catch(() => null)
  const row = await create({
    passportId: passportId || session?.passport_id || null,
    sessionId: session?.id || null,
    to, from, body, template, media, data, idempotencyKey, campaignId, journeyId,
  })

  if (row.status === 'queued' && !row.sent_at) {
    await outboxQueue.add('send', { id: row.id }, { jobId: idempotencyKey || undefined })
    await notify('sms.queued', { type: 'sms.queued', data: row })
  }
  return row
}

export async function outboxSend(req, res) {
  const parsed = outboxSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  try {
    const { passport_id: passportId, from, body, template, media, data } = parsed.data
    const row = await queueSend({ to: parsed.data.to, from, body, template, media, data, passportId, idempotencyKey: req.get('idempotency-key') || null })
    res.json(row)
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    logger.error({ err }, 'Failed to queue sms')
    res.status(500).json({ error: 'Failed to queue sms' })
  }
}
