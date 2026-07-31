import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as service from '../src/service.js'
import * as classify from '../src/classify.js'
import { init as describeInit } from '../src/describe.js'
import { catalog } from './catalog.js'

// Classification is declared by the plugins that emit the events and aggregated
// by core (server/src/event-catalog.js); live is handed the result. Every test
// below reads it, so install it once — see catalog.js for why it's a fixture and
// not an import of the real plugins.
beforeEach(() => {
  const eventCatalog = catalog()
  classify.init({ eventCatalog })
  describeInit({ eventCatalog })
})

const registry = (counts = [], active = 0, series = []) => ({
  countsByType: vi.fn(async () => counts),
  activePassports: vi.fn(async () => active),
  series: vi.fn(async () => series),
  recent: vi.fn(async () => []),
})

describe('summary()', () => {
  it('folds type counts into directions and channels, and rates per minute', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'mail.sent', count: 60 },
        { type: 'crm.deal', count: 30 },
        { type: 'journey.enrolled', count: 10 },
      ], 7),
      mail: { stats: vi.fn(async () => ({ total: 60, failed: 3 })) },
      sms: null, logger: console,
    })

    const s = await service.summary({ window: '30m' })
    expect(s.by_direction).toMatchObject({ out: 60, in: 30, internal: 10 })
    expect(s.by_channel).toMatchObject({ mail: 60, crm: 30, journey: 10 })
    expect(s.total).toBe(100)
    // 100 events over 1800s = 3.3/min — normalised per MINUTE whatever the
    // window, so the headline means the same thing on every setting
    expect(s.per_minute).toBeCloseTo(3.3, 1)
    expect(s.active_passports).toBe(7)
  })

  // The bug this guards: awareness.recorded is ONE type covering both inbound
  // and outbound touches, told apart only by the direction its producer
  // recorded. While the registry grouped by type alone, that field was thrown
  // away by the GROUP BY, every awareness event landed in `unknown`, and the
  // "coming in / going out" cards read empty while the feed beside them
  // correctly showed the very same events as inbound.
  it('splits one awareness type across directions using the recorded facet', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'awareness.recorded', count: 40, recorded_direction: 'observation', recorded_channel: 'crm' },
        { type: 'awareness.recorded', count: 25, recorded_direction: 'exposure', recorded_channel: 'mail' },
        { type: 'awareness.recorded', count: 5, recorded_direction: 'expression', recorded_channel: 'web' },
      ], 3),
      mail: null, sms: null, logger: console,
    })

    const s = await service.summary({ window: '30m' })
    // observation + expression are inbound, exposure is outbound
    expect(s.by_direction).toMatchObject({ in: 45, out: 25, unknown: 0 })
    // and the channel comes from the payload too, not from the type prefix —
    // otherwise all 70 would be filed under a meaningless "awareness"
    expect(s.by_channel).toMatchObject({ crm: 40, mail: 25, web: 5 })
    expect(s.by_channel.awareness).toBeUndefined()
    expect(s.total).toBe(70)
  })

  it('still classifies by type alone when a row carries no recorded facet', async () => {
    // Forward compatibility in reverse: an older core returns {type, count}
    // only, and that must keep working rather than throwing on a missing column.
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 4 }], 0),
      mail: null, sms: null, logger: console,
    })
    const s = await service.summary({})
    expect(s.by_direction).toMatchObject({ out: 4 })
    expect(s.by_channel).toMatchObject({ mail: 4 })
  })

  it('omits a plugin that cannot describe itself, rather than inventing zeros', async () => {
    // ABSENT and ZERO are different claims: absent means "nobody is watching
    // this", zero means "nothing happened". Rendering the first as the second is
    // how a channel nobody monitors looks healthy.
    service.init({ eventRegistry: registry(), plugins: { mail: { service: {} } }, logger: console })
    const s = await service.summary({})
    expect(s.status).toEqual([])
  })

  it('drops a plugin whose status() throws instead of failing the whole board', async () => {
    service.init({
      eventRegistry: registry(),
      plugins: { mail: { service: { status: async () => { throw new Error('db down') } } } },
      logger: console,
    })
    const s = await service.summary({})
    expect(s.status).toEqual([])
  })

  it('falls back to a known window rather than trusting the query string', async () => {
    service.init({ eventRegistry: registry(), logger: console })
    expect((await service.summary({ window: '99y' })).window).toBe('30m')
    expect((await service.summary({ window: '5m' })).window_seconds).toBe(300)
  })
})

