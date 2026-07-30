<script setup lang="ts">
// Live — a system-monitoring dashboard, and the one module that is NOT the
// app's three-pane grammar.
//
// That grammar is rail-of-subjects / the-selected-one / actions-on-it. A
// firehose has no subject: its value is the aggregate. Forcing a fake one would
// make the module open blank and read as broken, so it's a full-bleed board of
// cards instead — the layout differs, the design language doesn't (.blk-head
// titles, .bs-num/.bs-lbl stats, count-dot, the same type scale).
//
// It is read-only by construction: one permission, no writes, no actions.
import { onActivated, onDeactivated, computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useLiveStore } from './stores/live'
import { DIRECTION_GLYPH, DIRECTION_COLOR, type Direction, type WindowKey } from './live'
import FilterMenu from '../../components/FilterMenu.vue'
import TrafficStrip from './components/TrafficStrip.vue'
import './live.css'

const store = useLiveStore()
const { summary, series, utm, content, feed, visibleFeed, feedQuery, feedDirModes,
  feedChanModes, directionCounts, channelCounts, feedFiltered, hiddenByFilter,
  feedView, feedCounts,
  connected, paused, dropped, overflowed, failing } = storeToRefs(store)

const WINDOWS: WindowKey[] = ['5m', '30m', '1h', '24h']

onActivated(() => { store.load(); store.start() })
onDeactivated(() => store.stop())

// Channels split by which way they carry data, so the two cards answer
// "what's arriving" and "what are we sending" rather than one merged list that
// answers neither.
// Keys must match what the API reports, which for everything except awareness is
// the event type's first segment (classify.js `channel()` → type.split('.')[0]).
// So it's `conversion`, SINGULAR — the plugin emits `conversion.${name}`. The
// plural spelling here silently dropped every conversion from this card, because
// rank() filters out keys the summary doesn't contain.
const IN_CHANNELS = ['session', 'passport', 'web', 'crm', 'conversion', 'engagement', 'shortener', 'voip']
const inChannels = computed(() => rank(IN_CHANNELS))
// `adnetwork` belongs here: a server-to-server CAPI call to Meta/TikTok is data
// leaving us. Omitting it made "Going out" read "Nothing sent in this window"
// while fourteen adnetwork.accepted events sat in the feed's count view —
// this list and classify.js's out-set have to agree, or the card contradicts
// the board.
const outChannels = computed(() => rank(['mail', 'sms', 'adnetwork', 'webhook']))
function rank(keys: string[]) {
  const by = summary.value?.by_channel || {}
  const rows = keys.filter(k => by[k]).map(k => ({ key: k, count: by[k] }))
  const max = Math.max(1, ...rows.map(r => r.count))
  return rows.sort((a, b) => b.count - a.count).map(r => ({ ...r, pct: Math.round((r.count / max) * 100) }))
}

// Which UTM dimension the card is showing. One card with a switch rather than
// three cards: they answer the same question at different depths, and three
// side-by-side lists of mostly the same campaigns reads as noise.
const UTM_DIMS = [
  { key: 'source' as const, label: 'source' },
  { key: 'medium' as const, label: 'medium' },
  { key: 'campaign' as const, label: 'campaign' },
]
const utmDim = ref<'source' | 'medium' | 'campaign'>('source')

// Percentages are of SESSIONS, not of the attributed subset — otherwise a single
// campaign with two sessions reads as 100% of traffic.
const utmRows = computed(() => {
  const rows = utm.value?.[utmDim.value] || []
  const total = Math.max(1, utm.value?.sessions || 0)
  return rows.map(r => ({ ...r, pct: Math.round((r.count / total) * 100) }))
})

// Percent of consumed content, not of all traffic — this card answers "what are
// people actually looking at", so the denominator is the content itself.
const contentRows = computed(() => {
  const rows = content.value?.kinds || []
  const total = Math.max(1, content.value?.total || 0)
  return rows.map(r => ({ ...r, pct: Math.round((r.count / total) * 100) }))
})

// in/out/internal always offered; `unknown` only when there is one to look at.
const directionChips = computed(() => {
  const base: Direction[] = ['in', 'out', 'internal']
  return (directionCounts.value.unknown || feedDirModes.value.has('unknown'))
    ? [...base, 'unknown' as Direction]
    : base
})

