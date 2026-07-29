<script setup lang="ts">
// What actually happened, once a campaign has really sent.
//
// Two rows, because they answer two different questions and mixing them
// misleads: REACH is who we could have reached and why the rest fell out
// (recorded per send run, pre-flight), DELIVERY is what the provider then did
// with the ones we handed over. A recipient dropped for consent never appears
// in delivery at all, so showing both as one funnel would imply a failure that
// never happened.
//
// The delivery numbers are cumulative, not exclusive — an opened message is
// also a delivered one. Percentages are against `sent` for that reason.
import { computed } from 'vue'

const props = defineProps<{ results: any; reportId?: string | null }>()
const emit = defineEmits<{ (e: 'open-report'): void }>()

// email and sms carry different stages — sms has no open pixel, and a click is
// only knowable through a shortened link, which is a different join entirely
const EMAIL_STAGES = [
  { key: 'sent', label: 'Sent' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
]
const SMS_STAGES = [
  { key: 'sent', label: 'Sent' },
  { key: 'delivered', label: 'Delivered' },
]
// shown only when non-zero — a campaign with no bounces shouldn't display a
// row of zeroes implying something to look at
const PROBLEMS = [
  { key: 'failed', label: 'Failed' },
  { key: 'bounced', label: 'Bounced' },
  { key: 'undelivered', label: 'Undelivered' },
  { key: 'complained', label: 'Complaints' },
]

const channels = computed(() => Object.entries(props.results?.delivery || {})
  .map(([channel, d]: [string, any]) => ({
    channel,
    unavailable: d?.unavailable as string | undefined,
    stages: (channel === 'sms' ? SMS_STAGES : EMAIL_STAGES).map(s => ({ ...s, n: d?.[s.key] ?? 0 })),
    problems: PROBLEMS.filter(p => (d?.[p.key] ?? 0) > 0).map(p => ({ ...p, n: d[p.key] })),
    sent: d?.sent ?? 0,
  })))

const reach = computed(() => props.results?.reach)
// suppressed / no-consent are only worth naming when they actually removed
// someone — on a clean list they'd just be noise
const dropped = computed(() => [
  { label: 'Suppressed', n: reach.value?.suppressed ?? 0 },
  { label: 'No consent', n: reach.value?.no_consent ?? 0 },
].filter(d => d.n > 0))

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '')
const fmt = (n: number) => (n ?? 0).toLocaleString()
const fmtDate = (s: string) => (s ? new Date(s).toLocaleString() : '')
</script>

<template>
  <div class="res-block">
    <div class="blk-head">Results</div>

    <!-- only bulk runs record pre-flight reach; a journey-triggered send has
         none, and a row of zeroes would read as "nobody was reachable" -->
    <div v-if="results.runs.length" class="res-reach">
      <span class="rr-item"><b>{{ fmt(reach.resolved) }}</b> resolved</span>
      <span class="rr-sep">→</span>
      <span class="rr-item"><b>{{ fmt(reach.deliverable) }}</b> deliverable</span>
      <template v-for="d in dropped" :key="d.label">
        <span class="rr-drop">−{{ fmt(d.n) }} {{ d.label.toLowerCase() }}</span>
      </template>
      <span v-if="results.runs.length > 1" class="rr-runs">across {{ results.runs.length }} sends</span>
      <span v-else-if="results.runs[0]" class="rr-runs">{{ fmtDate(results.runs[0].sent_at) }}</span>
    </div>

    <div v-for="c in channels" :key="c.channel" class="res-channel">
      <div v-if="channels.length > 1" class="rc-name">{{ c.channel }}</div>
      <p v-if="c.unavailable" class="pane-tip">{{ c.unavailable }}</p>
      <template v-else>
        <div class="rc-stages">
          <div v-for="s in c.stages" :key="s.key" class="stage">
            <span class="bs-num">{{ fmt(s.n) }}</span>
            <span class="bs-lbl">{{ s.label }}<span v-if="s.key !== 'sent'" class="stage-pct">{{ pct(s.n, c.sent) }}</span></span>
          </div>
        </div>
        <div v-if="c.problems.length" class="rc-problems">
          <span v-for="p in c.problems" :key="p.key" class="prob">{{ fmt(p.n) }} {{ p.label.toLowerCase() }}</span>
        </div>
      </template>
    </div>

    <!-- the campaign may already carry a linked Analytics report; this block is
         the glance, that's the analysis -->
    <button v-if="reportId" type="button" class="res-report" @click="emit('open-report')">
      <span class="material-symbols-outlined">bar_chart</span> Open the full report
    </button>
  </div>
</template>

<style scoped>
.res-reach { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
.res-reach b { color: var(--text-strong); font-weight: 650; }
.rr-sep { color: var(--border-2); }
.rr-drop { font-size: 11.5px; }
/* pushed to the end of the line — provenance, not a headline number */
.rr-runs { margin-left: auto; font-size: 11.5px; }

.res-channel + .res-channel { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.rc-name { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
/* the same numeral pair the audience counter uses (.bs-num / .bs-lbl), so a
   count reads identically wherever it appears in this pane */
.rc-stages { display: flex; flex-wrap: wrap; gap: 10px; }
/* 1 1 0, not a 90px basis: with a basis the four email stages wrapped and
   left Clicked alone on its own row. Equal shares keep one funnel on one
   line, and min-width stops them collapsing under the widest label. */
.stage { flex: 1 1 0; min-width: 84px; display: flex; flex-direction: column; gap: 2px; background: var(--panel-2); border-radius: 8px; padding: 10px 12px; }
.stage-pct { margin-left: 6px; color: var(--text-strong); font-weight: 650; }

.rc-problems { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.prob { font-size: 11.5px; color: #d97706; background: rgba(217,119,6,.10); border-radius: 999px; padding: 2px 9px; }

.res-report { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; border: none; background: none; padding: 0; cursor: pointer; font: inherit; font-size: 12px; color: var(--accent); }
.res-report .material-symbols-outlined { font-size: 14px; }
</style>