describe('toFeedRow()', () => {
  // the backfill and the live stream both go through this, so a replayed event
  // and a streamed one are indistinguishable to the UI
  it('produces one shape from a registry row', () => {
    const r = service.toFeedRow({
      id: 'e1', type: 'awareness.recorded', occurred_at: '2026-01-01T00:00:00.000Z',
      passport_id: 'p1', data: { data: { direction: 'expression', channel: 'web' } },
    })
    expect(r).toMatchObject({ id: 'e1', type: 'awareness.recorded', direction: 'in', channel: 'web', passport_id: 'p1' })
  })

  // `detail` was NOT asserted here for a long time, which is how a blank detail
  // column went unnoticed for two whole event families — this is the one field the
  // row exists to carry beyond the type name.
  it('carries the detail the emitting module declared', () => {
    const r = service.toFeedRow({
      id: 'e2', type: 'mail.sent', occurred_at: '2026-01-01T00:00:00.000Z',
      data: { data: { to: 'someone@example.com' } },
    })
    expect(r.detail).toBe('someone@example.com')
  })

  it('carries null detail rather than omitting the field, when nobody declared one', () => {
    const r = service.toFeedRow({
      id: 'e3', type: 'campaigns.sent', occurred_at: '2026-01-01T00:00:00.000Z', data: { data: {} },
    })
    expect(r).toHaveProperty('detail', null)
  })
})

describe('timeseries()', () => {
  // The strip is a fixed-width flex row of one bar per bucket, so a window that
  // only returns the buckets that HAD events draws a few enormous bars instead
  // of a mostly-empty strip with a few blips — reading as heavy traffic when
  // almost nothing happened.
  it('zero-fills the whole window, not just buckets that had events', async () => {
    const now = Date.now()
    const bucketOf = (minsAgo) => new Date(Math.floor((now - minsAgo * 60_000) / 1000 / 60) * 1000 * 60).toISOString()
    service.init({
      eventRegistry: registry([], 0, [
        { bucket: bucketOf(1), type: 'crm.note', count: 2 },
        { bucket: bucketOf(10), type: 'mail.sent', count: 1 },
      ]),
      logger: console,
    })

    const t = await service.timeseries({ window: '30m' })
    // 30m / 15s = 120 buckets — dense enough to read as a chart
    expect(t.bucket_seconds).toBe(15)
    expect(t.buckets.length).toBeGreaterThanOrEqual(115)
    // chronological, and the quiet ones are real zeros
    const stamps = t.buckets.map(b => b.bucket)
    expect([...stamps].sort()).toEqual(stamps)
    expect(t.buckets.filter(b => b.in + b.out + b.internal + b.unknown === 0).length).toBeGreaterThan(100)
    // the events still land, in the right direction
    expect(t.buckets.reduce((a, b) => a + b.in, 0)).toBe(2)
    expect(t.buckets.reduce((a, b) => a + b.out, 0)).toBe(1)
  })
})

describe('timeseries() resolution follows the caller', () => {
  const seriesReg = () => registry([], 0, [])

  it('picks a finer bucket when the client can draw more bars', async () => {
    service.init({ eventRegistry: seriesReg(), logger: console })
    const narrow = await service.timeseries({ window: '30m', points: 30 })
    const wide = await service.timeseries({ window: '30m', points: 200 })
    // same 30 minutes, different resolution — that's the whole point
    expect(narrow.bucket_seconds).toBeGreaterThan(wide.bucket_seconds)
    expect(narrow.buckets.length).toBeLessThanOrEqual(31)
    expect(wide.buckets.length).toBeGreaterThan(narrow.buckets.length)
  })

  it('never returns more bars than asked for', async () => {
    service.init({ eventRegistry: seriesReg(), logger: console })
    for (const points of [20, 50, 120, 300]) {
      const t = await service.timeseries({ window: '24h', points })
      // +1 for the inclusive final bucket
      expect(t.buckets.length).toBeLessThanOrEqual(points + 1)
    }
  })

  it('clamps a hostile or absent points value instead of trusting it', async () => {
    service.init({ eventRegistry: seriesReg(), logger: console })
    // a query string can say anything; this sizes a table scan
    const huge = await service.timeseries({ window: '24h', points: 100000 })
    expect(huge.buckets.length).toBeLessThanOrEqual(601)
    const zero = await service.timeseries({ window: '30m', points: 0 })
    expect(zero.buckets.length).toBeGreaterThan(1)
    const junk = await service.timeseries({ window: '30m', points: 'abc' })
    expect(junk.buckets.length).toBeGreaterThan(1)
  })
})

