// The Live dashboard's reads. Owns no tables: the event registry is core's, the
// outbox tables belong to mail and sms, and this only ever asks them.
//
// Everything is windowed, and the window is the only parameter that matters —
// "47/min" is meaningless without saying over what.
import { direction, channel, DIRECTIONS, channels } from './classify.js'
import { describe } from './describe.js'

let eventRegistry, plugins, pluginNames, logger, streamStats

export function init(deps) {
  ({ eventRegistry, plugins, pluginNames, logger, streamStats } = deps)
}

// This plugin's own health — the one thing the board could not previously show,
// which is a pointed gap for the plugin whose job is showing whether things work.
//
// The metric worth having is `streamed`, because notify() writes down TWO
// independent paths: the event registry (durable, Postgres) and FIREHOSE_CHANNEL
// (Redis pub/sub, which drives the feed and the socket). They normally move
// together. If the Redis subscription dies, the registry keeps filling while the
// feed goes quiet — and a quiet feed is indistinguishable from a quiet system,
// which is exactly the failure this whole card exists to catch. Comparing the two
// is the only way to tell, and this is the only place that can see both.
//
// Nothing here is windowed: the totals are process-lifetime and `subscribers` is
// read from socket.io now, so every metric is `live`.
export async function status({ since, passport } = {}) {
  const s = streamStats?.() ?? null

  // No stream at all is a different claim from a stream that has carried nothing,
  // and it has a different fix (wire up connect, vs go look at Redis).
  if (!s) {
    return {
      label: 'live',
      metrics: [{ key: 'streaming', value: 0, severity: 'bad', live: true,
        description: 'Live updates are off — this board refreshes on a timer' }],
      note: 'not streaming — connect.namespace() was unavailable at registration, so dashboards poll /summary instead of updating live',
    }
  }

  // The traffic aggregates — the same numbers the board's header leads with, now
  // reported through this contract rather than only as bespoke top-level fields on
  // /summary. They are live's own measurement: no plugin can report `events/min`
  // or `people active`, because those are properties of the whole event stream
  // rather than of anything a single plugin owns.
  //
  // WINDOWED, unlike the three pipeline counters below — so live's own row carries
  // both kinds, which is the clearest illustration of why `live` exists on a
  // metric at all.
  //
  // This re-reads the registry rather than reusing what summary() folded a moment
  // earlier: summary() runs collectStatus in the SAME Promise.all as its own
  // counts, so there is nothing computed yet to hand over. Two indexed aggregates
  // per 10s poll is the price of status() being self-contained and callable on its
  // own; a request-scoped cache is the fix if it ever shows up in a profile.
  // Derived from `since` itself, not from a window name — status() is handed a
  // Date, and hard-coding the default window here would silently report a 24h
  // total as a 30m rate.
  const secs = since instanceof Date
    ? Math.max(1, Math.round((Date.now() - since.getTime()) / 1000))
    : parseWindow()
  let traffic = null
  let recorded = 0
  try {
    // Scoped to the selected person when there is one. These five metrics are
    // PINNED to the top of the board, so they are the first thing anyone reads —
    // and they were the last thing still answering for everybody while every card
    // and the feed below them had narrowed to one person. Two panels disagreeing
    // about what you are looking at, with the louder one wrong.
    const [counts, active] = await Promise.all([
      eventRegistry.countsByType({ since, passportId: passport || null }),
      eventRegistry.activePassports
        ? eventRegistry.activePassports({ since, passportId: passport || null })
        : Promise.resolve(0),
    ])
    const byDirection = Object.fromEntries(DIRECTIONS.map(d => [d, 0]))
    let total = 0
    for (const row of counts) {
      const { type, count } = row
      byDirection[direction(type, facetPayload(row))] += count
      total += count
    }
    recorded = total
    traffic = { total, byDirection, active: Number(active || 0) }
  } catch (err) {
    logger?.warn?.({ err }, 'live: status() could not read the registry — reporting pipeline health only')
  }

  const metrics = []
  if (traffic) {
    metrics.push(
      // Per MINUTE regardless of window, so the figure means the same thing on
      // every setting — matching the header it mirrors.
      { key: 'events/min', value: Math.round((traffic.total / secs) * 60 * 10) / 10,
        description: 'How busy the system is, per minute' },
      { key: 'in', value: traffic.byDirection.in,
        description: 'Visitor activity coming in — views, forms, calls' },
      { key: 'out', value: traffic.byDirection.out,
        description: 'Messages going out — email, texts, ad platforms' },
      // Orchestration, not traffic — counted separately so it can't inflate
      // either direction beside it.
      { key: 'internal', value: traffic.byDirection.internal,
        description: 'Housekeeping the system did on its own' },
      { key: 'people active', value: traffic.active,
        description: 'People seen in this period' },
    )
  }
  metrics.push(
    { key: 'dashboards', value: s.subscribers, live: true,
      description: 'People watching this board right now' },
    { key: 'streamed', value: s.received, live: true,
      description: 'Events this board has received live' },
    // Over the 200-per-flush ceiling. Non-zero means a dashboard was shown a
    // fraction of the traffic without any way to know which part.
    { key: 'dropped', value: s.overCeiling, severity: 'bad', live: true,
      description: 'Live events not shown — the board fell behind' },
  )

  // The cross-check, and the guard that stops it crying wolf.
  //
  // `received` counts from THIS boot; `recorded` covers the selected window. Right
  // after a restart the log legitimately holds events the stream was never going to
  // see, so "recorded > 0 and received === 0" is the normal state for a while — and
  // warning then is worse than not warning at all, because an alarm that fires on
  // every deploy gets learned as noise.
  // Only comparable when the whole window is after boot. Verified live: a restart
  // was making this claim a dead Redis subscription on a perfectly healthy system.
  const windowIsAfterBoot = since instanceof Date && s.bootedAt && since.getTime() >= s.bootedAt

  const note = s.overCeiling
    ? `${s.overCeiling} event${s.overCeiling === 1 ? '' : 's'} discarded at the ${'200'}-per-flush ceiling — dashboards showed a fraction of the traffic`
    : (windowIsAfterBoot && recorded && !s.received)
      ? 'the event log is recording but nothing has arrived on the firehose — the Redis subscription is probably dead, so the feed will stay empty while the system is busy'
      : (!s.subscribers && s.unwatched)
        ? `${s.unwatched} event${s.unwatched === 1 ? '' : 's'} went unstreamed with no dashboard connected — not a fault, the registry holds them`
        : null

  return { label: 'live', metrics, note }
}