// One helper for both axes, so the chips can't drift apart in how they read.
// `title` spells the cycle out because a tri-state control has no conventional
// affordance — the next state has to be discoverable without experimenting.
function chipState(modes: Map<string, string>, key: string) {
  const m = modes.get(key)
  return {
    on: m === 'include',
    off: m === 'exclude',
    title: m === 'include' ? `Only ${key} — click to exclude it`
      : m === 'exclude' ? `Excluding ${key} — click to clear`
      : `Click to show only ${key}`,
  }
}

// Shaped for FilterMenu: groups of { value, label, count }. Channels come from
// the window rather than a fixed list, so this is a computed, not a constant.
const filterGroups = computed(() => {
  const groups = [{
    label: 'Direction',
    items: directionChips.value.map(d => ({
      value: d, label: `${DIRECTION_GLYPH[d]} ${d}`, count: directionCounts.value[d] ?? 0,
    })),
  }]
  if (channelCounts.value.length) {
    groups.push({
      label: 'Channel',
      items: channelCounts.value.map(c => ({ value: c.channel, label: c.channel, count: c.count })),
    })
  }
  return groups
})

// FilterMenu takes a plain object, not a Map — one object covering both axes,
// since values can't collide (a direction is never a channel name).
const filterModes = computed(() => ({
  ...Object.fromEntries(feedDirModes.value),
  ...Object.fromEntries(feedChanModes.value),
}))

// Which axis a value belongs to, so one `toggle` event reaches the right store
// action. Direction is the closed set; anything else is a channel.
function onToggle(value: string) {
  if (directionChips.value.includes(value as any)) store.toggleDirection(value)
  else store.toggleChannel(value)
}

// A summary for the button's tooltip: with an icon-only control the dot says
// "narrowed" but not how, and this is the only place that can.
const filterSummary = computed(() => {
  const parts: string[] = []
  const say = (modes: Map<string, string>, kind: string) => {
    const inc = [...modes.entries()].filter(([, m]) => m === 'include').map(([k]) => k)
    const exc = [...modes.entries()].filter(([, m]) => m === 'exclude').map(([k]) => k)
    if (inc.length) parts.push(`${kind}: only ${inc.join(', ')}`)
    if (exc.length) parts.push(`${kind}: not ${exc.join(', ')}`)
  }
  say(feedDirModes.value as any, 'direction')
  say(feedChanModes.value as any, 'channel')
  if (feedQuery.value.trim()) parts.push(`matching "${feedQuery.value.trim()}"`)
  // Only describe a filter the OPERATOR set. At rest the board excludes
  // `internal` by default, and narrating that here made the tooltip claim a
  // filter was active while the dot — which tracks deviation from the default —
  // correctly said otherwise. Two readouts of the same thing must agree.
  if (!feedFiltered.value) return 'Filter the feed'
  return parts.length ? parts.join(' · ') : 'Filter the feed'
})

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString()

