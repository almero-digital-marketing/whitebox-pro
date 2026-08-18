import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'
import * as computed from '../../src/facts/computed.js'

// Content identity + fact-anchored windows.
//
// The question these exist for: "which videos do people watch BEFORE their first
// booking?" It needed three things that did not exist — a predicate on WHICH
// content, a filter on `source` (so "video" is expressible as a class at all), and
// a time bound whose boundary is a DIFFERENT instant per passport. `since`/`until`
// take one date for everybody; `asOf` moves the whole query's clock; a funnel
// answers with the surviving cohort, never with the exposures themselves.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const asMap = series => Object.fromEntries(series.map(r => [r.bucket, r.value]))

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => { await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE') })

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function watch(passport_id, { ts, url, source = 'video', pct, id = null }) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, ts: d(ts), channel: 'web', direction: 'expression', source,
    text: 'x', content_id: id, content_url: url,
    meta: pct == null ? null : JSON.stringify({ completion_pct: pct }),
  })
}
const booked = (passport_id, value) => facts.record({ passport_id, key: 'first_booked_at', value, source: 't' })

const A = 'https://cms.x.bg/faq/irena-1.mp4'
const B = 'https://cms.x.bg/faq/cvetelina-1.mp4'
const C = 'https://cms.x.bg/promo/summer.mp4'

// booker watched A twice and B once BEFORE booking, then A again after.
// browser never booked at all — the comparison group.
// existing booked long before the videos existed, so everything is after.
async function fixture() {
  const booker = await newPassport(), browser = await newPassport(), existing = await newPassport()
  await booked(booker, '2026-05-10T00:00:00Z')
  await booked(existing, '2026-01-01T00:00:00Z')

  await watch(booker, { ts: '2026-05-01', url: A, pct: 90 })
  await watch(booker, { ts: '2026-05-02', url: A, pct: 100 })
  await watch(booker, { ts: '2026-05-03', url: B, pct: 50 })
  await watch(booker, { ts: '2026-05-20', url: A, pct: 10 })      // after booking
  await watch(browser, { ts: '2026-05-04', url: A, pct: 20 })
  await watch(browser, { ts: '2026-05-05', url: C, pct: 30 })
  await watch(existing, { ts: '2026-05-06', url: A, pct: 40 })    // after their booking
  return { booker, browser, existing }
}

const video = (extra = {}) => ({ filter: { metric: { source: 'video', ...extra } } })
const BEFORE = { before: { fact: 'first_booked_at' } }
const AFTER = { after: { fact: 'first_booked_at' } }
// group by `source` gives one constant bucket, so the single row IS the total
const totalOf = async (metric) => {
  const r = await selector.resolve({ filter: { metric } }, { group: { by: 'source' } })
  return r.find(x => x.bucket === 'video')?.value ?? 0
}

describe('selector: source is filterable', () => {
  it('selects one source, which `channel` cannot express', async () => {
    const p = await newPassport()
    await watch(p, { ts: '2026-05-01', url: A })
    await watch(p, { ts: '2026-05-02', url: A, source: 'page' })
    // channel is 'web' for both — the reason video needed its own handle
    expect(await totalOf({ source: 'video', count: {} })).toBe(1)
    const byChannel = await selector.resolve(
      { filter: { metric: { channel: 'web', count: {} } } }, { group: { by: 'channel' } })
    expect(asMap(byChannel)).toEqual({ web: 2 })     // both, indistinguishable by channel
  })

  it('takes a list, and { present: false } for rows with no source', async () => {
    const p = await newPassport()
    await watch(p, { ts: '2026-05-01', url: A })
    await watch(p, { ts: '2026-05-02', url: A, source: 'page' })
    await watch(p, { ts: '2026-05-03', url: A, source: null })
    const many = await selector.resolve(
      { filter: { metric: { source: ['video', 'page'], count: {} } } }, { group: { by: 'source' } })
    expect(asMap(many)).toEqual({ video: 1, page: 1 })
    const missing = await selector.resolve(
      { filter: { metric: { source: { present: false }, count: {} } } }, { group: { by: 'channel' } })
    expect(asMap(missing)).toEqual({ web: 1 })
  })
})