// ── dashboard-wide filters ─────────────────────────────────────────────────
//
// The board's filters used to narrow the FEED only, client-side, because that was
// the one list the browser held. Everything else on the board — the header figures,
// Coming in / Going out, the traffic strip — is a server aggregate, so narrowing
// those means narrowing them HERE.
//
// Applied after classification, not in SQL. Direction and channel are this plugin's
// own reading of an event (classify.js); the registry doesn't store them, so there
// is nothing to put in a WHERE clause. Filtering the classified rows is both the
// only place it can happen and the only way the feed and the cards are guaranteed
// to agree about what a row is.
//
// Wire format is one token list per axis, `-` prefixed to exclude:
//   dir=-internal        everything except orchestration
//   chan=mail,sms        only these two
// which is exactly the tri-state the UI holds, so nothing has to be translated.
export function parseAxis(param) {
  const inc = new Set(), exc = new Set()
  for (const raw of String(param || '').split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('-')) exc.add(t.slice(1))
    else inc.add(t)
  }
  return { inc, exc }
}

// The standard faceted rules, matching the UI's `axisMatch` exactly — an exclude
// always wins, an include list makes the axis exclusive, and an empty axis passes
// everything. Kept identical on purpose: two implementations of "does this row
// match" is how a filtered card ends up disagreeing with the filtered feed under it.
const axisPasses = (value, { inc, exc }) =>
  !exc.has(value) && (inc.size === 0 || inc.has(value))

