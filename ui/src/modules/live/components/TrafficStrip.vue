<script setup lang="ts">
// Counts per bucket over the window, in vs out.
//
// Stacked BARS, not an area: these are discrete counts per interval, and an
// area implies a continuous signal sampled between points — it would draw a
// slope through time where nothing happened. A 2px gap between the two
// segments keeps the boundary readable without a stroke.
//
// Only two series, and `internal` is not one of them: orchestration isn't
// traffic, so stacking it here would inflate the very bars an operator reads
// as "how much is actually flowing".
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { DIRECTION_COLOR, DIRECTION_GLYPH, type Series } from '../live'

const props = defineProps<{
  series: Series | null
  /**
   * "Nothing in the last 30m — last activity 50 min ago." Computed by the board,
   * because it needs `summary.last_event_at`, which the series does not carry.
   * Shown in place of the plot when the window is empty: an empty chart is
   * ambiguous — nothing happening and nothing WORKING look identical — and this is
   * the sentence that resolves it.
   */
  quiet?: string | null
}>()

// Resolution belongs to whoever knows the width, and that's this component. It
// reports how many bars it can draw and the parent refetches at that resolution
// — the same 30 minutes is ~30 bars in a narrow pane and ~140 on a wide board,
// and any number baked into the server is wrong on one of them.
const emit = defineEmits<{ (e: 'resolution', points: number): void }>()

const plot = ref<HTMLElement | null>(null)

// Footprint of one bar including .ts-plot's 2px gap. 11px is about where a bar
// still reads as a bar rather than a sliver.
const BAR_PX = 11
// Quantised so ordinary layout jitter — a scrollbar appearing, a panel
// animating — can't fire a refetch on every frame. Only crossing a step reports.
const QUANTUM = 10

let ro: ResizeObserver | null = null
let frame = 0
let reported = 0

// Coalesced into one animation frame. ResizeObserver can deliver a burst of
// notifications for a single layout pass, and measuring inside the callback that
// the measurement itself may influence is how you get "ResizeObserver loop
// completed with undelivered notifications" — or a wedged tab. Reading in a
// frame, and only re-reporting when the answer actually CHANGES, means a resize
// storm collapses to at most one refetch.
function measure() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const width = plot.value?.clientWidth ?? 0
    if (!width) return
    // Never ask for more bars than can be drawn: a bar's real footprint is
    // BAR_PX, so width/BAR_PX is a hard ceiling. Asking beyond it used to
    // overflow the plot, which is what started the loop.
    const fits = Math.max(QUANTUM, Math.round(width / BAR_PX / QUANTUM) * QUANTUM)
    if (fits === reported) return
    reported = fits
    emit('resolution', fits)
  })
}

onMounted(() => {
  measure()
  // ResizeObserver rather than a window listener: the board is a flex/grid
  // layout, so this element resizes when the rail or feed changes too, with no
  // window resize involved.
  ro = new ResizeObserver(measure)
  if (plot.value) ro.observe(plot.value)
})

onBeforeUnmount(() => {
  ro?.disconnect(); ro = null
  if (frame) { cancelAnimationFrame(frame); frame = 0 }
})

const bars = computed(() => {
  const b = props.series?.buckets || []
  const max = Math.max(1, ...b.map(x => x.in + x.out))
  // Sub-minute buckets need seconds in the tooltip, or four adjacent bars all
  // claim to be "17:12" and hovering can't tell you which moment you're on.
  const fine = (props.series?.bucket_seconds ?? 60) < 60
  const timeOpts: Intl.DateTimeFormatOptions = fine
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }
  return b.map(x => ({
    ...x,
    inPct: (x.in / max) * 100,
    outPct: (x.out / max) * 100,
    label: new Date(x.bucket).toLocaleTimeString([], timeOpts),
  }))
})
const peak = computed(() => Math.max(0, ...(props.series?.buckets || []).map(x => x.in + x.out)))

// Horizontal gridlines, LABELLED. Without them the only readable value is the
// peak in the corner — every other bar is "somewhere under that", which is not a
// reading. With them you can tell a spike of 8 from one of 3 at a glance, which
// is the entire job of this strip.
//
// Ticks land on round numbers, never on peak/2: these are counts of discrete
// events, so a line at 2.5 events is a line at nothing. The step is the smallest
// from a 1/2/5/10 ladder that keeps the chart to ~3 lines — the same reasoning as
// the bucket ladder, and for the same reason (the numbers are shown, so they have
// to be numbers a person would choose).
const TICK_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
const MAX_LINES = 3