describe('content()', () => {
  const reg = (rows) => ({
    countsByType: vi.fn(async () => []),
    activePassports: vi.fn(async () => 0),
    series: vi.fn(async () => []),
    recent: vi.fn(async () => []),
    countsByPayloadField: vi.fn(async () => rows),
  })

  // `source` is not a content-kind enum: engagement writes 'video', conversions
  // writes 'conversion', CRM writes its own account name. Grouping unfiltered
  // titled a "Content consumed" card with plugin names.
  it('keeps only real content kinds, not every plugin that writes a source', async () => {
    service.init({
      eventRegistry: reg([
        { value: 'conversion', count: 6 },
        { value: 'video', count: 4 },
        { value: 'live-smoke-test', count: 2 },
        { value: 'text', count: 9 },
        { value: 'image', count: 1 },
      ]),
      logger: console,
    })
    const c = await service.content({ window: '24h' })
    expect(c.kinds.map(k => k.value).sort()).toEqual(['image', 'text', 'video'])
    expect(c.total).toBe(14)   // 4 + 9 + 1 — the producer names excluded
  })

  it('degrades to an empty card on an older core rather than throwing', async () => {
    const older = reg([]); delete older.countsByPayloadField
    service.init({ eventRegistry: older, logger: console })
    await expect(service.content({})).resolves.toMatchObject({ kinds: [], total: 0 })
  })
})

describe('summary() types list', () => {
  // The facet grouping (type + recorded direction/channel) is what lets the
  // direction cards classify awareness correctly — but it also made
  // awareness.recorded appear as several rows in "Top event types", each with a
  // partial count and a duplicate :key.
  it('reports one row per type, summed, biggest first', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'awareness.recorded', count: 7, recorded_direction: 'exposure', recorded_channel: 'web' },
        { type: 'awareness.recorded', count: 4, recorded_direction: 'observation', recorded_channel: 'crm' },
        { type: 'adnetwork.accepted', count: 14 },
        { type: 'conversion.view_content', count: 7 },
      ], 0),
      mail: null, sms: null, logger: console,
    })

    const s = await service.summary({ window: '30m' })
    expect(s.types).toEqual([
      { type: 'adnetwork.accepted', count: 14 },
      { type: 'awareness.recorded', count: 11 },
      { type: 'conversion.view_content', count: 7 },
    ])
    // and the direction folding still sees the facets it needs
    expect(s.by_direction).toMatchObject({ out: 21, in: 11 })
  })
})

describe('summary() status — collected from whoever can describe themselves', () => {
  // The board used to name mail/sms/voip and know each one's field names, so a new
  // channel meant editing this file AND the UI. Now any plugin exposing status()
  // appears and none has to be announced (docs/10-plugin-status.md).
  const plugin = (label, metrics, note = null) => ({
    service: { status: async () => ({ label, metrics, note }) },
  })

  it('passes through metrics and notes verbatim, in config order', async () => {
    service.init({
      eventRegistry: registry([], 0),
      plugins: {
        mail: plugin('mail', [{ key: 'sent', value: 3 }, { key: 'failed', value: 1, severity: 'bad' }]),
        voip: plugin('voip',
          [{ key: 'ringing', value: 1 }, { key: 'web', value: 3, of: 8, live: true }],
          '1 visitor waiting for a number'),
      },
      logger: console,
    })

    const s = await service.summary({})
    expect(s.status.map(p => p.module)).toEqual(['mail', 'voip'])
    expect(s.status[0].metrics).toEqual([
      { key: 'sent', value: 3 }, { key: 'failed', value: 1, severity: 'bad' },
    ])
    expect(s.status[1].metrics).toEqual([
      { key: 'ringing', value: 1 }, { key: 'web', value: 3, of: 8, live: true },
    ])
    expect(s.status[1].note).toBe('1 visitor waiting for a number')
  })

  // A plugin that THREW is broken; one with no status() is merely unmonitored.
  // Both are absent from `status`, and collapsing them would either hide a break
  // or cry wolf over an inventory gap.
  it('separates a plugin that failed from one that never reports', async () => {
    service.init({
      eventRegistry: registry([], 0),
      plugins: {
        mail: plugin('mail', [{ key: 'sent', value: 1 }]),
        crm: { service: { status: async () => { throw new Error('db down') } } },
        analytics: { service: {} },                 // registered, nothing to say
        live: { service: {} },                      // an observer — never listed
        'console-events': { service: {} },          // ditto
      },
      logger: console,
    })

    const s = await service.summary({})
    expect(s.status.map(p => p.module)).toEqual(['mail'])
    expect(s.status_failing).toEqual(['crm'])
    // analytics is named; the two observers are not
    expect(s.status_silent).toEqual(['analytics'])
  })

  // The blind spot this closes: core populates ctx.plugins only `if (api)`, so a
  // plugin returning nothing from register() is absent from it — and was
  // therefore missing from BOTH lists, which is exactly what the silent list is
  // supposed to prevent. The registered NAMES are the only complete source.
  it('names a registered plugin that returned no service at all', async () => {
    service.init({
      eventRegistry: registry([], 0),
      // `geolocation` registered but returned nothing, so it never reaches ctx.plugins
      plugins: { mail: plugin('mail', [{ key: 'sent', value: 1 }]) },
      pluginNames: ['mail', 'geolocation', 'analytics', 'live'],
      logger: console,
    })

    const s = await service.summary({})
    expect(s.status.map(p => p.module)).toEqual(['mail'])
    // both are named despite never appearing in ctx.plugins; `live` is an observer
    expect(s.status_silent).toEqual(['geolocation', 'analytics'])
  })

  it('needs no per-plugin knowledge — an unknown plugin renders like any other', async () => {
    // The point of the contract: a channel this file has never heard of works.
    service.init({
      eventRegistry: registry([], 0),
      plugins: { carrier_pigeon: plugin('pigeons', [{ key: 'dispatched', value: 4 }]) },
      logger: console,
    })
    const s = await service.summary({})
    expect(s.status).toEqual([
      { module: 'carrier_pigeon', label: 'pigeons', metrics: [{ key: 'dispatched', value: 4 }], note: null },
    ])
  })

  it('defaults label to the module name and normalises missing fields', async () => {
    service.init({
      eventRegistry: registry([], 0),
      plugins: { sms: { service: { status: async () => ({ metrics: [{ key: 'sent', value: 1 }] }) } } },
      logger: console,
    })
    const [row] = (await service.summary({})).status
    expect(row).toMatchObject({ module: 'sms', label: 'sms', metrics: [{ key: 'sent', value: 1 }], note: null })
  })

  // ctx.plugins accumulates as plugins register (server/src/plugins.js), and this
  // reads it per REQUEST — so a plugin registered after live still appears, which
  // is what removed live's ordering constraint.
  it('sees a plugin added to ctx.plugins after init', async () => {
    const plugins = {}
    service.init({ eventRegistry: registry([], 0), plugins, logger: console })
    expect((await service.summary({})).status).toEqual([])

    plugins.late = plugin('late', [{ key: 'ok', value: 1 }])
    expect((await service.summary({})).status.map(p => p.module)).toEqual(['late'])
  })
})