export function makeFilter({ dir, chan } = {}) {
  const d = parseAxis(dir)
  const c = parseAxis(chan)
  const off = !d.inc.size && !d.exc.size && !c.inc.size && !c.exc.size
  return {
    off,
    // Per-axis, because the FILTER LISTS need counts with their own axis left out.
    // Otherwise the options erase themselves: narrow to one channel and every other
    // channel drops to nothing, so the control you'd use to widen again is gone.
    // This is the standard faceted-search rule — each facet counted as if only the
    // OTHER facets were applied.
    dirPasses: (value) => axisPasses(value, d),
    chanPasses: (value) => axisPasses(value, c),
    // `payload` is the recorded-facet shape, so this asks the same question the
    // feed row asks.
    passes: (type, payload) => off
      || (axisPasses(direction(type, payload), d) && axisPasses(channel(type, payload), c)),
  }
}

// Accepts 5m / 30m / 1h / 24h, defaults to 30m. Parsed rather than free-form
// seconds so a caller can't ask for a window that would scan the whole table.
const WINDOWS = { '5m': 300, '30m': 1800, '1h': 3600, '24h': 86400 }
export const parseWindow = (w) => WINDOWS[w] ?? WINDOWS['30m']

const since = (secs) => new Date(Date.now() - secs * 1000)

// Aggregate rows carry the direction/channel the producer recorded (see core's
// event-registry countsByType/series) as flat `recorded_*` columns. classify.js
// reads the nested payload shape instead, because that's what a real event looks
// like — so reshape rather than teach it a second shape, and both paths keep
// going through exactly one classifier. Null when the type records neither
// facet, which classify handles as "decide from the type alone".
// Tolerates an older core that doesn't return the facets at all: no columns ⇒
// null ⇒ previous type-only behaviour, no crash.
function facetPayload(row) {
  if (!row?.recorded_direction && !row?.recorded_channel) return null
  return { data: { direction: row.recorded_direction, channel: row.recorded_channel } }
}