const ticks = computed(() => {
  const p = peak.value
  if (!p) return []
  const step = TICK_STEPS.find(s => p / s <= MAX_LINES) ?? Math.ceil(p / MAX_LINES)
  const out: { value: number; pct: number }[] = []
  for (let v = step; v <= p; v += step) out.push({ value: v, pct: (v / p) * 100 })
  return out
})
// Buckets can exist while every bar is zero — a window in which plenty happened
// but none of it was traffic (orchestration only). Rendering flat bars under
// "peak 0" reads as a broken chart, so say what's actually true instead.
// Two DIFFERENT empty windows, and conflating them was a small lie the strip told.
//   flat + internal traffic  — plenty happened, none of it crossed the boundary.
//   flat + nothing at all    — the window is genuinely empty, and the only useful
//                              thing to say is when something last happened. That
//                              sentence is `quiet`, computed by the board (it needs
//                              `last_event_at`, which the series doesn't carry).
// `internalOnly` used to be true for both, so a dead-quiet window read "No traffic in
// or out — 0 internal events (enrollments, activations) ran", which states a zero as
// if it were an explanation.
const internalTotal = computed(() => (props.series?.buckets || []).reduce((a, b) => a + b.internal, 0))
const flat = computed(() => Boolean(props.series?.buckets?.length) && peak.value === 0)
const internalOnly = computed(() => flat.value && internalTotal.value > 0)
</script>

<template>
  <div class="ts">
    <div class="ts-head">
      <!-- A legend is always present for two series, and each entry carries its
           glyph as well as its swatch — identity never rests on colour alone. -->
      <div class="ts-legend">
        <span class="ts-key"><i :style="{ background: DIRECTION_COLOR.in }" />{{ DIRECTION_GLYPH.in }} in</span>
        <span class="ts-key"><i :style="{ background: DIRECTION_COLOR.out }" />{{ DIRECTION_GLYPH.out }} out</span>
      </div>
      <span class="ts-peak">peak {{ peak }}/bucket</span>
    </div>

    <div ref="plot" class="ts-plot" role="img"
      :aria-label="`Traffic over the window: ${bars.length} buckets, peak ${peak} events`">
      <!-- Behind the bars, and aria-hidden: the label above already states the
           peak, so a screen reader gains nothing from the tick values. -->
      <div v-if="ticks.length && !flat" class="ts-grid" aria-hidden="true">
        <span v-for="t in ticks" :key="t.value" class="ts-tick" :style="{ bottom: t.pct + '%' }">
          <b>{{ t.value }}</b>
        </span>
      </div>
      <template v-if="!flat">
        <!-- every bar carries a native tooltip: the hover layer a chart in HTML
             should ship by default -->
        <div v-for="(b, i) in bars" :key="i" class="ts-bar"
          :title="`${b.label} — ${b.in} in, ${b.out} out`">
          <i class="ts-seg" :style="{ height: b.outPct + '%', background: DIRECTION_COLOR.out }" />
          <i class="ts-seg" :style="{ height: b.inPct + '%', background: DIRECTION_COLOR.in }" />
        </div>
      </template>
      <p v-if="internalOnly" class="lv-empty ts-empty">
        No traffic in or out of this window — {{ internalTotal }} internal event{{ internalTotal === 1 ? '' : 's' }}
        (enrollments, activations) ran, which isn't data crossing the boundary.
      </p>
      <!-- The quiet-vs-broken sentence, in the chart it explains. It sat in the board
           header beside the pinned figures, where it was a line of prose among numbers
           and described this plot rather than them. -->
      <p v-else-if="flat || !bars.length" class="lv-empty ts-empty">
        {{ quiet || 'No events in this window.' }}
      </p>
    </div>

    <div v-if="bars.length && !flat" class="ts-axis">
      <span>{{ bars[0].label }}</span><span>{{ bars[bars.length - 1].label }}</span>
    </div>
  </div>
</template>
