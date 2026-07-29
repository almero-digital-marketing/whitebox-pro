<script setup lang="ts">
// A person's awareness history. The endpoint returns 21 fields per row and the
// old list rendered three of them (channel, source, timestamp) — throwing away
// `text`, which is the only human-readable field and is populated on every row:
// "Booked and completed botox / anti-wrinkle." That sentence IS the history;
// everything else is provenance for it.
//
// So `text` leads, and the rest becomes a provenance line under it. Rows group
// by day, because a date repeated down twenty rows is noise once the group
// heading says it.
import { computed, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { usePeopleStore } from './stores/people'
import { DIRECTIONS, directionIcon, metaChips, utmOf, dwellOf, type Activity } from './people'

const store = usePeopleStore()

const dayKey = (iso: string) => new Date(iso).toLocaleDateString()
// Consecutive runs rather than a keyed map: the server already orders by ts
// desc, so grouping by adjacency preserves that order for free and can't
// resurrect a day that scrolled past.
const days = computed(() => {
  const out: { day: string; rows: Activity[] }[] = []
  for (const r of store.activity) {
    const day = dayKey(r.ts)
    if (out[out.length - 1]?.day !== day) out.push({ day, rows: [] })
    out[out.length - 1].rows.push(r)
  }
  return out
})

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Filtering is a server round-trip, not a client filter over the loaded page —
// otherwise "conversions only" would mean "conversions among the last 20 rows",
// which silently answers a different question than the one asked.
// ── infinite scroll ─────────────────────────────────────────────────────────
// A sentinel after the last row, watched inside the centre pane's own scroller.
// `root: null` would watch the viewport, which never scrolls here — the overflow
// lives on .b-scroll — so the observer has to be rooted to that ancestor or it
// would fire once on mount and never again.
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null

function stop() { io?.disconnect(); io = null }

async function observe() {
  stop()
  await nextTick()
  const el = sentinel.value
  if (!el) return
  io = new IntersectionObserver(
    ([entry]) => {
      // activityLoading is the guard: without it the observer fires again on
      // every scroll event while a fetch is still in flight and stacks
      // duplicate pages onto the list.
      if (entry.isIntersecting && store.activityHasMore && !store.activityLoading) {
        store.loadMoreActivity()
      }
    },
    { root: el.closest('.b-scroll'), rootMargin: '200px' },   // start early, so it feels continuous
  )
  io.observe(el)
}

// re-observe when the sentinel appears or disappears (filters, exhausted pages)
watch(() => store.activityHasMore, (more) => (more ? observe() : stop()), { immediate: true })
onBeforeUnmount(stop)

const active = computed(() => store.activityDirections)
function toggle(value: string) {
  const next = active.value.includes(value)
    ? active.value.filter(v => v !== value)
    : [...active.value, value]
  store.setActivityDirections(next)
}
</script>

<template>
  <div class="ppl-block">
    <div class="blk-head act-head">
      <span>Recent activity</span>
      <!-- no "all" chip: none selected already means all, and a chip that's on
           by default and turns everything off when clicked reads backwards -->
      <span class="act-filters">
        <button v-for="d in DIRECTIONS" :key="d.value" type="button" class="dir-chip"
          :class="{ on: active.includes(d.value) }" :title="d.label" @click="toggle(d.value)">
          <span class="material-symbols-outlined">{{ d.icon }}</span>{{ d.label }}
        </button>
      </span>
    </div>

    <p v-if="!store.activity.length" class="pane-tip">
      Nothing matches those filters.
    </p>

    <div v-for="g in days" :key="g.day" class="act-day">
      <div class="day-head"><span>{{ g.day }}</span></div>
      <div v-for="r in g.rows" :key="r.id" class="act-item">
        <span class="act-dot" :class="r.direction" :title="r.direction">
          <span class="material-symbols-outlined">{{ directionIcon(r.direction) }}</span>
        </span>
        <div class="act-body">
          <p class="act-text">{{ r.text }}</p>
          <!-- provenance: where it came from, what it was worth, what brought
               them. Each part renders only when the row actually carries it —
               content_url/referrer are empty in most deployments. -->
          <div class="act-meta">
            <span class="act-origin">{{ r.plugin || r.channel }}<template v-if="r.source"> · {{ r.source }}</template></span>
            <span v-for="c in metaChips(r.meta)" :key="c.k" class="mchip" :title="c.k">{{ c.v }}</span>
            <span v-if="dwellOf(r.dwell_ms)" class="mchip">{{ dwellOf(r.dwell_ms) }}</span>
            <span v-if="utmOf(r)" class="act-utm">{{ utmOf(r) }}</span>
            <a v-if="r.content_url" :href="r.content_url" target="_blank" rel="noopener" class="act-link">open</a>
          </div>
        </div>
        <span class="act-time">{{ time(r.ts) }}</span>
      </div>
    </div>

    <!-- no button: crossing this line loads the next page. It still says
         something while that happens, so a slow fetch doesn't read as the end
         of the list. -->
    <div v-if="store.activityHasMore" ref="sentinel" class="act-more">
      <span v-if="store.activityLoading">Loading more…</span>
    </div>
  </div>
</template>

<style scoped>
.act-head { display: flex; align-items: center; gap: 12px; }
.act-filters { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.dir-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); background: none; border-radius: 999px; padding: 2px 9px; font: inherit; font-size: 10px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--muted); cursor: pointer; }
.dir-chip:hover { color: var(--text-strong); }
.dir-chip.on { border-color: var(--accent); color: var(--accent); }
.dir-chip .material-symbols-outlined { font-size: 13px; }

/* the day heading carries the date so the rows under it only need a time */
.day-head { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; font-size: 10.5px; font-weight: 600; color: var(--muted); }
.day-head::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--border); }
.act-day:first-of-type .day-head { margin-top: 4px; }

.act-item { display: grid; grid-template-columns: 22px 1fr auto; align-items: start; column-gap: 10px; padding: 7px 0; }
.act-dot { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--panel-2); color: var(--muted); }
.act-dot .material-symbols-outlined { font-size: 13px; }
/* Hue carries ONE message here: money changed hands. Green is already this
   module's "good outcome" (.badge.active / .badge.completed), so conversion
   reuses that meaning rather than inventing one.
   Nothing else gets a hue. Blue is taken — .badge.waiting is blue and the
   enrollment badges sit a few inches up the same pane — so colouring
   `conversation` blue put two unrelated colour systems on one screen. And
   `expression`'s icon was var(--accent), which resolves to #09090b here, so it
   was a near-black glyph on an indigo wash: the one dot whose two halves
   disagreed.
   `expression` is the next most telling (they acted; we didn't), so it gets
   weight instead of hue — same grey chip, darker glyph. The four stay
   distinguishable by their glyph, which is what actually names them. */
.act-dot.conversion { background: rgba(22,163,74,.12); color: #16a34a; }
.act-dot.expression { color: var(--text-strong); }

.act-body { min-width: 0; }
/* wraps — this is a sentence, not a cell. Ellipsizing it would hide the part
   that distinguishes one row from the next. */
.act-text { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text-strong); }
.act-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 3px; font-size: 10.5px; color: var(--muted); }
.act-origin { font-weight: 600; }
.act-utm { font-family: ui-monospace, monospace; opacity: .8; }
.act-link { color: var(--accent); text-decoration: none; }
.act-link:hover { text-decoration: underline; }
.act-time { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 4px; }

.act-more { min-height: 1px; margin-top: 8px; font-size: 10.5px; color: var(--muted); }
</style>