// Sum the per-facet rows back into one row per type, biggest first — what a
// "Top event types" list means. Independent of how many facets a type happens to
// span, so a type that starts recording a new channel doesn't split its own row.
function collapseTypes(counts) {
  const byType = new Map()
  for (const { type, count } of counts) byType.set(type, (byType.get(type) || 0) + count)
  return [...byType.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

// Health, collected from whoever can describe their own (docs/10-plugin-status.md).
//
// This USED to name mail, sms and voip, and know each one's field names — so
// adding a channel meant editing this file and the UI, and both could disagree
// about a plugin neither owns. Now any plugin exposing `status()` appears, and
// none has to be announced.
//
// `plugins` is read HERE, per request, not captured at register() time: core
// accumulates ctx.plugins as each plugin registers (server/src/plugins.js), so
// reading it late sees plugins that registered AFTER live — which removes this
// plugin's ordering constraint entirely.
//
// A plugin that throws is omitted rather than reported as zeros: absent means
// "nobody is watching this", zero means "nothing happened", and rendering the
// first as the second is how a broken channel looks healthy.
// Excluded from the SILENT list only — not from the card. `console-events` is a
// route shim with no state of its own, so naming it as unmonitored would be
// noise. `live` is listed here for the same reason historically ("a monitor
// reporting on itself"), but that was the wrong call: its own pipeline was the one
// thing the board couldn't show, and a dead firehose looks exactly like a quiet
// system. It now implements status() (above), so it appears in `reported` and this
// set never sees it — the entry is kept only so that removing status() would
// degrade to "shim", not to a false "unmonitored".
const OBSERVERS = new Set(['live', 'console-events'])

// `passport` reaches a plugin's status() as an extra key, which every other
// plugin ignores — mail's queue depth is not a per-person number and cannot be
// scoped. Only live's own traffic metrics use it, and they must: they are the
// board's headline figures.
async function collectStatus(since, passport) {
  const all = Object.entries(plugins || {})
  const entries = all.filter(([, api]) => typeof api?.service?.status === 'function')

  const results = await Promise.all(entries.map(async ([module, api]) => {
    try {
      const s = await api.service.status({ since, passport: passport || null })
      if (!s) return null
      return {
        module,
        label: s.label || module,
        metrics: Array.isArray(s.metrics) ? s.metrics : [],
        note: s.note ?? null,
      }
    } catch (err) {
      logger?.warn?.({ err, module }, 'live: %s status() failed — omitting it', module)
      return { module, failed: true }
    }
  }))

  const reported = results.filter(Boolean)
  // Registered but saying nothing. Absent is the CORRECT rendering for a plugin
  // that can't describe itself — a zero would read as healthy — but absence is
  // also easy to miss: nobody looking at the card notices that a plugin has never
  // once reported. Naming them is the difference between a card that shows what's
  // monitored and one that shows what ISN'T.
  // Derived from the REGISTERED plugin names, not from ctx.plugins. Core only
  // populates ctx.plugins `if (api)` (server/src/plugins.js), so a plugin that
  // returns nothing from register() is absent from it entirely — and was
  // therefore invisible to this list too, which is precisely the blind spot the
  // list exists to remove. Four plugins (engagement, geolocation, oauth,
  // analytics) sat in neither `status` nor `silent` until this used the right
  // source.
  const registered = (pluginNames?.length ? pluginNames : all.map(([m]) => m))
  const silent = registered
    .filter(m => !OBSERVERS.has(m) && !entries.some(([e]) => e === m))

  return {
    // A plugin whose status() threw is reported as failing rather than dropped:
    // "this channel is broken" is a different and more urgent claim than "this
    // channel isn't monitored", and collapsing the two hides the worse one.
    reported: reported.filter(p => !p.failed),
    failing: reported.filter(p => p.failed).map(p => p.module),
    silent,
  }
}

/**
 * Everything the dashboard header and cards need, in one round trip — the view
 * refreshes as a whole, so splitting it across endpoints would only guarantee
 * the cards disagree with each other by a second or two.
 */
// `passport` is a THIRD filter axis, and it works differently from the other two
// on purpose. Direction and channel are derived from (type, payload), so they are
// applied after the fact to grouped counts (see makeFilter). A passport is a
// column on the row — it can't be derived from a type — so it is pushed down into
// the QUERY, which is also the only way the counts can be right: filtering grouped
// totals afterwards can't tell you how much of a group belonged to one person.
export async function summary({ window: w, dir, chan, passport } = {}) {
  const secs = parseWindow(w)
  const from = since(secs)
  // Dashboard-wide: the same filter the feed uses, applied to the aggregates too.
  const filter = makeFilter({ dir, chan })

  const [counts, active, lastAt, status] = await Promise.all([
    eventRegistry.countsByType({ since: from, passportId: passport || null }),
    eventRegistry.activePassports({ since: from, passportId: passport || null }),
    // Unwindowed on purpose: an empty window is ambiguous, and this is what
    // resolves it. Optional so an older core doesn't break the whole read.
    eventRegistry.lastEventAt ? eventRegistry.lastEventAt().catch(() => null) : Promise.resolve(null),
    // Soft: a deployment without the mail plugin still gets every other card,
    // and `null` says "not wired" rather than a zero that reads as "healthy".
    collectStatus(from, passport),
  ])

  // Fold type counts into the three directions, and into channels.
  const byDirection = Object.fromEntries(DIRECTIONS.map(d => [d, 0]))
  const byChannel = {}
  // FACET counts, for the filter lists in the Live pane: each axis counted as if only
  // the OTHER axis were filtered. Without this the options erase themselves — tick
  // one channel and every other channel's count goes to zero, so the control you'd
  // use to widen again is gone, and the list looked simply "empty".
  // (It used to be derived in the browser from the feed rows, which had the same
  // effect for a different reason: a quiet window holds no rows, so there was nothing
  // to offer even though the window had traffic the feed had already evicted.)
  // Seeded from the channels this plugin can classify, not from the window's traffic.
  // A filter list is not a report: the options used to be whatever had happened
  // lately, so a quiet window offered nothing to filter BY — you could switch a
  // channel off only after it got busy. A channel is a thing the system HAS.
  // Unioned with whatever the window contains, so a channel nobody declared still
  // appears rather than being silently unfilterable.
  //
  // The list comes from the plugins themselves now (each declares `events` /
  // `channels`; see server/src/event-catalog.js), which is what removed three
  // options that could never match a row — `audiences` and `engagement` emit no
  // events at all, and nothing has ever emitted `webhook.*`.
  const axes = {
    direction: Object.fromEntries(DIRECTIONS.map(d => [d, 0])),
    channel: Object.fromEntries(channels().map(c => [c, 0])),
  }
  // Counts keyed by BOTH facets, which is what "Coming in" and "Going out" actually
  // need. The UI used to carry its own two lists of which channels are inbound and
  // which outbound, and that duplication caused two bugs in one sitting: `conversions`
  // for `conversion` (silently dropping every conversion) and a missing `adnetwork`
  // (the card read "nothing sent" beside fourteen adnetwork events in the feed).
  // A channel can't be assigned one direction — mail.received is in, mail.sent is
  // out — so the split has to be per EVENT, and only the server sees that.
  const byDirChannel = Object.fromEntries(DIRECTIONS.map(d => [d, {}]))
  let total = 0
  for (const row of counts) {
    const { type, count } = row
    // The registry groups by the direction/channel the producer RECORDED, so an
    // aggregate can be classified exactly like a single event — same classify.js
    // call, same answer as the feed beside it. This matters most for
    // `awareness.recorded`, which is one type spanning both inbound and
    // outbound touches: without the facet it all collapsed into `unknown`, and
    // since it's the highest-volume type in WhiteBox the "coming in / going
    // out" cards read empty while the feed showed inbound traffic.
    const payload = facetPayload(row)
    const d = direction(type, payload)
    const ch = channel(type, payload)

    // Each facet ignores its own axis, so a value you switched off still shows the
    // count it WOULD contribute — which is what makes it switchable back on.
    if (filter.chanPasses(ch)) axes.direction[d] = (axes.direction[d] || 0) + count
    if (filter.dirPasses(d)) axes.channel[ch] = (axes.channel[ch] || 0) + count

    if (!(filter.dirPasses(d) && filter.chanPasses(ch))) continue
    byDirection[d] = (byDirection[d] || 0) + count
    byChannel[ch] = (byChannel[ch] || 0) + count
    byDirChannel[d] = byDirChannel[d] || {}
    byDirChannel[d][ch] = (byDirChannel[d][ch] || 0) + count
    total += count
  }

  return {
    window: w && WINDOWS[w] ? w : '30m',
    window_seconds: secs,
    since: from.toISOString(),
    total,
    // The number the header leads with. Per MINUTE regardless of window, so the
    // figure means the same thing whichever window is selected.
    per_minute: Math.round((total / secs) * 60 * 10) / 10,
    by_direction: byDirection,
    by_channel: byChannel,
    // What the filter lists offer, and what each option is worth. Separate from
    // by_direction/by_channel above, which ARE narrowed — these must not be, or the
    // control narrows itself out of existence.
    axes,
    // Per direction, per channel. The manifest the in/out cards render, so no
    // surface has to keep its own list of which channels flow which way.
    by_direction_channel: byDirChannel,
    // Collapsed back to ONE row per type. `counts` is now keyed by
    // (type, recorded_direction, recorded_channel) so the folding above can
    // classify each facet correctly — but that made `awareness.recorded` appear
    // as several rows, and the "Top event types" list rendered it two or three
    // times with a split count (and duplicate :key values). The facet split is
    // an implementation detail of the folding, not something to publish.
    types: collapseTypes(counts.filter(r => filter.passes(r.type, facetPayload(r)))),
    active_passports: active,
    // so an empty board can say "quiet since…" rather than just showing zeros
    last_event_at: lastAt ? new Date(lastAt).toISOString() : null,
    // An ARRAY, in config order — see collectStatus. Not a keyed object: the
    // surface no longer knows which plugins exist, so it can't ask for them by
    // name.
    status: status.reported,
    // Registered plugins that reported nothing, split by WHY. `failing` threw and
    // is a problem; `silent` has no status() at all and is merely unmonitored.
    // Both are invisible in `status` alone, and the second is exactly the kind of
    // gap a monitoring card should surface rather than create.
    status_failing: status.failing,
    status_silent: status.silent,
  }
}

// Attribution for the window: where this window's SESSIONS came from.
//
// Sourced from `session.started`, not from the sessions table — this plugin owns
// no tables and doesn't read other people's. Core stamps the UTMs onto that
// event's payload precisely so an observer can answer this without a join.
//
// Scoped to session.started on purpose: UTMs belong to a session, and counting
// every event that happens to carry them would report page-views-per-campaign
// while the card says sessions.
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign']

// limit 10, matching content() and the ten rows the board's cards are sized for —
// it was 8, so Attribution could never fill the space reserved for it.
export async function utm({ window: w, limit = 10 } = {}) {
  const secs = parseWindow(w)
  const from = since(secs)

  if (!eventRegistry.countsByPayloadField) {
    // Older core: the card renders empty rather than the whole read failing.
    logger?.info?.('live: core has no countsByPayloadField — UTM breakdown unavailable')
    return { window: w && WINDOWS[w] ? w : '30m', sessions: 0, direct: 0, source: [], medium: [], campaign: [] }
  }

  const [source, medium, campaign, sessions] = await Promise.all([
    ...UTM_FIELDS.map(field =>
      eventRegistry.countsByPayloadField({ since: from, type: 'session.started', field, limit })
        // Logged, not silently swallowed: a bare `catch(() => [])` here turned a
        // real SQL failure into an empty card that looked like "no campaigns
        // yet", and cost far more to find than the card was worth.
        .catch(err => { logger?.warn?.({ err, field }, 'live: utm breakdown failed'); return [] })),
    eventRegistry.countsByType({ since: from })
      .then(rows => rows.filter(r => r.type === 'session.started').reduce((a, r) => a + r.count, 0))
      .catch(() => 0),
  ])

  // Sessions with no utm_source at all. Reported explicitly because a campaign
  // list that silently omits them makes paid traffic look like all of it.
  const attributed = source.reduce((a, r) => a + r.count, 0)
  return {
    window: w && WINDOWS[w] ? w : '30m',
    sessions,
    direct: Math.max(0, sessions - attributed),
    source, medium, campaign,
  }
}

// What content people actually consumed — video watched, text read, images seen.
//
// Grouped from `awareness.recorded`'s own `source` field, which is where the
// engagement plugin already records the kind ('video' | 'text' | 'image' |
// 'section' | 'link'). Deliberately NOT a set of new engagement.* event types:
// awareness.recorded already fires for each of these touches, so a second event
// per touch would double every one of them in the traffic totals above — the
// exact inflation this module's own comments warn about.
// `source` is NOT a content-kind enum — it's whatever the producing plugin put
// there. Engagement writes the kind ('video'), conversions writes 'conversion',
// CRM writes its own source name ('acuity', 'live-smoke-test'). Grouping by it
// unfiltered gave a card titled "Content consumed" listing plugin names, which
// is worse than showing nothing.
//
// So: an allow-list of the kinds the engagement plugin actually produces. The
// vocabulary belongs to that plugin (see its events.js `kind` enum), and this
// card is specifically about content a person consumed — not about every touch
// that happens to have a source.
const CONTENT_KINDS = ['video', 'text', 'image', 'section', 'link']

export async function content({ window: w, limit = 10 } = {}) {
  const secs = parseWindow(w)
  const empty = { window: w && WINDOWS[w] ? w : '30m', kinds: [], total: 0 }

  if (!eventRegistry.countsByPayloadField) {
    logger?.info?.('live: core has no countsByPayloadField — content breakdown unavailable')
    return empty
  }

  const all = await eventRegistry
    // Ask for more than `limit` before filtering, or a busy CRM source could
    // push every real content kind out of the top N and empty the card.
    .countsByPayloadField({ since: since(secs), type: 'awareness.recorded', field: 'source', limit: 100 })
    .catch(err => { logger?.warn?.({ err }, 'live: content breakdown failed'); return [] })

  // The allow-list stays even though core now stamps `plugin` on the payload:
  // countsByPayloadField groups by ONE field, so filtering on plugin while
  // grouping by source would need a second dimension it doesn't take. The kinds
  // are a small fixed vocabulary, so this is the cheaper half of that trade —
  // and it keeps working against a core that predates the `plugin` stamp.
  const kinds = all
    .filter(r => CONTENT_KINDS.includes(String(r.value).toLowerCase()))
    .slice(0, Math.max(1, Math.floor(Number(limit) || 10)))

  return {
    window: empty.window,
    kinds,
    total: kinds.reduce((a, r) => a + r.count, 0),
  }
}

/** The per-minute strip behind the header. */
// Bucket sizes are snapped to this ladder rather than taken as an arbitrary
// quotient: the size is shown to the operator, and "15s"/"15m" are legible where
// "17s"/"13.4m" are not. 5s floor — below that the strip is mostly quantisation
// noise; 2h ceiling covers the longest window at the narrowest plot.
const BUCKET_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]

// How many bars the caller can actually draw. Resolution is a property of the
// VIEWPORT, not of the data: the same 30 minutes wants ~30 bars in a narrow side
// panel and ~140 across a full-bleed board, and a fixed guess is wrong on one of
// them — too few gives fat floating blocks, too many gives sub-pixel slivers.
// Clamped because it arrives from a query string: never trust it to size a scan.
const MIN_POINTS = 12
const MAX_POINTS = 600
const DEFAULT_POINTS = 120

export async function timeseries({ window: w, points, dir, chan, passport } = {}) {
  const secs = parseWindow(w)
  const filter = makeFilter({ dir, chan })
  const wanted = Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.floor(Number(points) || DEFAULT_POINTS)))
  // Smallest step that fits the request — so the client gets at most `wanted`
  // bars, at the finest readable granularity that satisfies it.
  const bucketSeconds = BUCKET_STEPS.find(s => secs / s <= wanted) ?? BUCKET_STEPS[BUCKET_STEPS.length - 1]
  const from = since(secs)
  const rows = await eventRegistry.series({ since: from, bucketSeconds, passportId: passport || null })

  // Pre-seed EVERY bucket in the window at zero. The query only returns buckets
  // that had events, so without this a quiet window renders as a handful of bars
  // stretched across the full width — three events in three different minutes
  // became three fat bars instead of three blips on a mostly-empty 30-minute
  // strip, which reads as "lots of traffic" at a glance. It also defeats the
  // stated intent right above: a consistent shape whatever the window.
  //
  // Aligned with floor(epoch / bucketSeconds) * bucketSeconds — exactly how the
  // SQL buckets in core's series() — so the keys collide instead of doubling up.
  const align = (ms) => Math.floor(ms / 1000 / bucketSeconds) * bucketSeconds
  const blank = (key) => ({ bucket: key, in: 0, out: 0, internal: 0, unknown: 0 })
  const buckets = new Map()
  for (let e = align(from.getTime()); e <= align(Date.now()); e += bucketSeconds) {
    const key = new Date(e * 1000).toISOString()
    buckets.set(key, blank(key))
  }

  for (const row of rows) {
    const { bucket, type, count } = row
    const key = new Date(bucket).toISOString()
    // A row just outside the seeded range (clock skew, a bucket that ticked over
    // mid-query) still gets counted rather than silently dropped.
    if (!buckets.has(key)) buckets.set(key, blank(key))
    // Same recorded-facet classification AND the same filter as summary(), so the
    // strip and the cards above it can't tell different stories about the same
    // window. A filtered-out row leaves its bucket seeded at zero rather than
    // vanishing, which is what keeps the strip's shape stable while you narrow.
    const payload = facetPayload(row)
    if (!filter.passes(type, payload)) continue
    buckets.get(key)[direction(type, payload)] += count
  }

  // Chronological: seeded keys are already in order, but a late-added edge row
  // would otherwise land at the end and draw out of sequence.
  const ordered = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
  return { window: w && WINDOWS[w] ? w : '30m', bucket_seconds: bucketSeconds, buckets: ordered }
}

