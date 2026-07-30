// Live dashboard state. Two sources that must agree:
//   · REST   — the aggregates and the backfill, fetched per window
//   · socket — new events as they happen, appended to the same feed
//
// The backfill matters more than it looks: without it a quiet system is
// indistinguishable from a broken one, and "is it broken?" is the entire question
// this module exists to answer.
import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch } from 'vue'
import {
  liveClient as client,
  type FeedEvent, type Summary, type Series, type WindowKey, type Utm, type Content,
} from '../live'
import { connectLive } from '../realtime'
import { notifyError } from '../../../shell/toast'
import { useAuthStore } from '../../../shell/stores/auth'

// Bounded on purpose, and the UI SAYS it's bounded — silently dropping the tail
// would make a busy system look calm.
//
// 300, not 500. Two costs grow with this number and only one is obvious:
//   · retained objects — ~110 bytes/row since feed rows stopped carrying the raw
//     payload (it was half their weight and nothing rendered it)
//   · DOM nodes — the feed is NOT virtualised, so every row is a real <li> with
//     several grid cells. 500 rows is ~3000 elements re-laid-out on each flush,
//     and that, not memory, is what makes a busy board feel sluggish.
// The filters below are the real answer to "too much"; this only stops an
// unattended tab growing without limit.
//
// Nothing else accumulates: while paused, arriving events are counted into
// `overflowed` and dropped rather than buffered, so a paused tab is flat.
const MAX_FEED = 300