describe('selector: content by identity', () => {
  it('selects exact urls, and a list of them', async () => {
    await fixture()
    expect(await totalOf({ source: 'video', content: { url: A }, count: {} })).toBe(5)
    expect(await totalOf({ source: 'video', content: { url: { in: [B, C] } }, count: {} })).toBe(2)
  })

  it('matches a url whose query string differs from the one asked for', async () => {
    // The invariant that makes a filter and a `content_url` breakdown agree: both
    // sides are canonicalised. Without it, every share of a link with ?utm_… on it
    // is a different string and a filter written from a real address misses its own
    // traffic.
    const p = await newPassport()
    await watch(p, { ts: '2026-05-01', url: `${A}?utm_source=fb` })
    await watch(p, { ts: '2026-05-02', url: `${A}#t=30` })
    expect(await totalOf({ source: 'video', content: { url: A }, count: {} })).toBe(2)
    expect(await totalOf({ source: 'video', content: { url: `${A}?utm_source=google` }, count: {} })).toBe(2)
  })

  it('selects a folder of assets by prefix', async () => {
    await fixture()
    expect(await totalOf({ source: 'video', content: { url: { prefix: 'https://cms.x.bg/faq/' } }, count: {} })).toBe(6)
    expect(await totalOf({ source: 'video', content: { prefix: 'https://cms.x.bg/promo/' }, count: {} })).toBe(1)
  })

  it('selects by content_id and by content_hash', async () => {
    const p = await newPassport()
    await watch(p, { ts: '2026-05-01', url: A, id: 'welcome-1' })
    await watch(p, { ts: '2026-05-02', url: B, id: 'welcome-2' })
    expect(await totalOf({ source: 'video', content: { id: 'welcome-1' }, count: {} })).toBe(1)
    expect(await totalOf({ source: 'video', content: { id: { in: ['welcome-1', 'welcome-2'] } }, count: {} })).toBe(2)
  })

  it('names the mistake when a measurement is passed as content', async () => {
    // completion_pct describes an asset, it does not identify one — and it is an
    // `attrs` key. Rejecting beats matching nothing in silence.
    await expect(selector.resolve(video({ content: { completion_pct: 90 }, count: {} }), { group: { by: 'source' } }))
      .rejects.toThrow(/use url\/id\/hash\/prefix/)
  })

  it('still honours the DEPRECATED string form (substring on content_id)', async () => {
    const p = await newPassport()
    await watch(p, { ts: '2026-05-01', url: A, id: 'welcome-1' })
    expect(await totalOf({ source: 'video', content: 'welcome', count: {} })).toBe(1)
  })
})

