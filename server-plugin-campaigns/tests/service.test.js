import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as service from '../src/service.js'

function makeRow(overrides = {}) {
  return {
    id: 'camp1', name: 'Test Campaign', channel: 'email', status: 'sent',
    subject: 'Hello', message: { html: '<p>hi</p>' },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeDeps({ row = makeRow(), deliverable = ['p1'], dryRun = false, hasMail = true, hasSms = true } = {}) {
  const store = { getCampaign: vi.fn(async () => row) }
  const audiences = { deliverableCohort: vi.fn(async () => deliverable) }
  const mail = hasMail ? { queueSend: vi.fn(async () => ({ id: 'mail1' })) } : null
  const sms = hasSms ? { queueSend: vi.fn(async () => ({ id: 'sms1' })) } : null
  const passports = { identities: vi.fn(async () => [{ type: 'email', value: 'test@example.com' }, { type: 'phone', value: '+359888123456' }]) }
  const notify = vi.fn()
  service.init({ store, audiences, deliver: null, dryRun, mail, sms, passports, logger: console, notify })
  return { store, audiences, mail, sms, passports, notify }
}

beforeEach(() => vi.clearAllMocks())

describe('activateForPassport', () => {
  it('requires a passport_id', async () => {
    makeDeps()
    await expect(service.activateForPassport('camp1', '')).rejects.toThrow(/passport_id required/)
  })

  it('404s when the campaign does not exist', async () => {
    const store = { getCampaign: vi.fn(async () => null) }
    service.init({ store, audiences: {}, deliver: null, dryRun: true, mail: null, sms: null, passports: {}, logger: console })
    await expect(service.activateForPassport('missing', 'p1')).rejects.toMatchObject({ status: 404 })
  })

  it('400s when the message is not ready for the channel', async () => {
    makeDeps({ row: makeRow({ channel: 'sms', message: {} }) })
    await expect(service.activateForPassport('camp1', 'p1')).rejects.toMatchObject({ status: 400 })
  })

  it('works regardless of bulk status — a draft campaign with a ready message can still activate', async () => {
    const { mail } = makeDeps({ row: makeRow({ status: 'draft' }), dryRun: false })
    const result = await service.activateForPassport('camp1', 'p1', { idempotencyKey: 'k1' })
    expect(result).toEqual({ sent: true, dry_run: false })
    expect(mail.queueSend).toHaveBeenCalled()
  })

  it('returns a soft result (does not throw) when the passport is suppressed or lacks consent', async () => {
    makeDeps({ deliverable: [] })
    const result = await service.activateForPassport('camp1', 'p1')
    expect(result).toEqual({ sent: false, reason: 'suppressed_or_no_consent' })
  })

  it('dry-run short-circuits before ever calling mail/sms, but still notifies campaigns.activated', async () => {
    const { mail, sms, notify } = makeDeps({ dryRun: true })
    const result = await service.activateForPassport('camp1', 'p1')
    expect(result).toEqual({ sent: true, dry_run: true })
    expect(mail.queueSend).not.toHaveBeenCalled()
    expect(sms.queueSend).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('campaigns.activated', {
      type: 'campaigns.activated', data: { campaign_id: 'camp1', passport_id: 'p1', channel: 'email', dry_run: true },
    })
  })

  it('live + email channel calls mail.queueSend with the resolved contact, subject, html, and idempotencyKey, and notifies campaigns.activated', async () => {
    const { mail, notify } = makeDeps({ row: makeRow({ channel: 'email' }), dryRun: false })
    await service.activateForPassport('camp1', 'p1', { idempotencyKey: 'journey.enr1.a' })
    expect(mail.queueSend).toHaveBeenCalledWith({
      to: 'test@example.com', subject: 'Hello', html: '<p>hi</p>', passportId: 'p1', idempotencyKey: 'journey.enr1.a',
      campaignId: 'camp1', journeyId: null,
    })
    expect(notify).toHaveBeenCalledWith('campaigns.activated', {
      type: 'campaigns.activated', data: { campaign_id: 'camp1', passport_id: 'p1', channel: 'email', dry_run: false },
    })
  })

  it('live + sms channel calls sms.queueSend with the resolved contact, body, and idempotencyKey', async () => {
    const { sms } = makeDeps({ row: makeRow({ channel: 'sms', message: { text: 'hi there' } }), dryRun: false })
    await service.activateForPassport('camp1', 'p1', { idempotencyKey: 'journey.enr1.a' })
    expect(sms.queueSend).toHaveBeenCalledWith({
      to: '+359888123456', body: 'hi there', passportId: 'p1', idempotencyKey: 'journey.enr1.a',
      campaignId: 'camp1', journeyId: null,
    })
  })

  it('returns a soft result when the passport has no contact for the channel', async () => {
    const store = { getCampaign: vi.fn(async () => makeRow()) }
    const audiences = { deliverableCohort: vi.fn(async () => ['p1']) }
    const passports = { identities: vi.fn(async () => []) }
    const mail = { queueSend: vi.fn(async () => {}) }
    service.init({ store, audiences, deliver: null, dryRun: false, mail, sms: null, passports, logger: console })
    const result = await service.activateForPassport('camp1', 'p1')
    expect(result).toEqual({ sent: false, reason: 'no_contact' })
    expect(mail.queueSend).not.toHaveBeenCalled()
  })
})

describe('sendManual', () => {
  function makeManualDeps({ row = makeRow({ status: 'draft' }), audienceIds = ['aud1'], resolveIds = ['p1', 'p2'], dryRun = true, deliver = null } = {}) {
    const updates = []
    const store = {
      getCampaign: vi.fn(async () => row),
      audienceIds: vi.fn(async () => audienceIds),
      updateCampaign: vi.fn(async (id, fields) => { updates.push(fields); return { ...row, ...fields } }),
    }
    const audiences = {
      resolveAudience: vi.fn(async () => ({ ids: resolveIds })),
      previewCohort: vi.fn(async (ids) => ({ resolved: ids.length, suppressed: 0, no_consent: 0, deliverable: ids.length })),
      deliverableCohort: vi.fn(async (ids) => ids),
    }
    const notify = vi.fn()
    service.init({ store, audiences, deliver, dryRun, mail: null, sms: null, passports: {}, logger: console, notify })
    return { store, audiences, updates, notify }
  }

  it('409s when the campaign is already locked (scheduled or sent)', async () => {
    makeManualDeps({ row: makeRow({ status: 'sent' }) })
    await expect(service.sendManual('camp1')).rejects.toMatchObject({ status: 409 })
  })

  it('400s when the message is not ready for the channel', async () => {
    makeManualDeps({ row: makeRow({ status: 'draft', channel: 'sms', message: {} }) })
    await expect(service.sendManual('camp1')).rejects.toMatchObject({ status: 400 })
  })

  it('400s when no audience is attached', async () => {
    makeManualDeps({ audienceIds: [] })
    await expect(service.sendManual('camp1')).rejects.toMatchObject({ status: 400 })
  })

  it('delivers and stamps stats, but does NOT lock — status stays whatever it already was', async () => {
    const { store } = makeManualDeps({ dryRun: true })
    const row = await service.sendManual('camp1')
    expect(row.status).toBe('draft')
    expect(row.sent_at).toBeUndefined()
    expect(store.updateCampaign).toHaveBeenCalledWith('camp1', { stats: expect.stringContaining('"dry_run":true') })
  })

  it('is repeatable — calling it again on the same (still-unlocked) campaign succeeds', async () => {
    makeManualDeps({ dryRun: true })
    await service.sendManual('camp1')
    await expect(service.sendManual('camp1')).resolves.toMatchObject({ status: 'draft' })
  })

  it('reuses caller-supplied counts instead of re-resolving the audience union', async () => {
    const { audiences } = makeManualDeps({ dryRun: true })
    await service.sendManual('camp1', { counts: { resolved: 5, suppressed: 0, no_consent: 0, deliverable: 5 } })
    expect(audiences.previewCohort).not.toHaveBeenCalled()
  })

  it('dry-run does not notify campaigns.sent — nothing was actually delivered', async () => {
    const { notify } = makeManualDeps({ dryRun: true })
    await service.sendManual('camp1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('live delivery notifies campaigns.sent with the stamped stats', async () => {
    const deliver = vi.fn(async () => ({ batch_id: 'batch1' }))
    const { notify } = makeManualDeps({ dryRun: false, deliver, resolveIds: ['p1', 'p2'] })
    await service.sendManual('camp1')
    expect(notify).toHaveBeenCalledWith('campaigns.sent', {
      type: 'campaigns.sent',
      data: { campaign_id: 'camp1', channel: 'email', resolved: 2, suppressed: 0, no_consent: 0, sent: 2, batch_id: 'batch1', dry_run: false },
    })
  })
})

// A campaign resolves its recipients through the audiences plugin on every
// send path, so a deployment without it can build campaigns that can never go
// out. Refusing to register is also what keeps campaigns:* out of the
// permission catalog, which is what hides the module in the UI.
describe('register — audiences is a hard dependency', () => {
  const factory = async (overrides = {}) => {
    const { campaigns } = await import('../src/index.js')
    return campaigns({ auth: { secret: 'x' }, ...overrides })
  }
  const fakeCtx = (plugins = {}) => ({
    db: {}, plugins, logger: { warn: vi.fn(), info: vi.fn(), child: () => ({ warn: vi.fn(), info: vi.fn() }) },
    events: {}, webhooks: {}, eventRegistry: {}, passports: {},
  })

  it('throws when the audiences plugin is not registered', async () => {
    const plugin = await factory()
    await expect(plugin.register({ use: vi.fn() }, fakeCtx({})))
      .rejects.toThrow(/audiences plugin is required/)
  })

  it('names the fix in the error', async () => {
    const plugin = await factory()
    await expect(plugin.register({ use: vi.fn() }, fakeCtx({})))
      .rejects.toThrow(/register it before campaigns/)
  })
})


// docs/10-plugin-status.md — the plugin names its own numbers and says which one
// is bad news; the monitoring board holds no campaigns knowledge.
describe('status', () => {
  const COUNTS = { sent: 4, dry_run: 4, scheduled: 2, draft: 7, overdue: 0 }

  function setup({ counts = COUNTS, dryRun = true } = {}) {
    const store = { healthCounts: vi.fn(async () => { if (counts instanceof Error) throw counts; return counts }) }
    service.init({ store, audiences: {}, deliver: null, dryRun, mail: null, sms: null, passports: {}, logger: { warn: vi.fn() } })
    return store
  }
  const at = (s, key) => s.metrics.find(m => m.key === key)

  it('reports the windowed sends beside the current draft/scheduled state', async () => {
    setup()
    const s = await service.status({ since: new Date('2026-07-30T00:00:00.000Z') })
    expect(s.label).toBe('campaigns')
    expect(s.metrics.map(m => m.key)).toEqual(['sent', 'dry run', 'scheduled', 'drafts', 'overdue'])
    expect(at(s, 'sent').value).toBe(4)
    expect(at(s, 'scheduled').value).toBe(2)
    expect(at(s, 'drafts').value).toBe(7)
  })

  // The split the board renders on. `sent`/`dry run` FILTER on sent_at >= since;
  // the other three count by `status`, which has no timestamp, so widening the
  // window cannot move them. Unmarked they'd read as windowed counts that happen
  // to be small — asserted exactly, because a wrong flag is invisible in the UI.
  it('marks the status-derived counts live and leaves the windowed ones unmarked', async () => {
    setup()
    const s = await service.status({ since: new Date() })
    expect(s.metrics.filter(m => m.live).map(m => m.key)).toEqual(['scheduled', 'drafts', 'overdue'])
    expect(s.metrics.filter(m => !m.live).map(m => m.key)).toEqual(['sent', 'dry run'])
  })

  // dryRun defaults ON, so on a deployment that hasn't gone live EVERY send is a
  // dry run. Flagging that would paint the card red for a system doing exactly
  // what it was configured to do.
  it('does not mark dry runs bad — only an overdue schedule is', async () => {
    setup({ counts: { ...COUNTS, dry_run: 4, overdue: 3 } })
    const s = await service.status({ since: new Date() })
    expect(at(s, 'dry run').severity).toBeUndefined()
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['overdue'])
  })

  it('passes `since` through to the counts, and defaults to the whole history without one', async () => {
    const since = new Date('2026-07-30T00:00:00.000Z')
    let store = setup()
    await service.status({ since })
    expect(store.healthCounts).toHaveBeenCalledWith(since)
    store = setup()
    await service.status()
    expect(store.healthCounts).toHaveBeenCalledWith(new Date(0))
  })

  // Nothing in this plugin sends a campaign committed for a future time, so a
  // past-due 'scheduled' row is one that will never go out.
  it('leads the note with the overdue schedule, which outranks the dry-run mode', async () => {
    setup({ counts: { ...COUNTS, overdue: 1 }, dryRun: true })
    expect((await service.status({ since: new Date() })).note)
      .toMatch(/1 campaign past its send time and still scheduled/)
  })

  it('explains the dry-run mode when nothing is overdue, and says nothing when live and clean', async () => {
    setup({ dryRun: true })
    expect((await service.status({ since: new Date() })).note).toMatch(/dry-run/)
    setup({ dryRun: false })
    expect((await service.status({ since: new Date() })).note).toBeNull()
  })

  // A failing status() must not take the board down — and must not report zeros
  // either, since a zero reads as "nothing happened" rather than "no idea".
  it('survives a failing read without throwing, and reports no metrics rather than zeros', async () => {
    setup({ counts: new Error('db down') })
    const s = await service.status({ since: new Date() })
    expect(s.metrics).toEqual([])
    expect(s.note).toMatch(/could not be read/)
  })
})

describe('getResults', () => {
  const ZERO = { total: 0, sent: 0, delivered: 0 }
  // sends: [{ dry_run, channel, batch_id, resolved, deliverable, suppressed, no_consent }]
  function withSends(sends, { mailFunnel, smsFunnel } = {}) {
    const store = {
      getCampaign: vi.fn(async () => makeRow()),
      listSends: vi.fn(async () => sends.map((s, i) => ({
        id: `s${i}`, campaign_id: 'camp1', status: 'sent', sent_at: new Date().toISOString(),
        resolved: 0, deliverable: 0, suppressed: 0, no_consent: 0, dry_run: false, ...s,
      }))),
    }
    // default: the channel has nothing for this campaign, so it drops out
    const mail = mailFunnel === null ? {} : { funnel: vi.fn(mailFunnel ?? (async () => ({ ...ZERO }))) }
    const sms = smsFunnel === null ? {} : { funnel: vi.fn(smsFunnel ?? (async () => ({ ...ZERO }))) }
    service.init({ store, audiences: {}, deliver: null, dryRun: false, mail, sms, passports: {}, logger: console })
    return { store, mail, sms }
  }

  it('sums pre-flight reach across runs and asks the channel once, by campaign', async () => {
    const { mail } = withSends([
      { channel: 'email', batch_id: 'b1', resolved: 10, deliverable: 8, suppressed: 1, no_consent: 1 },
      { channel: 'email', batch_id: 'b2', resolved: 5, deliverable: 5, suppressed: 0, no_consent: 0 },
    ], { mailFunnel: async () => ({ total: 13, sent: 13, delivered: 12 }) })
    const r = await service.getResults('camp1')
    expect(r.reach).toEqual({ resolved: 15, deliverable: 13, suppressed: 1, no_consent: 1 })
    expect(mail.funnel).toHaveBeenCalledTimes(1)
    expect(mail.funnel).toHaveBeenCalledWith({ campaignId: 'camp1' })
    expect(r.delivery.email.delivered).toBe(12)
    expect(r.runs).toHaveLength(2)
  })

  // a dry run stamps a send row for the audit trail, but nothing left the
  // building — counting it would report reach that never existed
  it('ignores dry runs in reach — nothing left the building', async () => {
    const { mail } = withSends([
      { channel: 'email', batch_id: 'b1', resolved: 10, deliverable: 10, dry_run: true },
    ])
    const r = await service.getResults('camp1')
    expect(r.runs).toEqual([])
    expect(r.reach.resolved).toBe(0)
    expect(r.delivery).toEqual({})      // nothing came back, so no channel shown
  })

  // the campaign's own channel is no guide: a journey can activate it
  // per-passport (no run row at all), and its channel is editable after a send
  it('asks BOTH channels and keeps whichever actually has rows', async () => {
    const { mail, sms } = withSends([{ channel: 'email', batch_id: 'b1' }], {
      smsFunnel: async () => ({ total: 4, sent: 4, delivered: 3 }),
    })
    const r = await service.getResults('camp1')
    expect(mail.funnel).toHaveBeenCalledWith({ campaignId: 'camp1' })
    expect(sms.funnel).toHaveBeenCalledWith({ campaignId: 'camp1' })
    expect(Object.keys(r.delivery)).toEqual(['sms'])   // email returned 0 rows
  })

  // the whole point of migration 015: a journey-triggered send has no run row
  // and no batch, and must still be reported
  it('reports sends that exist only by attribution, with no send run behind them', async () => {
    withSends([], { mailFunnel: async () => ({ total: 3, sent: 3, delivered: 3, opened: 1 }) })
    const r = await service.getResults('camp1')
    expect(r.runs).toEqual([])
    expect(r.delivery.email).toMatchObject({ sent: 3, opened: 1 })
  })

  it('reports a channel as unavailable instead of throwing when its plugin is not wired', async () => {
    withSends([{ channel: 'email', batch_id: 'b1' }], { mailFunnel: null })
    const r = await service.getResults('camp1')
    expect(r.delivery.email.unavailable).toMatch(/not wired/)
  })

  it('survives a channel plugin that throws', async () => {
    withSends([{ channel: 'email', batch_id: 'b1' }], { mailFunnel: async () => { throw new Error('db down') } })
    const r = await service.getResults('camp1')
    expect(r.delivery.email.unavailable).toBe('db down')
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md) — the guard that
// stops the next metric shipping as a bare key.
describe('status descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    const store = { healthCounts: vi.fn(async () => ({ sent: 4, dry_run: 4, scheduled: 2, draft: 7, overdue: 1 })) }
    service.init({ store, audiences: {}, deliver: null, dryRun: true, mail: null, sms: null, passports: {}, logger: { warn: vi.fn() } })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) expect(m.description.length).toBeGreaterThan(m.key.length + 20)
  })
})