// An empty window is ambiguous — nothing happening and nothing WORKING look
// identical as a row of zeros. Saying when anything last happened resolves it,
// and points at the window that would show it.
const quietFor = computed(() => {
  const s = summary.value
  if (!s || s.total > 0) return null
  if (!s.last_event_at) return 'No events have ever been recorded.'
  const mins = Math.round((Date.now() - new Date(s.last_event_at).getTime()) / 60000)
  if (mins < 1) return 'Nothing in this window — but something just happened; give it a moment.'
  const ago = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`
  return `Nothing in the last ${store.window} — last activity ${ago} ago.`
})
const short = (id: string | null) => (id ? id.slice(0, 8) : '')
</script>

<template>
  <div class="live-board">
    <!-- ── header: the pulse ─────────────────────────────────────────────
         Figures, not charts: each of these is a single current value, and a
         chart of one number is decoration. -->
    <header class="lv-head">
      <!-- ONE LINE, every value inline on a shared baseline at ONE size. Two
           earlier attempts were worse: stacking number-over-label aligned
           cleanly but doubled the header's height (vertical space is the scarce
           resource here — six cards and a feed sit below), and sizing
           events/min larger than the rest made the row read as a headline with
           footnotes rather than one set of stats. Equal sizes also mean the
           shared baseline genuinely lines everything up, which a 34px figure
           beside 11px text never did.
           People-active sits here rather than in a card: it's a pulse reading,
           and it was the one headline number you had to scroll past six cards
           to find. -->
      <div class="lv-pulse">
        <span class="lv-fig"><b>{{ summary?.per_minute ?? '—' }}</b> events/min</span>
        <span class="lv-fig dir" :style="{ '--c': DIRECTION_COLOR.in }">
          <b>{{ summary?.by_direction?.in ?? 0 }}</b> {{ DIRECTION_GLYPH.in }} in
        </span>
        <span class="lv-fig dir" :style="{ '--c': DIRECTION_COLOR.out }">
          <b>{{ summary?.by_direction?.out ?? 0 }}</b> {{ DIRECTION_GLYPH.out }} out
        </span>
        <!-- orchestration is deliberately NOT a third band in the chart and not a
             coloured series: it isn't traffic, and counting it as either
             direction would inflate the figures beside it -->
        <span class="lv-fig dim"><b>{{ summary?.by_direction?.internal ?? 0 }}</b> internal</span>
        <span class="lv-fig" title="Distinct people touched in this window. Events about the system rather than a person aren't counted.">
          <b>{{ summary?.active_passports ?? 0 }}</b> people active
        </span>

        <!-- Says why the figures are zeros — "quiet" and "broken" look identical
             otherwise. Alongside them, never replacing them. -->
        <span v-if="quietFor" class="lv-quiet">{{ quietFor }}</span>
      </div>

      <div class="lv-controls">
        <!-- Connection status belongs with the controls, not at the head of the
             figures: it describes the TRANSPORT, not the data, and it sat at the
             head of them competing for the leading position while reading as a
             stray 10px label. Next to Pause it's grouped with the
             other thing that governs whether the feed is moving. -->
        <span class="lv-live" :class="{ off: !connected }">
          <i class="count-dot" :class="{ zero: !connected }" /> {{ connected ? 'live' : 'reconnecting' }}
        </span>
        <div class="lv-seg">
          <button v-for="w in WINDOWS" :key="w" type="button" class="lv-win"
            :class="{ on: store.window === w }" @click="store.setWindow(w)">{{ w }}</button>
        </div>
        <!-- Icon-only, the same 30px bordered square as People's search filter
             (.icon-btn in style.css). Paused is the non-default state, so it
             takes the `on` treatment; the dot says events are stacking up
             behind it, which a bare icon otherwise couldn't tell you. -->
        <button type="button" class="icon-btn" :class="{ on: paused }"
          :aria-label="paused ? `Resume the feed${overflowed ? ` — ${overflowed} events buffered` : ''}` : 'Pause the feed'"
          :title="paused ? `Resume${overflowed ? ` — ${overflowed} buffered` : ''}` : 'Pause'"
          @click="store.togglePause()">
          <span class="material-symbols-outlined">{{ paused ? 'play_arrow' : 'pause' }}</span>
          <i v-if="paused && overflowed" class="icon-dot" />
        </button>
      </div>
    </header>

    <!-- the only chart: counts per bucket over the window, in vs out -->
    <section class="lv-card lv-strip">
      <TrafficStrip :series="series" @resolution="store.setPoints" />
    </section>

    <div class="lv-grid">
      <section class="lv-card">
        <div class="blk-head"><span :style="{ color: DIRECTION_COLOR.in }">{{ DIRECTION_GLYPH.in }}</span> Coming in</div>
        <ul class="lv-bars">
          <li v-for="c in inChannels" :key="c.key" class="lv-bar">
            <span class="lv-bar-k">{{ c.key }}</span>
            <span class="lv-bar-track"><i :style="{ width: c.pct + '%', background: DIRECTION_COLOR.in }" /></span>
            <span class="lv-bar-n">{{ c.count }}</span>
          </li>
          <li v-if="!inChannels.length" class="lv-empty">Nothing arrived in this window.</li>
        </ul>
      </section>

      <section class="lv-card">
        <div class="blk-head"><span :style="{ color: DIRECTION_COLOR.out }">{{ DIRECTION_GLYPH.out }}</span> Going out</div>
        <ul class="lv-bars">
          <li v-for="c in outChannels" :key="c.key" class="lv-bar">
            <span class="lv-bar-k">{{ c.key }}</span>
            <span class="lv-bar-track"><i :style="{ width: c.pct + '%', background: DIRECTION_COLOR.out }" /></span>
            <span class="lv-bar-n">{{ c.count }}</span>
          </li>
          <li v-if="!outChannels.length" class="lv-empty">Nothing sent in this window.</li>
        </ul>
      </section>

      <!-- Attribution. Reads session.started's own payload, so it counts SESSIONS
           per campaign rather than events — the number a marketer actually means
           when they ask how a campaign is doing. -->
      <section class="lv-card">
        <div class="blk-head lv-utm-head">
          <span>Attribution</span>
          <div class="lv-seg">
            <button v-for="d in UTM_DIMS" :key="d.key" type="button" class="lv-win"
              :class="{ on: utmDim === d.key }" @click="utmDim = d.key">{{ d.label }}</button>
          </div>
        </div>
        <ul class="lv-bars">
          <li v-for="r in utmRows" :key="r.value" class="lv-bar">
            <span class="lv-bar-k" :title="r.value">{{ r.value }}</span>
            <span class="lv-bar-track"><i :style="{ width: r.pct + '%', background: DIRECTION_COLOR.in }" /></span>
            <span class="lv-bar-n">{{ r.count }}</span>
          </li>
          <!-- Named explicitly: a campaign list that quietly omits unattributed
               sessions makes paid traffic look like all of it. -->
          <li v-if="utm?.direct" class="lv-bar lv-utm-direct">
            <span class="lv-bar-k">direct</span>
            <span class="lv-bar-track"><i :style="{ width: Math.round((utm.direct / Math.max(1, utm.sessions)) * 100) + '%' }" /></span>
            <span class="lv-bar-n">{{ utm.direct }}</span>
          </li>
          <li v-if="!utmRows.length && !utm?.direct" class="lv-empty">No sessions started in this window.</li>
        </ul>
      </section>

      <!-- What was consumed. Grouped from awareness.recorded's own `source`, so
           a video watched and a paragraph read are one event each — no separate
           engagement.* type that would double-count every touch upstairs. -->
      <section class="lv-card">
        <div class="blk-head">Content consumed</div>
        <ul class="lv-bars">
          <li v-for="r in contentRows" :key="r.value" class="lv-bar">
            <span class="lv-bar-k" :title="r.value">{{ r.value }}</span>
            <span class="lv-bar-track"><i :style="{ width: r.pct + '%', background: DIRECTION_COLOR.in }" /></span>
            <span class="lv-bar-n">{{ r.count }}</span>
          </li>
          <li v-if="!contentRows.length" class="lv-empty">Nothing consumed in this window.</li>
        </ul>
      </section>

      <!-- STATUS: is each channel actually working. Its own card, not a row inside
           "going out": a spike in failures or an exhausted number pool is the
           reason someone opens this module, and it must not be something you go
           looking for.
           ONE generic template. There used to be a block per channel here — mail
           and sms sharing one, voip another, the number pool a third — which meant
           a new plugin needed markup nobody would remember to add. Now each plugin
           describes its own numbers (docs/10-plugin-status.md) and this lays them
           out without knowing what any of them mean. -->
      <section class="lv-card">
        <div class="blk-head">Status</div>

        <div v-for="p in (summary?.status || [])" :key="p.module" class="lv-deliv">
          <div class="lv-dl-row">
            <span class="lv-dl-ch">{{ p.label }}</span>
            <span class="lv-dl-figs">
              <!-- `severity: 'bad'` is the plugin's own call. Shown with an icon
                   and the word, never colour alone. -->
              <span v-for="m in p.metrics" :key="m.key" class="lv-dl-fig"
                :class="{ bad: m.severity === 'bad' && m.value > 0 }">
                <span v-if="m.severity === 'bad' && m.value > 0" class="material-symbols-outlined">error</span>
                <b>{{ m.value }}</b> {{ m.key }}
              </span>
            </span>
          </div>

          <!-- A bounded resource: the ratio is the point, so it gets a track
               rather than another number. -->
          <ul v-if="p.gauges.length" class="lv-pool-tags">
            <li v-for="g in p.gauges" :key="g.label" class="lv-bar">
              <span class="lv-bar-k">{{ g.label }}</span>
              <span class="lv-bar-track">
                <i :style="{ width: (g.total ? Math.round((g.used / g.total) * 100) : 0) + '%',
                             background: g.exhausted ? 'var(--danger)' : DIRECTION_COLOR.in }" />
              </span>
              <span class="lv-bar-n">{{ g.used }}/{{ g.total }}</span>
            </li>
          </ul>

          <p v-if="p.note" class="lv-fp-hint">{{ p.note }}</p>
        </div>

        <!-- Absent, not zero: no plugin reporting is a different claim from
             "everything is at zero". -->
        <p v-if="!summary?.status?.length" class="lv-empty">
          No plugin is reporting status. A plugin appears here once it exposes
          <code>status()</code>.
        </p>

        <!-- A plugin that THREW is broken, and that's urgent — distinct from one
             that simply has no status() to call. -->
        <p v-if="summary?.status_failing?.length" class="lv-note-bad">
          <span class="material-symbols-outlined">error</span>
          {{ summary.status_failing.join(', ') }} failed to report — check the server log.
        </p>

        <!-- Named on purpose. These render as absent above, which is correct, but
             absence is easy to miss: nobody notices that a plugin has NEVER
             reported. This is the difference between a card that shows what's
             monitored and one that shows what isn't. -->
        <p v-if="summary?.status_silent?.length" class="lv-unmonitored">
          not monitored: {{ summary.status_silent.join(', ') }}
        </p>
      </section>

    </div>

    <!-- Last, deliberately: the feed is where you drop AFTER a number looks
         wrong, not the thing you read first. -->
    <section class="lv-card lv-feed-card">
      <div class="blk-head lv-feed-head">
        <span>
          Feed
          <span v-if="paused" class="lv-flag">paused</span>
          <span v-if="dropped" class="lv-flag warn">{{ dropped }} dropped — arriving faster than this view renders</span>
          <span v-if="feed.length >= store.maxFeed" class="lv-flag">showing the most recent {{ store.maxFeed }}</span>
          <!-- The one flag worth interrupting for: a send that isn't arriving. It
               carries the word "failed" and a count, never colour alone. -->
          <span v-if="failing" class="lv-flag warn">
            {{ failing.total }} problem{{ failing.total === 1 ? '' : 's' }}
            ({{ failing.items.map(i => `${i.value} ${i.label} ${i.key}`).join(', ') }})
          </span>
        </span>
        <!-- Filters, composable and all client-side over the loaded feed. Every
             chip carries the count it WOULD yield given the other filters, so a
             number never disagrees with the list under it, and channels are
             offered from what's actually in the window rather than a fixed list
             of mostly-dead options. -->
        <span class="lv-filters">
          <!-- A plain text input, matching RailSearch (the app's filter box):
               `type="search"` brings Chrome's own cancel button and its own
               metrics, which read as a different control from every other filter
               in the app. `spellcheck="false"` for the same reason it's there —
               event types and campaign names aren't prose. The clear affordance
               is explicit, like RailSearch's, rather than the native one. -->
          <span class="lv-searchbox">
            <input v-model="feedQuery" type="text" class="lv-search" spellcheck="false"
              placeholder="filter — mail -bounced"
              aria-label="Filter the feed by event type, detail or person. Prefix a word with a minus to exclude it."
              title="Words must all match; prefix with - to exclude, e.g. mail -bounced" />
            <button v-if="feedQuery" type="button" class="lv-search-clear" aria-label="Clear the text filter"
              @click="feedQuery = ''"><span class="material-symbols-outlined">close</span></button>
          </span>

          <!-- list | count. The same segmented control as the window picker and
               Attribution's dimension switch (.lv-seg + .lv-win), because it's
               the same kind of choice: one-of-N over the same data. -->
          <div class="lv-seg">
            <button v-for="v in (['list', 'count'] as const)" :key="v" type="button" class="lv-win"
              :class="{ on: feedView === v }"
              :title="v === 'list' ? 'Every event, newest first' : 'One row per event type, most recently seen first'"
              @click="feedView = v">{{ v }}</button>
          </div>

          <!-- The app's standard filter control (components/FilterMenu.vue) —
               the same button and panel People's rail uses, in its tri-state
               mode. Previously this module hand-rolled both, which is why the
               two looked nothing alike. -->
          <FilterMenu mode="tri" :groups="filterGroups" :modes="filterModes"
            :active="feedFiltered" :title="filterSummary" aria-label="Filter the feed"
            hint="Click to show only · again to exclude · again to clear"
            clearable @toggle="onToggle" @clear="store.clearFeedFilters()">
            <template #clear>Clear filters<span v-if="hiddenByFilter"> — {{ hiddenByFilter }} hidden</span></template>
          </FilterMenu>
        </span>
      </div>
      <!-- COUNT: one row per type, ordered by what ticked most recently. Shares
           the feed's filters — this is the same data asked a different question,
           so a filtered list and a filtered count can't disagree. -->
      <ul v-if="feedView === 'count'" class="lv-feed is-count">
        <li v-for="r in feedCounts" :key="r.type" class="lv-agg">
          <span class="lv-ev-dir" :style="{ color: DIRECTION_COLOR[r.direction] || 'var(--muted)' }">
            {{ DIRECTION_GLYPH[r.direction] }}
          </span>
          <code class="lv-ev-type">{{ r.type }}</code>
          <span class="lv-agg-bar">
            <i :style="{ width: Math.round((r.count / Math.max(...feedCounts.map(x => x.count))) * 100) + '%',
                         background: DIRECTION_COLOR[r.direction] || 'var(--muted)' }" />
          </span>
          <span class="lv-ev-ch">{{ r.channel }}</span>
          <span class="lv-agg-n">{{ r.count }}</span>
        </li>
        <li v-if="!feedCounts.length" class="lv-empty">
          Nothing matches these filters.
          <button v-if="feedFiltered" type="button" class="lv-link" @click="store.clearFeedFilters()">Clear filters</button>
        </li>
      </ul>

      <ul v-else class="lv-feed is-list">
        <li v-for="(e, i) in visibleFeed" :key="(e.id || '') + i" class="lv-ev">
          <span class="lv-ev-dir" :style="{ color: DIRECTION_COLOR[e.direction] || 'var(--muted)' }">
            {{ DIRECTION_GLYPH[e.direction] }}
          </span>
          <span class="lv-ev-at">{{ fmtTime(e.at) }}</span>
          <code class="lv-ev-type">{{ e.type }}</code>
          <!-- The object of the sentence: which video, whose mail, which network
               rejected us. Deliberately '—' rather than a guess when the
               producer's payload carries nothing worth showing. -->
          <span class="lv-ev-detail" :class="{ muted: !e.detail }" :title="e.detail || ''">{{ e.detail || '—' }}</span>
          <span class="lv-ev-ch">{{ e.channel }}</span>
          <!-- a deep link out, so the firehose is a starting point rather than
               a dead end -->
          <RouterLink v-if="e.passport_id" class="lv-ev-who" :to="`/people/${e.passport_id}`">
            {{ short(e.passport_id) }}
          </RouterLink>
          <span v-else class="lv-ev-who muted">—</span>
        </li>
        <!-- Three different empty states, because they mean three different
             things and one generic message would hide which. -->
        <!-- Three empty states, because they mean three different things and one
             generic message would hide which. -->
        <li v-if="!visibleFeed.length && feed.length" class="lv-empty">
          Nothing matches these filters — {{ feed.length }} event{{ feed.length === 1 ? '' : 's' }} in this window are hidden.
          <button type="button" class="lv-link" @click="store.clearFeedFilters()">Clear filters</button>
        </li>
        <li v-else-if="!feed.length" class="lv-empty">
          Nothing recorded in this window. This reads the event log, so a quiet system shows an empty feed rather than an error.
        </li>
      </ul>
    </section>
  </div>
</template>
