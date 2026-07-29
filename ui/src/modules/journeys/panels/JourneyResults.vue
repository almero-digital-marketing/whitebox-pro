<script setup lang="ts">
// Did this journey work? Sits above the enrollment list because it's the same
// subject at a different resolution: the numbers, then the rows behind them.
//
// Three bands, and the order is the argument: how many came in, what the
// journey caused to be sent, and how many then did the thing it exists for.
// Deliberately the same shapes Campaigns' ResultsBlock uses — a count is a
// .bs-num over a .bs-lbl wherever it appears.
import { computed } from 'vue'

const props = defineProps<{ results: any }>()

// active/waiting are still in flight; the rest are outcomes. Splitting them
// keeps "12 completed" from reading like a failure when 40 are mid-journey.
const IN_FLIGHT = ['active', 'waiting']
const OUTCOMES = [
  { key: 'completed', label: 'Completed' },
  { key: 'exited', label: 'Exited' },
  { key: 'failed', label: 'Failed' },
]

const e = computed(() => props.results?.enrollments || {})
const inFlight = computed(() => IN_FLIGHT.reduce((a, k) => a + (e.value[k] || 0), 0))
const outcomes = computed(() => OUTCOMES.filter(o => (e.value[o.key] || 0) > 0).map(o => ({ ...o, n: e.value[o.key] })))

const goal = computed(() => props.results?.goal)
const met = computed<number | null>(() => props.results?.goal_met ?? null)
const goalPct = computed(() => (e.value.total > 0 && met.value != null ? Math.round((met.value / e.value.total) * 100) : null))

const channels = computed(() => Object.entries(props.results?.delivery || {}).map(([channel, d]: [string, any]) => ({
  channel,
  sent: d.sent ?? 0,
  // sms has no opens; only show the stages that channel can actually report
  stages: [
    { label: 'Sent', n: d.sent ?? 0 },
    { label: 'Delivered', n: d.delivered ?? 0 },
    ...(d.opened != null ? [{ label: 'Opened', n: d.opened }] : []),
    ...(d.clicked != null ? [{ label: 'Clicked', n: d.clicked }] : []),
  ],
})))

const fmt = (n: number) => (n ?? 0).toLocaleString()
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '')
</script>

<template>
  <div class="jr-results">
    <div class="jr-row">
      <span class="jr-item"><b>{{ fmt(e.total) }}</b> enrolled</span>
      <span v-if="inFlight" class="jr-item"><b>{{ fmt(inFlight) }}</b> in flight</span>
      <span v-for="o in outcomes" :key="o.key" class="jr-drop">{{ fmt(o.n) }} {{ o.label.toLowerCase() }}</span>
    </div>

    <!-- what the journey caused the channels to do, attributed by journey_id -->
    <div v-for="c in channels" :key="c.channel" class="jr-channel">
      <div class="rc-name">{{ c.channel }}</div>
      <div class="jr-stages">
        <div v-for="s in c.stages" :key="s.label" class="stage">
          <span class="bs-num">{{ fmt(s.n) }}</span>
          <span class="bs-lbl">{{ s.label }}<span v-if="s.label !== 'Sent'" class="stage-pct">{{ pct(s.n, c.sent) }}</span></span>
        </div>
      </div>
    </div>

    <!-- the headline, last: everything above is means, this is the end -->
    <div v-if="goal" class="jr-goal">
      <div class="stage goal-stage">
        <span class="bs-num">{{ fmt(met ?? 0) }}</span>
        <span class="bs-lbl">Reached the goal<span v-if="goalPct != null" class="stage-pct">{{ goalPct }}%</span></span>
      </div>
      <p class="jr-goal-def">
        {{ goal.event.join(', ') }}<span v-if="goal.window_days"> · within {{ goal.window_days }} days of enrolling</span>
      </p>
    </div>
    <p v-else class="pane-tip jr-nogoal">No goal set — give this journey one to see whether it worked.</p>
  </div>
</template>

<style scoped>
.jr-results { margin-bottom: 14px; }
.jr-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 12.5px; color: var(--muted); }
.jr-row b { color: var(--text-strong); font-weight: 650; }
.jr-drop { font-size: 11.5px; }

.jr-channel { margin-top: 12px; }
.rc-name { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
/* the pane is 400px, so these wrap where Campaigns' wider centre pane doesn't */
.jr-stages { display: flex; flex-wrap: wrap; gap: 8px; }
.stage { flex: 1 1 0; min-width: 78px; display: flex; flex-direction: column; gap: 2px; background: var(--panel-2); border-radius: 8px; padding: 8px 10px; }
.stage-pct { margin-left: 6px; color: var(--text-strong); font-weight: 650; }

.jr-goal { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
/* the accent marks the one number that answers the question */
.goal-stage { background: var(--accent-soft); }
.goal-stage .bs-num, .goal-stage .stage-pct { color: var(--accent); }
.jr-goal-def { margin: 6px 0 0; font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.jr-nogoal { margin-top: 10px; }
</style>