export const useLiveStore = defineStore('live', () => {
  const window = ref<WindowKey>('30m')
  const summary = ref<Summary | null>(null)
  const series = ref<Series | null>(null)
  const utm = ref<Utm | null>(null)
  const content = ref<Content | null>(null)
  // shallowRef: the feed is replaced wholesale on every flush, and deep
  // reactivity over hundreds of event objects is pure overhead.
  const feed = shallowRef<FeedEvent[]>([])
  const loading = ref(false)
  const connected = ref(false)
  const paused = ref(false)
  const dropped = ref(0)
  const overflowed = ref(0)

  let detach: (() => void) | null = null
  let poll: any = null

  // ── feed filters ─────────────────────────────────────────────────────────
  //
  // Each axis is TRI-STATE per value: neutral / include / exclude. An
  // include-only model can't express "everything except adnetwork" — the common
  // case when one chatty channel is drowning the feed — and including the other
  // five instead breaks the moment a sixth appears.
  //
  // Combination rules, the standard faceted ones:
  //   · any exclude on a value       ⇒ that value never matches (exclude wins)
  //   · at least one include on axis ⇒ only included values match
  //   · no include on the axis       ⇒ every non-excluded value matches
  //
  // Exclude beating include matters for the text box, where `mail -bounced` has to
  // mean "mail, but not bounced" rather than an unresolvable contradiction.
  //
  // Default is `internal: exclude` — orchestration is real and worth seeing, but
  // letting it lead buried the in/out rows under a column of identical "·" glyphs.
  // Note this is an EXCLUDE rather than "include in+out": it leaves in/out
  // unconstrained, so a new direction shows up by default instead of being
  // silently omitted by a whitelist nobody remembered to update.
  type Mode = 'include' | 'exclude'
  const feedQuery = ref('')
  const feedDirModes = ref<Map<string, Mode>>(new Map([['internal', 'exclude']]))
  const feedChanModes = ref<Map<string, Mode>>(new Map())

  function axisMatch(value: string, modes: Map<string, Mode>) {
    if (modes.get(value) === 'exclude') return false
    let hasInclude = false
    for (const m of modes.values()) if (m === 'include') { hasInclude = true; break }
    return !hasInclude || modes.get(value) === 'include'
  }

  // `foo` requires, `-foo` forbids. Whitespace-separated so several compose,
  // matched over type + detail + passport id — the three things you'd search for.
  function matchesText(e: FeedEvent, q: string) {
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(t => t && t !== '-')
    if (!tokens.length) return true
    const hay = `${e.type} ${e.detail || ''} ${e.passport_id || ''}`.toLowerCase()
    for (const t of tokens) {
      if (t.startsWith('-')) { if (hay.includes(t.slice(1))) return false }
      else if (!hay.includes(t)) return false
    }
    return true
  }

  const visibleFeed = computed(() => feed.value.filter(e =>
    axisMatch(e.direction, feedDirModes.value) &&
    axisMatch(e.channel, feedChanModes.value) &&
    matchesText(e, feedQuery.value)))

  // From the SERVER's facet counts (`summary.axes`), not from the feed rows.
  //
  // Deriving them from the feed had two failure modes and the Channel list showed
  // both: an empty list on a quiet window, because the feed holds nothing even when
  // the window had traffic it has already evicted; and a capped list on a busy one,
  // since the feed keeps at most MAX_FEED rows. Now that the filters narrow the
  // whole board, the options have to come from the same place the board's numbers
  // do.
  //
  // Each axis is counted with its own filter left out (see the server's `axes`), so
  // an option you switched off still shows what it would contribute and can be
  // switched back on — the thing a naively-narrowed count destroys.
  const directionCounts = computed<Record<string, number>>(() =>
    summary.value?.axes?.direction ?? { in: 0, out: 0, internal: 0, unknown: 0 })

  // Busiest first, plus any explicitly excluded so a row you switched off doesn't
  // vanish from the list you'd use to switch it back on.
  const channelCounts = computed(() => {
    const tally = new Map<string, number>(Object.entries(summary.value?.axes?.channel ?? {}))
    for (const [c, m] of feedChanModes.value) if (m && !tally.has(c)) tally.set(c, 0)
    return [...tally.entries()]
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel))
  })

  // The filters as the SERVER takes them. They started as a feed-only, client-side
  // narrowing of one list; now they narrow the whole board, which means the
  // aggregates have to be re-fetched with them because those are computed
  // server-side (see server-plugin-live's makeFilter).
  //
  // Same tri-state, one token list per axis, `-` prefixed to exclude — so nothing is
  // translated between the two ends and they cannot disagree about what a filter
  // means. `internal: exclude` by default therefore sends `dir=-internal`.
  const encodeAxis = (modes: Map<string, Mode>) =>
    [...modes.entries()].map(([k, m]) => (m === 'exclude' ? `-${k}` : k)).join(',')

  const boardFilter = computed(() => ({
    dir: encodeAxis(feedDirModes.value),
    chan: encodeAxis(feedChanModes.value),
  }))

  const DEFAULT_DIR: [string, Mode][] = [['internal', 'exclude']]
  const feedFiltered = computed(() => Boolean(feedQuery.value.trim())
    || feedChanModes.value.size > 0
    || feedDirModes.value.size !== 1
    || feedDirModes.value.get('internal') !== 'exclude')
  const hiddenByFilter = computed(() => feed.value.length - visibleFeed.value.length)

  // neutral → include → exclude → neutral. One control, three states, no modifier
  // keys: a shift-click affordance is invisible, and this is a view people open
  // when something is already going wrong.
  function cycle(modes: Map<string, Mode>, key: string) {
    const next = new Map(modes)
    const now = next.get(key)
    if (!now) next.set(key, 'include')
    else if (now === 'include') next.set(key, 'exclude')
    else next.delete(key)
    return next
  }
  function toggleDirection(d: string) { feedDirModes.value = cycle(feedDirModes.value, d) }
  function toggleChannel(c: string) { feedChanModes.value = cycle(feedChanModes.value, c) }

  // ── binary view of the same state, for the pane's checkbox lists ───────────
  //
  // A checkbox has two states and the model has three, so the mapping is: checked
  // means "not excluded". Unchecking writes an EXCLUDE rather than rewriting the
  // axis as an include-list of everything still ticked — which matters, because an
  // include-list is a whitelist: a channel that first appears tomorrow would be
  // silently filtered out of a board someone ticked today. Excludes name only what
  // you turned off, so anything new shows up by default.
  const axisOn = (modes: Map<string, Mode>, key: string) => modes.get(key) !== 'exclude'

  function setAxis(modes: Map<string, Mode>, key: string, on: boolean) {
    const next = new Map(modes)
    if (on) next.delete(key)
    else next.set(key, 'exclude')
    return next
  }
  const isDirOn = (d: string) => axisOn(feedDirModes.value, d)
  const isChanOn = (c: string) => axisOn(feedChanModes.value, c)
  function setDirection(d: string, on: boolean) { feedDirModes.value = setAxis(feedDirModes.value, d, on) }
  function setChannel(c: string, on: boolean) { feedChanModes.value = setAxis(feedChanModes.value, c, on) }

  // A filter change now has to REFETCH, because it narrows server-computed
  // aggregates as well as the client-held feed. Watching the encoded strings rather
  // than the Maps: `cycle()` replaces the Map wholesale, so a Map watcher fires even
  // when the resulting filter is identical (neutral → include → exclude → neutral
  // lands back where it started), and each of those would be a wasted round trip.
  //
  // The feed itself stays instant — it is filtered locally from rows already in
  // hand, so narrowing feels immediate while the cards catch up on the next tick.
  watch(() => `${boardFilter.value.dir}|${boardFilter.value.chan}`, () => {
    if (summary.value) refreshAggregates()
  })
  function clearFeedFilters() {
    feedQuery.value = ''
    feedChanModes.value = new Map()
    feedDirModes.value = new Map(DEFAULT_DIR)
  }

  // ── list vs count ────────────────────────────────────────────────────────
  //
  // The feed answers "what just happened"; the count answers "what keeps
  // happening". Same events, same filters, two questions — so it's a view toggle
  // on one dataset rather than a second panel.
  const feedView = ref<'list' | 'count'>('list')

  // Aggregated by type, ordered MOST-RECENTLY-INCREMENTED first, so a type that
  // just ticked rises to the top and a busy-but-idle one sinks.
  //
  // No timestamps and no sort needed: `visibleFeed` is already newest-first, so
  // the first time a type is encountered walking it IS that type's latest
  // occurrence. Collecting types in first-encounter order therefore gives exactly
  // the required ordering for free — and it's stable, where sorting on equal
  // counts would let rows swap places on every refresh for no reason.
  const feedCounts = computed(() => {
    const seen = new Map<string, { type: string; count: number; at: string; direction: string; channel: string }>()
    for (const e of visibleFeed.value) {
      const row = seen.get(e.type)
      if (row) row.count++
      else seen.set(e.type, { type: e.type, count: 1, at: e.at, direction: e.direction, channel: e.channel })
    }
    return [...seen.values()]
  })

  // Anything a plugin flagged `severity: 'bad'` and that is non-zero. The board no
  // longer knows that mail has `failed` or voip has `missed` — each plugin says
  // which of its own numbers is bad news (docs/10-plugin-status.md) and this just
  // believes it. That's why a new channel's failures reach the header without this
  // file changing.
  const failing = computed(() => {
    const bad = (summary.value?.status || []).flatMap(p =>
      p.metrics.filter(m => m.severity === 'bad' && m.value > 0)
        .map(m => ({ label: p.label, key: m.key, value: m.value })))
    if (!bad.length) return null
    return { items: bad, total: bad.reduce((a, b) => a + b.value, 0) }
  })

  // ── pinned counters ──────────────────────────────────────────────────────
  //
  // Which of the ~65 counters every plugin reports get promoted to the header.
  // Identified by `module:key`, because `failed` alone is ambiguous across mail,
  // sms, journeys and conversions.
  //
  // Persisted: this is a choice someone makes once about what they watch, and
  // re-picking it on every reload would make the feature not worth using. Kept in
  // localStorage rather than on the server because it is per-person-per-browser
  // and carries nothing worth a migration.
  //
  // The defaults are exactly the five figures the header showed when they were
  // hard-coded, so an existing user sees no change until they choose one.
  const PINNED_KEY = 'wb.live.pinned'
  const DEFAULT_PINNED = ['live:events/min', 'live:in', 'live:out', 'live:internal', 'live:people active']

  function loadPinned(): string[] {
    try {
      const raw = localStorage.getItem(PINNED_KEY)
      if (!raw) return [...DEFAULT_PINNED]
      const parsed = JSON.parse(raw)
      // An empty array is a real choice ("show me nothing"), so it is honoured —
      // only a corrupt or wrong-shaped value falls back to the defaults.
      return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [...DEFAULT_PINNED]
    } catch { return [...DEFAULT_PINNED] }
  }

  // An ARRAY, not a Set: the order someone pinned things in is the order they
  // want to read them, and it survives a reload. A Set would also work for
  // membership but would leave the header's order at the mercy of whatever order
  // the plugins happen to report in.
  const pinned = ref<string[]>(loadPinned())

  function persistPinned() {
    // A private-mode or quota failure must not break the board — the choice just
    // won't outlive the tab.
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(pinned.value)) } catch { }
  }

  function togglePinned(id: string) {
    const i = pinned.value.indexOf(id)
    if (i === -1) pinned.value = [...pinned.value, id]
    else pinned.value = pinned.value.filter(x => x !== id)
    persistPinned()
  }

  function resetPinned() { pinned.value = [...DEFAULT_PINNED]; persistPinned() }

  const isPinned = (id: string) => pinned.value.includes(id)

  // Resolved against the current summary, in PINNED order. A pin whose plugin has
  // stopped reporting is skipped rather than rendered as a zero — the same rule the
  // Status card follows, because absent and zero are different claims.
  type PinnedFig = { module: string; owner: string | null; key: string; text: string; bad: boolean }
  const pinnedFigs = computed(() => {
    const byId = new Map<string, PinnedFig>()
    for (const p of summary.value?.status || []) {
      for (const m of p.metrics) {
        byId.set(`${p.module}:${m.key}`, {
          module: p.module,
          // Who to name in the header, or null for nobody.
          //
          // live's counters are the whole system's — `events/min`, `in`, `out`,
          // `people active` are properties of the traffic itself, and qualifying
          // them read as "LIVE" repeated across the row for no information.
          // A PLUGIN's number does need its owner: `failed` alone is ambiguous
          // across mail, sms, journeys and conversions.
          owner: p.module === 'live' ? null : p.label,
          key: m.key,
          text: m.of === undefined ? String(m.value) : `${m.value}/${m.of}`,
          bad: m.severity === 'bad' && m.value > 0,
        })
      }
    }
    return pinned.value.map(id => byId.get(id)).filter(Boolean) as PinnedFig[]
  })

  // How many bars the strip can draw, measured by the component itself (see
  // TrafficStrip's ResizeObserver). Null until it has been laid out once, so the
  // first fetch doesn't wait on a measurement.
  //
  // Resolution follows the container, so a resize has to refetch — but only when
  // the answer actually changes. TrafficStrip already quantises what it reports;
  // this guard is what stops an unchanged value queueing a redundant request.
  const points = ref<number | null>(null)
  function setPoints(n: number) {
    if (points.value === n) return
    points.value = n
    // Nothing to refine until the first load has happened.
    if (series.value) refreshAggregates()
  }

  async function load() {
    loading.value = true
    try {
      const [s, t, u, c, r] = await Promise.all([
        client.summary(window.value, boardFilter.value),
        client.timeseries(window.value, points.value ?? undefined, boardFilter.value),
        client.utm(window.value),
        client.content(window.value),
        // Backfill deliberately smaller than MAX_FEED, so live events have room to
        // arrive without immediately evicting the history we just fetched.
        client.recent(window.value, Math.round(MAX_FEED * 0.6)),
      ])
      summary.value = s; series.value = t; utm.value = u; content.value = c; feed.value = r.events
    } catch (e: any) {
      notifyError(`Couldn't load the live view: ${e.message}`)
    } finally {
      loading.value = false
    }
  }

  function setWindow(w: WindowKey) { window.value = w; return load() }

  function start() {
    const auth = useAuthStore()
    detach?.()
    detach = connectLive(auth.accessToken || '', (events, drop) => {
      if (drop) dropped.value += drop
      // Paused means the operator is reading something; new events keep arriving
      // into the counter but must not move the rows under them.
      if (paused.value) { overflowed.value += events.length; return }
      const next = [...events.reverse(), ...feed.value]
      if (next.length > MAX_FEED) next.length = MAX_FEED
      feed.value = next
    }, (c) => { connected.value = c })

    // The aggregates aren't pushed — they're windowed queries — so they refresh on
    // a timer. Slower than the feed on purpose: a rate that jitters every 250ms is
    // unreadable.
    clearInterval(poll)
    poll = setInterval(() => { if (!paused.value) refreshAggregates() }, 10_000)
  }

  async function refreshAggregates() {
    try {
      const [s, t, u, c] = await Promise.all([
        client.summary(window.value, boardFilter.value),
        client.timeseries(window.value, points.value ?? undefined, boardFilter.value),
        client.utm(window.value),
        client.content(window.value),
      ])
      summary.value = s; series.value = t; utm.value = u; content.value = c
    } catch { /* a failed refresh keeps the last good numbers rather than blanking them */ }
  }

  function stop() { detach?.(); detach = null; clearInterval(poll); poll = null }

  function togglePause() {
    paused.value = !paused.value
    if (!paused.value) { overflowed.value = 0; load() }   // catch up on resume
  }

  return {
    window, summary, series, utm, content, feed, visibleFeed,
    feedQuery, feedDirModes, feedChanModes, directionCounts, channelCounts,
    feedView, feedCounts,
    feedFiltered, hiddenByFilter, toggleDirection, toggleChannel, clearFeedFilters,
    isDirOn, isChanOn, setDirection, setChannel,
    loading, connected, paused, dropped, overflowed,
    failing, maxFeed: MAX_FEED,
    pinned, pinnedFigs, isPinned, togglePinned, resetPinned,
    load, setWindow, start, stop, togglePause, refreshAggregates, setPoints,
  }
})
