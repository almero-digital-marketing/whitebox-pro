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
import TrafficStrip from './components/TrafficStrip.vue'
import { useRouter } from 'vue-router'
import './live.css'

const store = useLiveStore()
// For the "Person details" button — a labelled action, so it pushes rather than
// being a RouterLink. Same pattern as shell/views/NoAccess.vue.
const router = useRouter()
const { summary, series, utm, content, feed, visibleFeed, feedQuery, feedDirModes,
  feedChanModes, feedPassport, feedPerson, feedPersonName, directionCounts, channelCounts, feedFiltered,
  feedView, feedCounts, feedSeverity,
  connected, dropped, failing, pinned, pinnedFigs } = storeToRefs(store)

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

// The problem flag's action. Switching `feedSeverity` refetches over the window
// rather than filtering the loaded buffer, which is the whole reason this is
// useful: at this event rate the buffer holds under two minutes, so the rows the
// flag is complaining about have usually scrolled out of it already.
//
// Clears the search too. Arriving at a problems list silently narrowed by a word
// typed ten minutes ago is the kind of empty result that reads as "nothing to
// see" — the opposite of what was just clicked.
const feedCard = ref<HTMLElement | null>(null)
function showProblems() {
  feedSeverity.value = 'problems'
  feedQuery.value = ''
  feedCard.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

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
// The feed's own filter menu is gone, and with it `filterGroups`, `filterModes`,
// `onToggle` and `filterSummary`. They existed only to shape this module's tri-state
// into that component's props, and to narrate an icon-only control in a tooltip. The
// Live pane renders the axes directly as labelled rows, so there is nothing to shape
// and nothing to narrate.

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
        <!-- The plugin's own description on hover. A header figure is the most
             exposed number on the board and was the only place carrying no
             explanation — the Status pane has shown these all along. It matters
             here because a counter and a card can look like they disagree while
             both are right: `0 voip missed` beside a Coming in card reading
             `voip 1` is a missed-call count next to an event count, and `ringing`
             is current state that ignores the window altogether. -->
        <span v-for="f in pinnedFigs" :key="`${f.module}:${f.key}`"
          class="lv-fig" :class="{ bad: f.bad }"
          v-tooltip.bottom="f.description">
          <b>{{ f.text }}</b>
          <span v-if="f.owner" class="lv-fig-mod">{{ f.owner }}</span>{{ f.key }}
        </span>

        <!-- An empty header is a choice someone made, not a broken board — so it
             says how to undo it rather than showing nothing at all. -->
        <span v-if="!pinnedFigs.length" class="lv-quiet">
          No counters pinned — switch some on in the Status pane.
        </span>

      </div>

      <!-- The header carries the pinned figures and nothing else now. The window
           picker and the filters moved to the Live pane (they govern every card, not
           the row they happened to sit above); the connection state moved to that
           pane's title, where it labels the section it describes; and Pause is gone
           entirely. -->
    </header>

    <!-- the only chart: counts per bucket over the window, in vs out -->
    <section class="lv-card lv-strip">
      <TrafficStrip :series="series" :quiet="quietFor" @resolution="store.setPoints" />
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
        <div class="blk-head">Content</div>
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
    <section ref="feedCard" class="lv-card lv-feed-card">
      <div class="blk-head lv-feed-head">
        <span>
          Feed
          <span v-if="dropped" class="lv-flag warn">{{ dropped }} dropped — arriving faster than this view renders</span>
          <span v-if="feed.length >= store.maxFeed" class="lv-flag">showing the most recent {{ store.maxFeed }}</span>
          <!-- The one flag worth interrupting for: a send that isn't arriving. It
               carries the word "failed" and a count, never colour alone.
               A BUTTON, because a count of problems with no way to reach them is
               an alarm with no handle — it tells you to look and then offers
               nowhere to look. Clicking switches the feed to `problems`, which
               refetches over the window rather than filtering the buffer, so the
               rows it names are actually fetched.
               It does not narrow to the one counter that was clicked. The flag
               counts status counters and the feed holds rows; the two are
               different populations (see the note on the segmented control
               below), so promising "these 2" and delivering a list of a
               different length would be worse than showing every problem in the
               window and letting the search box narrow it. -->
          <button v-if="failing" type="button" class="lv-flag warn lv-flag-btn"
            v-tooltip.top="'Show these in the feed'"
            @click="showProblems">
            {{ failing.total }} problem{{ failing.total === 1 ? '' : 's' }}
            ({{ failing.items.map(i => `${i.value} ${i.label} ${i.key}`).join(', ') }})
          </button>
        </span>
        <!-- No direction/channel filter here any more: the Live pane's filters are
             board-wide and already govern this list, so a second control for the same
             state would be two places to look and two to keep in step.
             What stays is the text SEARCH, which the pane does not offer — it matches
             over type, detail and person rather than narrowing an axis. -->
        <span class="lv-filters">
          <!-- A plain text input, matching RailSearch (the app's search box):
               `type="text"` not `type="search"`, because Chrome's own cancel button and
               metrics read as a different control from every other one in the app.
               `spellcheck="false"` for the same reason it's there — event types and
               campaign names aren't prose. The clear affordance is explicit, like
               RailSearch's, rather than the native one.
               Called SEARCH, not filter: the word "filter" now means the pane's
               board-wide axes, and this is a different act — matching text across a
               row rather than narrowing the board. -->
          <span class="lv-searchbox">
            <input v-model="feedQuery" type="text" class="lv-search" spellcheck="false"
              placeholder="search — mail -bounced"
              aria-label="Search the feed by event type, detail or person. Prefix a word with a minus to exclude it."
              title="Words must all match; prefix with - to exclude, e.g. mail -bounced" />
            <button v-if="feedQuery" type="button" class="lv-search-clear" aria-label="Clear the search"
              @click="feedQuery = ''"><span class="material-symbols-outlined">close</span></button>
          </span>

          <!-- all | problems. Narrows to the events whose own module declared them
               error or warn (server/src/event-catalog.js) — NOT a list of type
               names kept here, which is the mistake this module's classification
               was rewritten to end: it would be a claim about somebody else's
               plugin, and a channel added tomorrow would be missing from it with
               nothing to show that.
               Switching REFETCHES, it does not re-filter what is loaded: at this
               event rate 300 rows is under two minutes of a 30-minute window, so
               the problems being asked about have usually scrolled out of it.
               NO count here. It had one, from the buffer, sitting inches from the
               header's own problem flag — which counts plugin status counters
               over the window, not feed rows. `1 problem (1 conversions rejected)`
               beside `problems 0`, both correct and impossible to reconcile by
               looking. The flag is the count; this is a view switch. -->
          <div class="lv-seg">
            <button v-for="v in (['all', 'problems'] as const)" :key="v" type="button" class="lv-win"
              :class="{ on: feedSeverity === v }"
              v-tooltip.top="v === 'all'
                ? 'Every event'
                : 'Only what a module reported as an error or a warning — failed and bounced sends, rejected conversions'"
              @click="feedSeverity = v">{{ v }}</button>
          </div>

          <!-- list | count. The same segmented control as the window picker and
               Attribution's dimension switch (.lv-seg + .lv-win), because it's
               the same kind of choice: one-of-N over the same data. -->
          <div class="lv-seg">
            <button v-for="v in (['list', 'count'] as const)" :key="v" type="button" class="lv-win"
              :class="{ on: feedView === v }"
              v-tooltip.top="v === 'list' ? 'Every event, newest first' : 'One row per event type, most recently seen first'"
              @click="feedView = v">{{ v }}</button>
          </div>

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
        <li v-if="!feedCounts.length && feedSeverity === 'problems'" class="lv-empty">
          Nothing has gone wrong here — no module reported an error or a warning among these events.
          <button type="button" class="lv-link" @click="feedSeverity = 'all'">Show every event</button>
        </li>
        <li v-else-if="!feedCounts.length" class="lv-empty">
          Nothing matches these filters.
          <button v-if="feedFiltered" type="button" class="lv-link" @click="store.clearFeedFilters()">Clear filters</button>
        </li>
      </ul>

      <ul v-else class="lv-feed is-list">
        <!-- A problem row is marked on the ROW, not given a column of its own.
             Two reasons. The grid is `subgrid` with every track `max-content`, so
             a sixth column costs all 500 rows an 8px gap for a cell that is empty
             on nearly all of them. And every type that carries a severity NAMES
             its failure — mail.failed, mail.bounced, adnetwork.error — so a badge
             reading "error" beside `mail.failed` is the same restatement that
             stripTypeEcho exists to remove from the detail column.
             The word still exists for a screen reader and on hover, via `title`:
             colour is the accelerant here, never the only carrier. -->
        <li v-for="(e, i) in visibleFeed" :key="(e.id || '') + i" class="lv-ev"
          :class="e.severity ? `sev-${e.severity}` : null"
          :title="e.severity === 'error' ? 'Error — this did not happen'
            : e.severity === 'warn' ? 'Warning — it happened and the outcome was bad'
            : null">
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
          <!-- ONE action per row: scope the board to this person. Opening their
               record used to sit here too, as a second control in the same cell —
               but it is the rarer intent, and a feed row is scanned rather than
               read, so two targets a few pixels apart in a 20px-high row is a
               misclick waiting to happen. It moved to the Person filter in the
               right pane, which only exists once you HAVE picked someone: by then
               you have committed to them, which is exactly when "who are they?"
               becomes the question. -->
          <button v-if="e.passport_id" type="button" class="lv-ev-who"
            :class="{ on: feedPassport === e.passport_id }"
            :title="feedPassport === e.passport_id
              ? 'Showing only this person — click to clear'
              : 'Show only this person'"
            @click="store.togglePassport(e.passport_id)">{{ short(e.passport_id) }}</button>
          <span v-else class="lv-ev-who muted">—</span>
        </li>
        <!-- Three different empty states, because they mean three different
             things and one generic message would hide which. -->
        <!-- Three empty states, because they mean three different things and one
             generic message would hide which. -->
        <!-- "No problems" is GOOD NEWS and has to read that way. Sent through the
             generic "nothing matches these filters" it reads as a filter you got
             wrong, which is the opposite of what it says — and it is the one
             empty state someone deliberately goes looking for. -->
        <li v-if="!visibleFeed.length && feed.length && feedSeverity === 'problems'" class="lv-empty">
          Nothing has gone wrong here — no module reported an error or a warning among these events.
          <button type="button" class="lv-link" @click="feedSeverity = 'all'">Show every event</button>
        </li>
        <li v-else-if="!visibleFeed.length && feed.length" class="lv-empty">
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

      <Accordion v-model:value="sidePanel" class="pane-accordion">
        <!-- ── Live: the board-wide controls ──────────────────────────────── -->
        <AccordionPanel value="live">
          <AccordionHeader>
            <span class="acc-title">
              Live
              <!-- The connection state, as a dot on the title it describes. It was a
                   10px "live"/"reconnecting" label in the board header, where it
                   competed with the figures and described something none of them are
                   about — the transport, not the data.
                   Colour alone is never the whole signal: the title carries the words
                   for a screen reader and on hover, since green-vs-grey is exactly
                   what a colourblind reader loses. -->
              <i class="count-dot" :class="{ zero: !connected }"
                :title="connected ? 'Streaming live' : 'Reconnecting — the board is polling meanwhile'"
                :aria-label="connected ? 'Streaming live' : 'Reconnecting'" />
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
            <!-- FIRST, because it is the narrowest filter and the only one applied
                 from somewhere else: you set it by clicking a feed row, which has
                 usually scrolled away by the time you wonder why the board looks
                 empty. Putting it under Window and Channel meant the answer to "why
                 am I seeing this" sat below two lists you had to scroll past. Absent
                 entirely when nothing is scoped, so it costs no space by default. -->
            <div v-if="feedPassport" class="lv-sgroup lv-scope">
              <div class="lv-sgroup-head"><span class="lv-dl-ch">Person</span></div>
              <div class="lv-srow">
                <!-- Rendered the way People's rail renders a person: `.two-line`
                     (a GLOBAL opt-in class in style.css, applied alongside a module's
                     own row class exactly for this) puts the name on line one and when
                     we last saw them on line two, and the name comes from People's own
                     `displayName`. Reused rather than restyled — two panes disagreeing
                     about what a person is called is the drift worth avoiding, and an
                     8-character id was never a name.
                     Falls back to the short id when the lookup hasn't landed or the
                     viewer has no people:read. -->
                <span class="lv-person two-line">
                  <span class="ri-name">{{ feedPersonName }}</span>
                  <span class="ri-sub">
                    <span class="material-symbols-outlined">person</span>
                    <!-- Visit count beside last-seen: on a live board "they were just
                         here" is a given, so how many times they have come back is
                         the part that isn't. `!= null` — 0 is a real state, null
                         means core didn't answer. -->
                    <span v-if="feedPerson?.sessions != null">
                      {{ feedPerson.sessions }}{{ feedPerson.sessions === 1 ? ' session' : ' sessions' }}
                    </span>
                    <span v-if="feedPerson?.last_seen_at">· last seen {{ fmtTime(feedPerson.last_seen_at) }}</span>
                    <span v-if="!feedPerson">{{ short(feedPassport) }}</span>
                  </span>
                </span>
              </div>
              <!-- Both actions LABELLED, side by side, outside the row. The row says
                   who is selected; what you can do about it lives below it in the
                   pane's own action row (`.save-bar`, ADR-0001 rule 6 — right-aligned,
                   no border of its own because what follows draws one).
                   Order and weight follow the ADR's discard/act pairing: the plain
                   text button releases, the emphasised one goes somewhere. An × icon
                   was here instead of "Clear", which meant the two things you can do
                   to this row were a glyph and a word, in two different places.
                   `router.push` rather than a RouterLink because this is a button —
                   the same way shell/views/NoAccess.vue navigates. -->
              <div class="save-bar">
                <Button label="Clear" text severity="secondary" size="small"
                  @click="store.togglePassport(null)" />
                <Button label="Person details" size="small" outlined severity="secondary"
                  @click="router.push(`/people/${feedPassport}`)" />
              </div>
            </div>

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


            <div class="save-bar">
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

            <!-- The app's right-pane action row with a PrimeVue Button, the same
                 object as People's Discard (docs/adr/0001). DISABLED rather than
                 hidden when there is nothing to undo: that's the ADR's rule, and a
                 control that vanishes is one you have to rediscover.
                 `.save-bar`, NOT `.b-actions` — rule 6's two variants. `.b-actions`
                 draws its own border-top for a row that ends a panel; `.save-bar`
                 draws none, for a row FOLLOWED by something that already draws one.
                 Inside an accordion that's this case: the next panel's header carries
                 a border-top immediately below, so a border here doubles the
                 divider. -->
            <div class="save-bar">
              <Button label="Reset counters" text severity="secondary" size="small"
                :disabled="isDefaultPinned" @click="store.resetPinned()" />
            </div>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>

    </aside>
  </div>
</template>