// The plugin's own pipeline. This is the gap that made the monitoring plugin the
// one thing the board couldn't report on — and a dead firehose is the failure that
// looks exactly like a quiet system.
describe('status() — live reporting on itself', () => {
  const stats = (over = {}) => () => ({ received: 0, overCeiling: 0, unwatched: 0, subscribers: 0, bootedAt: Date.now() - 3600_000, ...over })

  // live's row carries BOTH kinds of number, which no other plugin's does: the
  // traffic aggregates are windowed, the pipeline counters are process-lifetime.
  it('reports the windowed traffic aggregates and the current-state pipeline', async () => {
    service.init({ eventRegistry: registry([], 0), plugins: {}, logger: console, streamStats: stats({ received: 412, subscribers: 2 }) })
    const s = await service.status({ since: new Date() })
    expect(s.label).toBe('live')
    expect(s.metrics.map(m => m.key)).toEqual([
      'events/min', 'in', 'out', 'internal', 'people active',
      'dashboards', 'streamed', 'dropped',
    ])
    expect(s.metrics.filter(m => m.live).map(m => m.key)).toEqual(['dashboards', 'streamed', 'dropped'])
    expect(s.metrics.filter(m => !m.live).map(m => m.key))
      .toEqual(['events/min', 'in', 'out', 'internal', 'people active'])
    expect(s.note).toBeNull()
  })

  it('folds the registry counts into directions, exactly as the header does', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'mail.sent', count: 60 },
        { type: 'crm.deal', count: 30 },
        { type: 'journey.enrolled', count: 10 },
      ], 7),
      plugins: {}, logger: console, streamStats: stats({ received: 100 }),
    })
    const s = await service.status({ since: new Date(Date.now() - 1800_000) })
    const at = k => s.metrics.find(m => m.key === k).value
    expect(at('out')).toBe(60)
    expect(at('in')).toBe(30)
    expect(at('internal')).toBe(10)
    expect(at('people active')).toBe(7)
    // 100 events over 1800s, per MINUTE whatever the window
    expect(at('events/min')).toBeCloseTo(3.3, 1)
  })

  // The rate is derived from `since`, not from a window name — reporting a 24h
  // total at the default 30m divisor would overstate it 48x.
  it('rates per minute against the window it was actually given', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 1440 }], 0),
      plugins: {}, logger: console, streamStats: stats({ received: 1440 }),
    })
    const s = await service.status({ since: new Date(Date.now() - 24 * 3600_000) })
    // 1440 over 24h = 1/min, not the 48/min a hard-coded 30m divisor would give
    expect(s.metrics.find(m => m.key === 'events/min').value).toBeCloseTo(1, 1)
  })

  // The reason this status() is worth having. notify() writes down two independent
  // paths; if the Redis half dies the registry keeps filling and the feed goes
  // silent, which is indistinguishable from nothing happening.
  it('calls out a dead firehose when the registry recorded events and the stream never has', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 40 }], 0),
      plugins: {}, logger: console,
      // booted an hour ago, window is the last minute — so the whole window is
      // after boot and the two numbers ARE comparable
      streamStats: stats({ received: 0, bootedAt: Date.now() - 3600_000 }),
    })
    const s = await service.status({ since: new Date(Date.now() - 60_000) })
    expect(s.note).toMatch(/Redis subscription is probably dead/)
  })

  // The false alarm this guard exists for, found on the running board: a restart
  // leaves the log holding events the stream was never going to see, so the naive
  // comparison claimed a dead subscription on a perfectly healthy system. An alarm
  // that fires on every deploy gets learned as noise.
  it('stays quiet when the window predates boot, rather than blaming Redis for a restart', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 40 }], 0),
      plugins: {}, logger: console,
      streamStats: stats({ received: 0, bootedAt: Date.now() - 5_000 }),   // booted 5s ago
    })
    const s = await service.status({ since: new Date(Date.now() - 1800_000) })   // 30m window
    expect(s.note).toBeNull()
  })

  // Only the zero case is decidable: `received` is since-boot while the registry
  // count is windowed, so the two numbers are not comparable.
  it('stays quiet when the stream has received anything at all', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 40 }], 0),
      plugins: {}, logger: console, streamStats: stats({ received: 1 }),
    })
    expect((await service.status({ since: new Date() })).note).toBeNull()
  })

  it('reports drops at the flush ceiling ahead of anything else', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 40 }], 0),
      plugins: {}, logger: console, streamStats: stats({ received: 0, overCeiling: 7 }),
    })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'dropped').value).toBe(7)
    expect(s.note).toMatch(/7 events discarded/)
  })

  // "There is no stream" and "the stream carried nothing" have different fixes.
  it('distinguishes no stream at all from an idle one', async () => {
    service.init({ eventRegistry: registry([], 0), plugins: {}, logger: console, streamStats: () => null })
    const s = await service.status({})
    expect(s.metrics.map(m => { const { description, ...rest } = m; return rest }))
      .toEqual([{ key: 'streaming', value: 0, severity: 'bad', live: true }])
    expect(s.note).toMatch(/not streaming/)
  })

  it('does not throw when the registry read fails mid-cross-check', async () => {
    const reg = registry([], 0)
    reg.countsByType = vi.fn(async () => { throw new Error('db down') })
    service.init({ eventRegistry: reg, plugins: {}, logger: { warn: vi.fn() }, streamStats: stats({ received: 3 }) })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'streamed').value).toBe(3)
  })

  // It has to reach the card through the same discovery path as everyone else.
  it('appears in summary().status like any other plugin, not as a special case', async () => {
    const self = { service: { status: async () => ({ label: 'live', metrics: [{ key: 'streamed', value: 9, live: true }], note: null }) } }
    service.init({ eventRegistry: registry([], 0), plugins: { live: self }, pluginNames: ['live'], logger: console })
    const s = await service.summary({})
    expect(s.status.map(p => p.module)).toEqual(['live'])
    expect(s.status_silent).toEqual([])
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md) — the guard that
// stops the next metric shipping as a bare key. live's row is the one with BOTH
// kinds of number, so it also checks the windowed/current-state split is explained.
describe('status() descriptions', () => {
  it('gives every metric a description that says more than the key', async () => {
    service.init({
      eventRegistry: registry([{ type: 'mail.sent', count: 5 }], 2),
      plugins: {}, logger: console,
      streamStats: () => ({ received: 9, overCeiling: 1, unwatched: 0, subscribers: 1 }),
    })
    const s = await service.status({ since: new Date(Date.now() - 1800_000) })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
    for (const m of s.metrics) {
      // Rendered inline in a 340px pane, so length is still the constraint — but
      // written for the person USING the system, not for whoever built it, which
      // needs a few more words than a terse engineering label.
      expect(m.description.length).toBeLessThanOrEqual(72)
      // ...and it must still say more than the key already does.
      expect(m.description.toLowerCase()).not.toBe(m.key.toLowerCase())
      expect(m.description.length).toBeGreaterThan(12)
    }
  })

  // The two-paths cross-check is the reason this status() exists, so `streamed` has
  // to explain it rather than just naming itself.
  it('explains what a zero `streamed` would mean', async () => {
    service.init({
      eventRegistry: registry([], 0), plugins: {}, logger: console,
      streamStats: () => ({ received: 0, overCeiling: 0, unwatched: 0, subscribers: 0 }),
    })
    const s = await service.status({ since: new Date() })
    expect(s.metrics.find(m => m.key === 'streamed').description).toMatch(/received live/i)
  })

  // No stream at all vs an idle one have different fixes, and the prose says which.
  it('says a missing stream is a wiring problem, not a Redis one', async () => {
    service.init({ eventRegistry: registry([], 0), plugins: {}, logger: console, streamStats: () => null })
    const s = await service.status({})
    expect(s.metrics[0].description).toMatch(/Live updates are off/i)
  })
})

// The dashboard-wide filter. It used to narrow the FEED only, client-side, because
// that was the one list the browser held; everything else on the board is a server
// aggregate, so narrowing those has to happen here.
describe('makeFilter — the board-wide filter', () => {
  const payload = (dir, ch) => ({ data: { direction: dir, channel: ch } })

  it('passes everything when no axis is constrained', () => {
    const f = service.makeFilter({})
    expect(f.off).toBe(true)
    expect(f.passes('mail.sent', null)).toBe(true)
  })

  // `-x` excludes. This is the default the board ships with (`dir=-internal`).
  it('excludes a value with a leading dash', () => {
    const f = service.makeFilter({ dir: '-internal' })
    expect(f.passes('journey.enrolled', null)).toBe(false)   // internal
    expect(f.passes('mail.sent', null)).toBe(true)           // out
    expect(f.passes('crm.deal', null)).toBe(true)            // in
  })

  // An include list makes the axis exclusive — the other rule of a faceted filter.
  it('admits only the included values once anything is included', () => {
    const f = service.makeFilter({ chan: 'mail,sms' })
    expect(f.passes('mail.sent', null)).toBe(true)
    expect(f.passes('sms.sent', null)).toBe(true)
    expect(f.passes('crm.deal', null)).toBe(false)
  })

  // Exclude beats include, so `mail,-mail` resolves rather than contradicting.
  it('lets an exclude win over an include on the same value', () => {
    const f = service.makeFilter({ chan: 'mail,-mail' })
    expect(f.passes('mail.sent', null)).toBe(false)
  })

  it('requires BOTH axes to pass', () => {
    const f = service.makeFilter({ dir: 'out', chan: 'mail' })
    expect(f.passes('mail.sent', null)).toBe(true)
    expect(f.passes('sms.sent', null)).toBe(false)    // right direction, wrong channel
    expect(f.passes('crm.deal', null)).toBe(false)    // right channel? no — and wrong direction
  })

  // Classification is by the RECORDED facet where there is one, exactly as the feed
  // does it — so one awareness type filtered by direction splits correctly.
  it('filters one awareness type by its recorded direction', () => {
    const f = service.makeFilter({ dir: 'in' })
    expect(f.passes('awareness.recorded', payload('observation', 'crm'))).toBe(true)
    expect(f.passes('awareness.recorded', payload('exposure', 'mail'))).toBe(false)
  })

  it('ignores empty tokens and whitespace rather than treating them as a value', () => {
    const f = service.makeFilter({ dir: ' , out , ' })
    expect(f.off).toBe(false)
    expect(f.passes('mail.sent', null)).toBe(true)
    expect(f.passes('crm.deal', null)).toBe(false)
  })
})

// The filter has to reach the aggregates, or the cards contradict the feed above
// them — which is the whole reason it moved server-side.
describe('summary()/timeseries() honour the board filter', () => {
  const counts = [
    { type: 'mail.sent', count: 60 },
    { type: 'crm.deal', count: 30 },
    { type: 'journey.enrolled', count: 10 },
  ]

  it('drops filtered rows from the totals, the directions and the channels', async () => {
    service.init({ eventRegistry: registry(counts, 7), logger: console })
    const all = await service.summary({ window: '30m' })
    expect(all.total).toBe(100)

    const out = await service.summary({ window: '30m', dir: 'out' })
    expect(out.total).toBe(60)
    expect(out.by_direction).toMatchObject({ out: 60, in: 0, internal: 0 })
    expect(out.by_channel).toEqual({ mail: 60 })
  })

  // `types` feeds the feed's count view, so it has to narrow with everything else.
  it('narrows the type breakdown too', async () => {
    service.init({ eventRegistry: registry(counts, 0), logger: console })
    const s = await service.summary({ window: '30m', chan: '-mail' })
    expect(s.types.map(t => t.type).sort()).toEqual(['crm.deal', 'journey.enrolled'])
  })

  // The strip must not change SHAPE when narrowed — a filtered-out row leaves its
  // bucket at zero rather than removing the bucket, or the bars would re-space.
  it('keeps every bucket seeded while filtering what lands in them', async () => {
    const now = Date.now()
    const bucketOf = (m) => new Date(Math.floor((now - m * 60_000) / 60_000) * 60_000).toISOString()
    service.init({
      eventRegistry: registry([], 0, [
        { bucket: bucketOf(1), type: 'crm.deal', count: 2 },
        { bucket: bucketOf(2), type: 'mail.sent', count: 5 },
      ]),
      logger: console,
    })
    const unfiltered = await service.timeseries({ window: '30m' })
    const filtered = await service.timeseries({ window: '30m', dir: 'in' })
    expect(filtered.buckets.length).toBe(unfiltered.buckets.length)
    expect(filtered.buckets.reduce((a, b) => a + b.in, 0)).toBe(2)
    expect(filtered.buckets.reduce((a, b) => a + b.out, 0)).toBe(0)
  })
})

// The filter lists' own counts. This is what fixes an empty Channel list: the
// options used to be derived in the browser from feed rows, so a quiet window
// offered nothing to filter by even when the window itself had traffic.
describe('summary().axes — what the filter lists offer', () => {
  const counts = [
    { type: 'mail.sent', count: 60 },
    { type: 'crm.deal', count: 30 },
    { type: 'journey.enrolled', count: 10 },
  ]
  const seen = (map) => Object.fromEntries(Object.entries(map).filter(([, n]) => n > 0))

  // A filter list is not a report. The options are every channel this plugin can
  // classify, so you can switch one off BEFORE it gets busy — the old behaviour
  // offered only what had happened lately, which meant a quiet window offered
  // nothing at all and the list simply looked broken.
  it('offers every known channel whether or not it has traffic', async () => {
    service.init({ eventRegistry: registry([], 0), logger: console })
    const s = await service.summary({ window: '30m' })
    expect(Object.keys(s.axes.channel).length).toBeGreaterThan(10)
    expect(s.axes.channel).toHaveProperty('mail', 0)
    expect(s.axes.channel).toHaveProperty('voip', 0)
    // `web` arrives only as an awareness channel, never as a type prefix, so it has
    // to be in the list by name or the browser SDK's traffic is unfilterable.
    expect(s.axes.channel).toHaveProperty('web', 0)
    // `awareness` is a TYPE prefix, not a channel — its events report their own.
    expect(s.axes.channel).not.toHaveProperty('awareness')
    // Nor are the defensive aliases in BY_PREFIX that nothing emits. Offering both
    // `journey` and `journeys` would put an option in the filter that can never
    // match anything, and the same for `queue`.
    expect(s.axes.channel).toHaveProperty('journey', 0)
    expect(s.axes.channel).not.toHaveProperty('journeys')
    expect(s.axes.channel).not.toHaveProperty('queue')
  })

  it('counts the window on top of that list', async () => {
    service.init({ eventRegistry: registry(counts, 0), logger: console })
    const s = await service.summary({ window: '30m' })
    expect(s.axes.direction).toMatchObject({ out: 60, in: 30, internal: 10 })
    expect(seen(s.axes.channel)).toEqual({ mail: 60, crm: 30, journey: 10 })
  })

  // The rule that keeps a filter usable: each axis is counted as if only the OTHER
  // axis were applied. Narrow to one channel and the others must still show what
  // they WOULD contribute, or the control you'd use to widen again has erased itself.
  it('leaves an axis out of its own count, so switching a value off does not erase it', async () => {
    service.init({ eventRegistry: registry(counts, 0), logger: console })
    const s = await service.summary({ window: '30m', chan: 'mail' })

    // The cards ARE narrowed...
    expect(s.total).toBe(60)
    expect(s.by_channel).toEqual({ mail: 60 })
    // ...while the channel list still shows all three with their full counts.
    expect(seen(s.axes.channel)).toEqual({ mail: 60, crm: 30, journey: 10 })
    // The direction facet DOES respect the channel filter — it's the other axis.
    expect(s.axes.direction).toMatchObject({ out: 60, in: 0, internal: 0 })
  })

  it('does the same in the other direction', async () => {
    service.init({ eventRegistry: registry(counts, 0), logger: console })
    const s = await service.summary({ window: '30m', dir: '-internal' })
    // direction list keeps internal visible, so it can be switched back on
    expect(s.axes.direction).toMatchObject({ internal: 10, out: 60, in: 30 })
    // channel list drops the excluded direction's channel
    expect(seen(s.axes.channel)).toEqual({ mail: 60, crm: 30 })
  })

  // A channel classify.js has never heard of must still be filterable, or it is
  // invisible to the one control that could hide it.
  it('unions in a channel it does not know about', async () => {
    service.init({ eventRegistry: registry([{ type: 'newthing.happened', count: 4 }], 0), logger: console })
    const s = await service.summary({ window: '30m' })
    expect(s.axes.channel).toHaveProperty('newthing', 4)
  })
})

// The manifest the Coming in / Going out cards render. Live.vue used to keep its own
// two lists of which channels flow which way; that duplication caused `conversions`
// for `conversion` (dropping every conversion from the card) and a missing
// `adnetwork` ("nothing sent" beside fourteen adnetwork events in the feed).
describe('summary().by_direction_channel — the in/out manifest', () => {
  it('splits channel counts by direction, per event', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'mail.sent', count: 60 },
        { type: 'crm.deal', count: 30 },
        { type: 'journey.enrolled', count: 10 },
      ], 0),
      logger: console,
    })
    const s = await service.summary({ window: '30m' })
    expect(s.by_direction_channel.out).toEqual({ mail: 60 })
    expect(s.by_direction_channel.in).toEqual({ crm: 30 })
    expect(s.by_direction_channel.internal).toEqual({ journey: 10 })
  })

  // Why a per-CHANNEL direction would have been wrong: one channel legitimately
  // carries both, so the split has to be per event.
  it('puts one channel on both sides when it genuinely flows both ways', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'awareness.recorded', count: 25, recorded_direction: 'exposure', recorded_channel: 'mail' },
        { type: 'awareness.recorded', count: 7, recorded_direction: 'expression', recorded_channel: 'mail' },
      ], 0),
      logger: console,
    })
    const s = await service.summary({ window: '30m' })
    expect(s.by_direction_channel.out).toEqual({ mail: 25 })
    expect(s.by_direction_channel.in).toEqual({ mail: 7 })
  })

  it('is narrowed by the board filter, like the cards it feeds', async () => {
    service.init({
      eventRegistry: registry([
        { type: 'mail.sent', count: 60 },
        { type: 'crm.deal', count: 30 },
      ], 0),
      logger: console,
    })
    const s = await service.summary({ window: '30m', dir: 'in' })
    expect(s.by_direction_channel.in).toEqual({ crm: 30 })
    expect(s.by_direction_channel.out).toEqual({})
  })
})