describe('selector: fact-anchored window', () => {
  it('takes only the exposures before THIS passport’s own anchor', async () => {
    const { booker } = await fixture()
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(3)
    const people = await selector.resolve(
      { filter: { metric: { source: 'video', window: BEFORE, distinct_passports: {} } } },
      { group: { by: 'source' } })
    expect(people[0].value).toBe(1)              // only booker qualifies
    // and it is per-passport, not one global date: browser watched on 05-04, INSIDE
    // booker's pre-booking span, and is still excluded — they have no anchor.
    void booker
  })

  it('before + after + missing:only is an EXACT partition', async () => {
    // The property that makes the three trustworthy together: `before` is strict,
    // `after` is inclusive, so every exposure lands in exactly one and the counts
    // sum to the unwindowed total. Nothing lost, nothing double-counted.
    await fixture()
    const all = await totalOf({ source: 'video', count: {} })
    const before = await totalOf({ source: 'video', window: BEFORE, count: {} })
    const after = await totalOf({ source: 'video', window: AFTER, count: {} })
    const none = await totalOf({ source: 'video', window: { ...BEFORE, missingAnchor: 'only' }, count: {} })
    expect(all).toBe(7)
    expect([before, after, none]).toEqual([3, 2, 2])
    expect(before + after + none).toBe(all)
  })

  it('puts an exposure exactly AT the anchor on the `after` side', async () => {
    const p = await newPassport()
    await booked(p, '2026-05-10T12:00:00Z')
    await watch(p, { ts: '2026-05-10T12:00:00Z', url: A })
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(0)
    expect(await totalOf({ source: 'video', window: AFTER, count: {} })).toBe(1)
  })

  it('anchors on the fact’s VALUE, not when it was recorded', async () => {
    // The CRM backfills. A booking made in March that syncs in May must anchor in
    // March, or every backfilled customer looks like they watched everything first.
    const p = await newPassport()
    await watch(p, { ts: '2026-04-01', url: A })          // after a March booking
    await booked(p, '2026-03-01T00:00:00Z')               // recorded NOW, value = March
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(0)
    expect(await totalOf({ source: 'video', window: AFTER, count: {} })).toBe(1)
  })

  it('excludes passports with no anchor by default', async () => {
    const { browser } = await fixture()
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: BEFORE, count: {} } } }, { group: { by: 'source' } })
    expect(r[0].value).toBe(3)                            // browser's 2 are absent
    void browser
  })

  it('missing:only returns JUST the never-reached-it comparison group', async () => {
    // Addressable rather than dropped: on the data this was built for, 488 of 896
    // video watchers had never booked. They are most of the population and the
    // baseline that makes "watched before booking" mean anything.
    await fixture()
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'only' }, distinct_passports: {} } } },
      { group: { by: 'source' } })
    expect(r[0].value).toBe(1)                            // browser
    const byContent = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'only' }, count: {} } } },
      { group: { by: 'content_url' } })
    expect(asMap(byContent)).toEqual({ [A]: 1, [C]: 1 })
  })

  it('missing:include treats no anchor as no boundary', async () => {
    await fixture()
    // booker's 3 pre-booking + browser's 2 (unbounded, never booked)
    expect(await totalOf({ source: 'video', window: { ...BEFORE, missingAnchor: 'include' }, count: {} })).toBe(5)
  })

  it('within bounds the far side — "the week before"', async () => {
    const p = await newPassport()
    await booked(p, '2026-05-10T00:00:00Z')
    await watch(p, { ts: '2026-05-09', url: A })          // 1 day before  → in
    await watch(p, { ts: '2026-05-04', url: A })          // 6 days before → in
    await watch(p, { ts: '2026-05-01', url: A })          // 9 days before → out
    expect(await totalOf({ source: 'video', window: { ...BEFORE, within: '7d' }, count: {} })).toBe(2)
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(3)
  })

  it('offset shifts the boundary either way', async () => {
    const p = await newPassport()
    await booked(p, '2026-05-10T00:00:00Z')
    await watch(p, { ts: '2026-05-12', url: A })
    // two days after the booking: outside `before`, inside `before` shifted +7d
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(0)
    expect(await totalOf({ source: 'video', window: { ...BEFORE, offset: '7d' }, count: {} })).toBe(1)
    // and shifting the other way excludes what was inside
    await watch(p, { ts: '2026-05-08', url: A })
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(1)
    expect(await totalOf({ source: 'video', window: { ...BEFORE, offset: '-7d' }, count: {} })).toBe(0)
  })

  it('missingAnchor:bucket CROSS-TABULATES — one series per cohort, same buckets', async () => {
    // The question is "what do the people who reached the milestone watch that the
    // people who never did don't", and it is only answerable with both sides at the
    // same granularity. It used to take three calls plus manual normalisation.
    await fixture()
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'bucket' }, count: {} } } },
      { group: { by: 'content_url' } })
    expect(r.multi).toBe(true)
    expect(r.aggregate).toBe('count')
    const byName = Object.fromEntries(r.series.map(x => [x.name, asMap(x.points)]))
    expect(byName.__anchored__).toEqual({ [A]: 2, [B]: 1 })   // booker, before booking
    expect(byName.__no_anchor__).toEqual({ [A]: 1, [C]: 1 })  // browser, never booked
    // the anchored cohort comes first — it is the one being explained
    expect(r.series.map(x => x.name)).toEqual(['__anchored__', '__no_anchor__'])
  })

  it('carries each cohort\u2019s size, so a reach % needs no further call', async () => {
    // Comparing two cohorts by raw counts compares their SIZES more than their
    // behaviour, so the denominators have to come back with the numbers.
    await fixture()
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'bucket' }, distinct_passports: {} } } },
      { group: { by: 'content_url' } })
    expect(r.sizes).toEqual([
      { cohort: '__anchored__', size: 1 },      // booker
      { cohort: '__no_anchor__', size: 1 },     // browser
    ])
  })

  it('applies `limit` to the BUCKET dimension, so the table is not ragged', async () => {
    // Top-N ROWS would give three buckets for one cohort and one for the other, and
    // a chart drawn from that silently omits the comparison it exists to make.
    const booker = await newPassport(), browser = await newPassport()
    await booked(booker, '2026-05-10T00:00:00Z')
    await watch(booker, { ts: '2026-05-01', url: A })
    await watch(booker, { ts: '2026-05-02', url: A })
    await watch(booker, { ts: '2026-05-03', url: B })
    for (const u of [A, A, A, C]) await watch(browser, { ts: '2026-05-04', url: u })
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'bucket' }, count: {} } } },
      { group: { by: 'content_url', limit: 1 } })
    // A wins across both cohorts combined; BOTH series report it, and only it
    for (const sx of r.series) expect(sx.points.map(p => p.bucket)).toEqual([A])
    expect(r.series).toHaveLength(2)
  })

  it('cross-tabulates a value aggregate too, not just a count', async () => {
    // earliest/latest use array_agg(… order by ts), which works under any GROUP BY —
    // so there is no reason to special-case them out of the split.
    await fixture()
    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'bucket' }, avg: { field: 'completion_pct' } } } },
      { group: { by: 'content_url' } })
    const byName = Object.fromEntries(r.series.map(x => [x.name, asMap(x.points)]))
    expect(byName.__anchored__[A]).toBe(95)      // booker's 90 and 100, before booking
    expect(byName.__no_anchor__[A]).toBe(20)     // browser's single view
  })

  it('cross-tabulates a FACT aggregate, keeping the per-passport dedup', async () => {
    // The fact path is two-level — dedup per passport, THEN aggregate — or every
    // customer is weighted by how many events they have. The cohort rides along in
    // the DISTINCT, where it changes nothing: it is a function of the anchor, so it
    // is constant per passport.
    const booker = await newPassport(), browser = await newPassport()
    await booked(booker, '2026-05-10T00:00:00Z')
    await facts.record({ passport_id: booker, key: 'ltv', value: 300, source: 't' })
    // browser never booked and has no ltv
    for (const ts of ['2026-05-01', '2026-05-02', '2026-05-03']) await watch(booker, { ts, url: A })
    await watch(browser, { ts: '2026-05-04', url: A })

    const r = await selector.resolve(
      { filter: { metric: { source: 'video', window: { ...BEFORE, missingAnchor: 'bucket' }, avg: { fact: 'ltv' } } } },
      { group: { by: 'content_url' } })
    const byName = Object.fromEntries(r.series.map(x => [x.name, asMap(x.points)]))
    // 300 once, not 300 three times over three exposures
    expect(byName.__anchored__[A]).toBe(300)
    // and no ltv stays NULL rather than plotting as a real zero
    expect(byName.__no_anchor__[A]).toBe(null)
  })

  it('names missingAnchor and what each mode does', async () => {
    await fixture()
    await expect(selector.resolve(
      video({ window: { ...BEFORE, missing: 'only' }, count: {} }), { group: { by: 'source' } }))
      .rejects.toThrow(/`window` has no "missing"/)
  })

  it('between two anchors', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'signed_up_at', value: '2026-05-05T00:00:00Z', source: 't' })
    await booked(p, '2026-05-10T00:00:00Z')
    await watch(p, { ts: '2026-05-01', url: A })          // before signup  → out
    await watch(p, { ts: '2026-05-07', url: A })          // between        → in
    await watch(p, { ts: '2026-05-20', url: A })          // after booking  → out
    const w = { between: [{ fact: 'signed_up_at' }, { fact: 'first_booked_at' }] }
    expect(await totalOf({ source: 'video', window: w, count: {} })).toBe(1)
  })

  it('use: picks among a fact’s history — min is the earliest date ever claimed', async () => {
    // A corrected milestone. `last` is what the CRM now stands behind; `min` is the
    // earliest it ever said. They select different exposures, so it must be sayable.
    const p = await newPassport()
    await booked(p, '2026-05-10T00:00:00Z')
    await booked(p, '2026-05-01T00:00:00Z')               // correction, recorded later
    await watch(p, { ts: '2026-05-05', url: A })
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(0)          // last = 05-01
    expect(await totalOf({ source: 'video', window: { before: { fact: 'first_booked_at', use: 'max' } }, count: {} })).toBe(1)
    expect(await totalOf({ source: 'video', window: { before: { fact: 'first_booked_at', use: 'first' } }, count: {} })).toBe(1)
    expect(await totalOf({ source: 'video', window: { before: { fact: 'first_booked_at', use: 'min' } }, count: {} })).toBe(0)
  })

  it('an unparseable anchor value drops that passport, it does not fail the query', async () => {
    const ok = await newPassport(), bad = await newPassport()
    await booked(ok, '2026-05-10T00:00:00Z')
    await booked(bad, '')
    await watch(ok, { ts: '2026-05-01', url: A })
    await watch(bad, { ts: '2026-05-01', url: A })
    expect(await totalOf({ source: 'video', window: BEFORE, count: {} })).toBe(1)
  })
})

