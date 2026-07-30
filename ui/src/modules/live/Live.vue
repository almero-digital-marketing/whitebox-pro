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
import { DIRECTION_GLYPH, DIRECTION_COLOR, type Direction, type WindowKey, type StatusMetric } from './live'
import ToggleSwitch from 'primevue/toggleswitch'
import Button from 'primevue/button'
import Accordion from 'primevue/accordion'
import AccordionPanel from 'primevue/accordionpanel'
import AccordionHeader from 'primevue/accordionheader'
import AccordionContent from 'primevue/accordioncontent'
import FilterMenu from '../../components/FilterMenu.vue'
import TrafficStrip from './components/TrafficStrip.vue'
import './live.css'

const store = useLiveStore()
const { summary, series, utm, content, feed, visibleFeed, feedQuery, feedDirModes,
  feedChanModes, directionCounts, channelCounts, feedFiltered, hiddenByFilter,
  feedView, feedCounts,
  connected, paused, dropped, overflowed, failing, pinned, pinnedFigs } = storeToRefs(store)

// Which right-pane section is open — Live first, matching every other pane in the
// app opening its first panel rather than presenting a stack of closed headers.
// Live leads because the window and the filters change what every other number on
// the board means, so they are the first thing you'd reach for.
const sidePanel = ref('live')

// Not via storeToRefs: a plain function on the store, so wrapping it in a ref would
// only add a `.value` for the template to unwrap again.
const isPinned = store.isPinned

// Whether the selection still matches the default — drives the reset button's
// DISABLED state, not its presence (docs/adr/0001: a right-pane action is always
// rendered and greyed, never hidden, so it doesn't have to be rediscovered).
// Compared as a set, not a list: re-pinning the same five in a different order is
// still the default, and offering to reset it would be noise.
const isDefaultPinned = computed(() => {
  const d = ['live:events/min', 'live:in', 'live:out', 'live:internal', 'live:people active']
  return pinned.value.length === d.length && d.every(k => pinned.value.includes(k))
})

const WINDOWS: WindowKey[] = ['5m', '30m', '1h', '24h']

onActivated(() => { store.load(); store.start() })
onDeactivated(() => store.stop())

// Coming in / Going out, straight from the server's manifest
// (`summary.by_direction_channel`) — counts already split by direction AND channel.
//
// This file used to keep its own two lists of which channels flow which way, and
// that duplication caused two bugs in one sitting: `conversions` where the API says
// `conversion`, which silently dropped every conversion from the card; and a missing
// `adnetwork`, so "Going out" read "nothing sent" beside fourteen adnetwork events in
// the feed. A hard-coded list can only ever be a stale copy of the classifier.
//
// It also cannot be right in principle: a channel does not have one direction.
// `mail.received` is inbound and `mail.sent` is outbound, so the split has to be per
// EVENT — which only the server sees.
function rank(byChannel: Record<string, number> | undefined) {
  const rows = Object.entries(byChannel || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count }))
  const max = Math.max(1, ...rows.map(r => r.count))
  return rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map(r => ({ ...r, pct: Math.round((r.count / max) * 100) }))
}
const inChannels = computed(() => rank(summary.value?.by_direction_channel?.in))
const outChannels = computed(() => rank(summary.value?.by_direction_channel?.out))

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

// Status rows, with each figure flattened to one display shape.
//
// Metric order is the PLUGIN's, deliberately — the contract makes it part of the
// contract ("put the number an operator reads first, first"). An earlier version
// regrouped them here to separate windowed counts from current state; that
// overrode the plugin's ordering to serve a distinction the card doesn't draw.
//
// `of` renders as a ratio because either number alone says nothing: "3 of 8 held"
// is the claim, not "3". There is no separate gauge shape any more — that array
// existed only while the board drew a track for it.
// `live` first, then the plugins in the order the server reports them (config
// order). It otherwise lands LAST purely because it registers last, which buried
// the whole-system counters — events/min, in, out, people active — at the bottom of
// a 63-row scroll. They're the ones most people pin, so they lead.
const orderedStatus = computed(() => {
  const rows = summary.value?.status || []
  return [...rows.filter(p => p.module === 'live'), ...rows.filter(p => p.module !== 'live')]
})