/**
 * Backfill for the feed. The dashboard opens with this so a quiet system reads
 * as "measured, nothing happening" rather than as a broken pipe.
 */
export async function recent({ limit = 100, window: w, passport } = {}) {
  const from = since(parseWindow(w))
  // Scoped at the query when a passport is selected — not by filtering the page
  // afterwards. Someone with three events in a busy window would otherwise get
  // three rows out of the most recent hundred and look like they had gone quiet.
  const rows = await eventRegistry.recent({
    limit: Math.min(Number(limit) || 100, 500),
    passportId: passport || null,
  })
  // Windowed like every other read on this board. Without it the feed showed
  // 24h of rows under a "30m" selector, directly contradicting a strip that
  // said "no traffic in this window" — two panels disagreeing about what
  // you're looking at.
  return rows.filter(r => new Date(r.occurred_at) >= from).map(toFeedRow)
}

// One shape for a feed row, used by BOTH the backfill above and the live stream
// — so a replayed event and a streamed one are indistinguishable in the UI.
export function toFeedRow(row) {
  const type = row.type
  const payload = row.data
  return {
    id: row.id,
    type,
    at: row.occurred_at ?? new Date().toISOString(),
    direction: direction(type, payload),
    channel: channel(type, payload),
    // What the event was about, in one line — computed HERE so the backfill and
    // the socket stream can't describe the same event two different ways.
    detail: describe(type, payload),
    passport_id: row.passport_id ?? payload?.data?.passport_id ?? null,
    // The raw payload is deliberately NOT carried. Nothing rendered it, yet it
    // was half the weight of every feed row — on a 500-row buffer that's ~170KB
    // of retained objects in the browser, and it shipped again on every socket
    // frame. `detail` is the distilled form the UI actually shows.
    //
    // If a payload inspector is ever wanted, it needs a route of its own with a
    // deliberate answer to "which fields may a browser see" — NOT a passthrough of
    // core's /internal/events/log, which serves payloads verbatim behind a static
    // machine token precisely because it is not browser-facing. A scrubber for this
    // used to live in this package (src/project.js) and was removed: a hand-kept
    // list of other plugins' column names drifted behind them, missing mail's
    // `body_html` and voip's `link`. Whatever replaces it should read a declaration
    // from the plugins that own those fields, the way direction/channel/detail
    // already do (server/src/event-catalog.js).
  }
}