describe('selector: the whole question, end to end', () => {
  it('which videos are watched before the first booking, with avg completion', async () => {
    await fixture()
    const w = { source: 'video', window: BEFORE }
    const people = await selector.resolve({ filter: { metric: { ...w, distinct_passports: {} } } },
      { group: { by: 'content_url' } })
    expect(asMap(people)).toEqual({ [A]: 1, [B]: 1 })
    const completion = await selector.resolve({ filter: { metric: { ...w, avg: { field: 'completion_pct' } } } },
      { group: { by: 'content_url' } })
    // A: (90 + 100) / 2 = 95 — the 10% view after booking must NOT drag it down
    expect(asMap(completion)).toEqual({ [A]: 95, [B]: 50 })
  })

  it('and the same, restricted to one folder of assets', async () => {
    await fixture()
    const r = await selector.resolve({
      filter: { metric: {
        source: 'video',
        content: { url: { prefix: 'https://cms.x.bg/faq/' } },
        window: BEFORE,
        count: {},
      } },
    }, { group: { by: 'content_url' } })
    expect(asMap(r)).toEqual({ [A]: 2, [B]: 1 })
  })

  it('rejects a window anchored on a computed fact — a number is not an instant', async () => {
    await fixture()
    computed.init({ age: { from: 'birthdate', unit: 'years' } })
    await expect(selector.resolve(
      video({ window: { before: { fact: 'age' } }, count: {} }), { group: { by: 'source' } }))
      .rejects.toThrow(/computed fact|cannot anchor/)
    computed.init({})
  })

  it('names the mistake for a malformed window', async () => {
    await fixture()
    const bad = async (w) => selector.resolve(video({ window: w, count: {} }), { group: { by: 'source' } })
    await expect(bad({ before: { fact: 'x' }, after: { fact: 'y' } })).rejects.toThrow(/exactly one of before\/after\/between/)
    await expect(bad({ before: 'first_booked_at' })).rejects.toThrow(/anchors events on a FACT/)
    await expect(bad({ before: { fact: 'x' }, missingAnchor: 'maybe' })).rejects.toThrow(/exclude\/include\/only\/bucket/)
    await expect(bad({ before: { fact: 'x' }, offset: '7 days' })).rejects.toThrow(/bad `offset`/)
    await expect(bad({ before: { fact: 'x' }, use: 'min' })).rejects.toThrow(/`window` has no "use"/)
    await expect(bad({ nope: 1 })).rejects.toThrow(/`window` has no "nope"/)
  })
})