const statusRows = computed(() => orderedStatus.value.map(p => ({
  module: p.module,
  label: p.label,
  note: p.note,
  figs: p.metrics.map((m: StatusMetric) => ({
    key: m.key,
    text: m.of === undefined ? String(m.value) : `${m.value}/${m.of}`,
    // "Non-zero is a problem" is what severity means, so a zero never reads as bad.
    bad: m.severity === 'bad' && m.value > 0,
    // Straight from the plugin (docs/10-plugin-status.md). Falls back to the key so
    // a plugin published before `description` existed still gets a tooltip rather
    // than an empty one.
    description: m.description || m.key,
  })),
})))

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
  <!-- Two panes, matching People/Campaigns/Audiences: a scrolling main column and
       a fixed-width right aside (`.ppl-side` is the same 400px flex-none pattern).
       Status moved into the aside because it stopped being a reading and became a
       CONTROL — it picks what the header shows — and a control that governs the
       whole board belongs beside it, not sixth in a grid of cards. -->
  <div class="live-console">
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
      <!-- WHICHEVER counters were pinned in the Status pane, in the order they
           were pinned. This used to be five hard-coded figures from live's own
           aggregates, which meant the most prominent row on the board was the one
           thing nobody could change — while mail's `failed` and journeys' `stuck`,
           the numbers people actually watch for, sat two scrolls down.
           Only a PLUGIN's counter is qualified with its owner. live's are the whole
           system's — `events/min`, `in`, `people active` are properties of the
           traffic itself, and naming the owner turned the row into "LIVE" repeated
           five times for no information. `failed`, by contrast, is ambiguous across
           mail, sms, journeys and conversions, so it keeps its owner. -->
      <div class="lv-pulse">
        <span v-for="f in pinnedFigs" :key="`${f.module}:${f.key}`"
          class="lv-fig" :class="{ bad: f.bad }">
          <b>{{ f.text }}</b>
          <span v-if="f.owner" class="lv-fig-mod">{{ f.owner }}</span>{{ f.key }}
        </span>

        <!-- An empty header is a choice someone made, not a broken board — so it
             says how to undo it rather than showing nothing at all. -->
        <span v-if="!pinnedFigs.length" class="lv-quiet">
          No counters pinned — switch some on in the Status pane.
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
        <!-- The window picker and the filters moved to the Live pane on the right.
             They govern every card, not just the row they used to sit above, so they
             belong with the other board-wide controls rather than in the header —
             which now carries only the pinned figures and whether the feed is
             running. -->
        <!-- Icon-only, the same 30px bordered square as People's search filter
             (.icon-btn in style.css). Paused is the non-default state, so it
             takes the `on` treatment; the dot says events are stacking up
             behind it, which a bare icon otherwise couldn't tell you. -->
        <button type="button" class="icon-btn" :class="{ on: paused }"
          :aria-label="paused ? `Resume the feed${overflowed ? ` — ${overflowed} events buffered` : ''}` : 'Pause the feed'"
          v-tooltip.bottom="paused ? `Resume${overflowed ? ` — ${overflowed} buffered` : ''}` : 'Pause'"
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
              v-tooltip.top="v === 'list' ? 'Every event, newest first' : 'One row per event type, most recently seen first'"
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

    <!-- ── the pane: everything that GOVERNS the board ───────────────────────
         Two sections. "Live" holds the controls — the window and the filters, both
         of which apply board-wide — and "Status" holds the counters and picks which
         of them reach the header. Both are choices about what the board shows, which
         is why they sit beside it rather than in the header above it. -->
    <aside class="lv-side">

      <Accordion v-model:value="sidePanel" class="lv-accordion">
        <!-- ── Live: the board-wide controls ──────────────────────────────── -->
        <AccordionPanel value="live">
          <AccordionHeader>
            <span class="acc-title">
              Live
              <!-- Says the board is narrowed even with the section shut, which
                   matters more here than for Status: a filtered board looks like a
                   quiet one, and that is the single most misleading thing this
                   module can do. -->
              <span v-if="feedFiltered" class="count-pill sm">filtered</span>
            </span>
          </AccordionHeader>
          <AccordionContent>
            <p class="lv-side-hint">
              These apply to the whole board — every card and the feed.
            </p>

            <!-- Every group in this pane is `.lv-sgroup` with a `.lv-dl-ch` heading,
                 and every row is `.lv-srow` — the SAME structures the Status section
                 uses. Reused rather than restyled: a pane with two row shapes and two
                 label tiers is how the typography drifts, and these lists are the
                 same kind of thing as the counter list (a name, a number, a control on
                 the right). -->
            <div class="lv-sgroup">
              <div class="lv-sgroup-head"><span class="lv-dl-ch">Window</span></div>
              <div class="lv-seg lv-seg-wide">
                <button v-for="w in WINDOWS" :key="w" type="button" class="lv-win"
                  :class="{ on: store.window === w }" @click="store.setWindow(w)">{{ w }}</button>
              </div>
            </div>

            <div class="lv-sgroup">
              <div class="lv-sgroup-head"><span class="lv-dl-ch">Direction</span></div>
              <!-- ToggleSwitch, the same control the Status rows use, so this pane has
                   ONE control meaning "show this or don't" — whether the row is a
                   counter, a direction or a channel. Channel briefly had a checkbox,
                   which made two controls mean the same thing three rows apart.
                   Two states, not the tri-state cycle it replaced: "switch on what you
                   want to see" needs no explaining. Switching one OFF writes an
                   exclude rather than a whitelist of what remains, so a direction or
                   channel that first appears tomorrow still shows by default. -->
              <label v-for="d in directionChips" :key="d" class="lv-srow"
                :title="`Show ${d} across the whole board`">
                <span class="lv-srow-t">
                  <span class="lv-srow-top">
                    <span class="lv-srow-n"><b>{{ directionCounts[d] || 0 }}</b></span>
                    <span class="lv-srow-k">{{ DIRECTION_GLYPH[d] }} {{ d }}</span>
                  </span>
                </span>
                <ToggleSwitch class="lv-sw" :model-value="store.isDirOn(d)"
                  @update:model-value="(v: boolean) => store.setDirection(d, v)"
                  :aria-label="`Show ${d} on the board`" />
              </label>
            </div>

            <div class="lv-sgroup">
              <div class="lv-sgroup-head"><span class="lv-dl-ch">Channel</span></div>
              <label v-for="c in channelCounts" :key="c.channel" class="lv-srow"
                :title="`Show ${c.channel} across the whole board`">
                <span class="lv-srow-t">
                  <span class="lv-srow-top">
                    <span class="lv-srow-n"><b>{{ c.count }}</b></span>
                    <span class="lv-srow-k">{{ c.channel }}</span>
                  </span>
                </span>
                <ToggleSwitch class="lv-sw" :model-value="store.isChanOn(c.channel)"
                  @update:model-value="(v: boolean) => store.setChannel(c.channel, v)"
                  :aria-label="`Show ${c.channel} on the board`" />
              </label>
              <!-- Says WHY it's empty. It reads from the window's own traffic, so a
                   quiet window genuinely has nothing to offer — which is different
                   from the list being broken. -->
              <p v-if="!channelCounts.length" class="lv-srow-d">
                Nothing has come through in this window yet.
              </p>
            </div>

            <div class="b-actions">
              <Button label="Clear filters" text severity="secondary" size="small"
                :disabled="!feedFiltered" @click="store.clearFeedFilters()" />
            </div>
          </AccordionContent>
        </AccordionPanel>

        <!-- ── Status: the counters, and which reach the header ────────────────
             ONE panel holding every plugin as a group, which is what the app's right
             panes are: a small stack of named sections, not thirteen of them. A panel
             per plugin was tried and dropped — thirteen headers turned the pane into
             a list of things to click before it was a list of counters, and the one
             you wanted was always shut. -->
        <AccordionPanel value="status">
          <AccordionHeader>
            <span class="acc-title">
              Status
              <!-- The count on the header, so it reads even collapsed — the same
                   reason People puts one on every panel. -->
              <span class="count-pill sm">{{ pinned.length }}</span>
            </span>
          </AccordionHeader>
          <AccordionContent>
            <!-- Inside the panel, not above the title: it explains what the rows do,
                 so it belongs with them. Above the accordion it was floating over a
                 collapsed section, describing an interaction nothing on screen
                 offered yet. Paired with the reset at the foot, the two bracket the
                 content they're about. -->
            <p class="lv-side-hint">Switch a counter on to show it in the header.</p>

            <div v-for="p in statusRows" :key="p.module" class="lv-sgroup">
              <div class="lv-sgroup-head">
                <span class="lv-dl-ch">{{ p.label }}</span>
                <!-- The plugin's caveat about what it CAN'T measure, next to the name
                     it belongs to. Four plugins have one. -->
                <button v-if="p.note" type="button" class="lv-dl-why"
                  v-tooltip.left="{ value: p.note, class: 'lv-why-tip' }"
                  :aria-label="`${p.label}: ${p.note}`">
                  <span class="material-symbols-outlined">info</span>
                </button>
              </div>

              <!-- The app's existing toggle row, copied from analytics' CompareSection:
                   a <label> wrapping its text with the switch pushed right by
                   `margin-left: auto` (its `.lab.row` + `.cmp-sw`). Same PrimeVue
                   ToggleSwitch, same geometry — the classes there are scoped under
                   `.qb`, so the values are mirrored in live.css the way this file
                   already mirrors People's `.sub-title`.
                   The description is INLINE under the counter, its own full-width
                   line. It comes from the plugin, not from here — only it knows that
                   `sent` means "handed to the provider" while `delivered` means "the
                   provider confirmed the mailbox took it". On hover nobody found
                   them, which is why they are simply shown. -->
              <!-- TWO COLUMNS: everything readable on the left, the switch on the
                   right. The description sits under the number and name but inside
                   the left column, so it stops at the switch rather than running
                   underneath it — text flowing beneath a control reads as though it
                   belongs to the row below. -->
              <label v-for="f in p.figs" :key="f.key" class="lv-srow" :class="{ bad: f.bad }">
                <span class="lv-srow-t">
                  <span class="lv-srow-top">
                    <span class="lv-srow-n">
                      <span v-if="f.bad" class="material-symbols-outlined">error</span>
                      <b>{{ f.text }}</b>
                    </span>
                    <span class="lv-srow-k">{{ f.key }}</span>
                  </span>
                  <small class="lv-srow-d">{{ f.description }}</small>
                </span>
                <ToggleSwitch class="lv-sw" :model-value="isPinned(`${p.module}:${f.key}`)"
                  @update:model-value="store.togglePinned(`${p.module}:${f.key}`)"
                  :aria-label="`Show ${p.label} ${f.key} in the header`" />
              </label>
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

            <!-- The app's right-pane action row — `.b-actions` with a PrimeVue Button,
                 the same object as People's Discard (docs/adr/0001). DISABLED rather
                 than hidden when there is nothing to undo: that's the ADR's rule, and
                 a control that vanishes is one you have to rediscover. -->
            <div class="b-actions">
              <Button label="Reset counters" text severity="secondary" size="small"
                :disabled="isDefaultPinned" @click="store.resetPinned()" />
            </div>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>

    </aside>
  </div>
</template>