// The third filter axis, and the one that works differently from the other two.
// Direction and channel are derived from (type, payload), so they are applied
// after the fact to grouped counts. A passport is a COLUMN on the row — it can't
// be derived from a type, and grouped totals can't be narrowed to one person
// after the fact — so it is pushed into the query instead.
describe('the passport filter', () => {
  const registryWithSpy = () => {
    const seen = {}
    return {
      seen,
      registry: {
        countsByType: vi.fn(async (a) => { seen.counts = a; return [{ type: 'mail.sent', count: 3 }] }),
        activePassports: vi.fn(async (a) => { seen.active = a; return 1 }),
        series: vi.fn(async (a) => { seen.series = a; return [] }),
        recent: vi.fn(async (a) => { seen.recent = a; return [] }),
      },
    }
  }

  it('scopes every aggregate to that person, at the query', async () => {
    const { seen, registry } = registryWithSpy()
    service.init({ eventRegistry: registry, logger: console })
    await service.summary({ window: '30m', passport: 'p-1' })
    expect(seen.counts).toMatchObject({ passportId: 'p-1' })
    expect(seen.active).toMatchObject({ passportId: 'p-1' })
  })

  it('scopes the traffic strip too, so the cards and the chart agree', async () => {
    const { seen, registry } = registryWithSpy()
    service.init({ eventRegistry: registry, logger: console })
    await service.timeseries({ window: '30m', passport: 'p-1' })
    expect(seen.series).toMatchObject({ passportId: 'p-1' })
  })

  // Not filtered after the fact: someone with three events in a busy window would
  // otherwise get three rows out of the most recent hundred and read as quiet.
  it('scopes the feed backfill at the query rather than filtering the page', async () => {
    const { seen, registry } = registryWithSpy()
    service.init({ eventRegistry: registry, logger: console })
    await service.recent({ window: '30m', passport: 'p-1' })
    expect(seen.recent).toMatchObject({ passportId: 'p-1' })
  })

  // An unset filter must send null, not undefined or '' — the registry branches on
  // truthiness, and a stray empty string would add `WHERE passport_id = ''`.
  it('asks for everyone when no passport is selected', async () => {
    const { seen, registry } = registryWithSpy()
    service.init({ eventRegistry: registry, logger: console })
    await service.summary({ window: '30m' })
    expect(seen.counts.passportId).toBeNull()
    await service.summary({ window: '30m', passport: '' })
    expect(seen.counts.passportId).toBeNull()
  })
})
