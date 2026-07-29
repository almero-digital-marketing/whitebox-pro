<script setup lang="ts">
// Enrollments panel — the audit view: who is (or was) running this journey,
// filterable by status, each row expanding to its per-step run log.
//
// This one talks to the store directly rather than taking its data as props:
// the list is a server read keyed by journey id + status filter, so owning
// both the filter and the fetch here keeps them in one place instead of
// threading a watcher and three callbacks through the module shell.
import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import { stepMeta } from '../steps'
import JourneyResults from './JourneyResults.vue'
import { useJourneysStore } from '../stores/journeys'
import { notifyError } from '../../../shell/toast'
import './panel.css'

const props = defineProps<{ journeyId?: string | null; empty?: boolean }>()

const store = useJourneysStore()
const { enrollments, currentEnrollment, results } = storeToRefs(store)
const confirm = useConfirm()

// 'all' is a real value, not '' — PrimeVue's Select treats an empty string as
// "nothing selected" and renders a blank box, so the no-filter choice needs a
// sentinel of its own. statusQuery() maps it back to "omit the parameter".
const STATUSES = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Waiting', value: 'waiting' },
  { label: 'Completed', value: 'completed' },
  { label: 'Exited', value: 'exited' },
  { label: 'Failed', value: 'failed' },
]
const status = ref('all')
const expandedId = ref<string | null>(null)
const statusQuery = () => (status.value === 'all' ? undefined : status.value)

watch(status, () => { if (props.journeyId) store.loadEnrollments(props.journeyId, statusQuery()) })
// a different journey resets the view — a filter and an open row from the
// previous one would otherwise carry over and look like this journey's state
watch(() => props.journeyId, () => { status.value = 'all'; expandedId.value = null })

async function toggleRow(e: any) {
  if (expandedId.value === e.id) { expandedId.value = null; return }
  expandedId.value = e.id
  await store.loadEnrollmentDetail(e.id)
}

function exitOne(e: any) {
  confirm.require({
    header: 'Exit enrollment',
    message: `Exit this enrollment for passport ${e.passport_id}? Its pending wait (if any) is cancelled.`,
    icon: 'pi pi-sign-out',
    acceptProps: { label: 'Exit', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      try { await store.exitEnrollment(e.id, 'manual') } catch (err: any) { notifyError(`Couldn't exit enrollment: ${err.message}`) }
    },
  })
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—')
// split for the two-line row's stacked right-hand column
// A step result is a small object; `next_step_id` is just the graph edge the
// canvas already draws, so it's dropped. One level of nesting is flattened so
// `{activation:{sent:true}}` reads as "activation.sent true" rather than JSON.
function resultChips(result: any): string[] {
  if (!result || typeof result !== 'object') return []
  const out: string[] = []
  for (const [k, v] of Object.entries(result)) {
    if (k === 'next_step_id' || v == null || v === '' || v === false) continue
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as any)) {
        if (v2 == null || v2 === '' || v2 === false) continue
        out.push(v2 === true ? `${k}.${k2}` : `${k}.${k2} ${v2}`)
      }
    } else out.push(v === true ? k : `${k} ${v}`)
  }
  return out
}

const fmtDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—')
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
</script>

<template>
  <p v-if="empty" class="pane-tip">Pick or start a journey to see its enrollments.</p>
  <template v-else>
    <!-- the numbers, then the rows behind them — same subject, two
         resolutions, so they share a panel rather than splitting into one more -->
    <JourneyResults v-if="results" :results="results" />

    <div class="enroll-filter">
      <Select v-model="status" :options="STATUSES" option-label="label" option-value="value" size="small" />
    </div>
    <ul class="enroll-list">
      <li v-for="e in enrollments" :key="e.id" class="enroll-item">
        <!-- the same two-line row People's rail uses: identifier over a
             secondary line, date over time on the right. An enrollment carries
             only a passport_id, so line one is its short form — the same thing
             People shows for someone with no email. -->
        <div class="enroll-row-main two-line" @click="toggleRow(e)">
          <span class="ri-name mono">
            <span class="material-symbols-outlined en-caret">{{ expandedId === e.id ? 'expand_more' : 'chevron_right' }}</span>{{ e.passport_id.slice(0, 8) }}
          </span>
          <span class="ri-sub">
            <span class="badge sm" :class="e.status">{{ e.status }}</span>
            <span v-if="e.current_step_id" class="en-step">at {{ e.current_step_id }}</span>
            <button v-if="e.status === 'active' || e.status === 'waiting'" class="en-exit" title="Exit" @click.stop="exitOne(e)">
              <span class="material-symbols-outlined">logout</span>
            </button>
          </span>
          <span class="rw-date">{{ fmtDay(e.enrolled_at) }}</span>
          <span class="rw-time">{{ fmtTime(e.enrolled_at) }}</span>
        </div>
        <!-- what actually happened, as a run of steps rather than a 4-column
             table crammed into a 400px pane. Same two-line row as above, the
             step's own palette icon, and the result as chips instead of raw
             JSON. -->
        <div v-if="expandedId === e.id && currentEnrollment?.id === e.id" class="enroll-detail">
          <div v-for="r in currentEnrollment.step_runs" :key="r.id" class="run-row two-line">
            <span class="ri-name">
              <span class="material-symbols-outlined run-ico">{{ stepMeta(r.kind).icon }}</span>{{ stepMeta(r.kind).label }}
              <span class="run-id">{{ r.step_id }}</span>
            </span>
            <span class="ri-sub">
              <span v-for="c in resultChips(r.result)" :key="c" class="mchip">{{ c }}</span>
              <span v-if="!resultChips(r.result).length" class="run-none">done</span>
            </span>
            <span class="rw-date">{{ fmtDay(r.ran_at) }}</span>
            <span class="rw-time">{{ fmtTime(r.ran_at) }}</span>
          </div>
          <p v-if="!currentEnrollment.step_runs?.length" class="rail-empty">Nothing has run yet.</p>
        </div>
      </li>
      <li v-if="!enrollments.length" class="rail-empty">No enrollments yet.</li>
    </ul>
  </template>
</template>

<style scoped>
/* the stock PrimeVue Select at the pane's own width — the same control every
   other form in the app uses, rather than a bare <select> styled to look
   roughly like one. It spans the pane because it's this panel's only control,
   not a field sharing a row. */
.enroll-filter { margin-bottom: 8px; }
.enroll-filter :deep(.p-select) { width: 100%; }
.enroll-list { list-style: none; margin: 0; padding: 0; }
.enroll-item { border-bottom: 1px solid var(--border); }
/* layout comes from `.two-line` (style.css), shared with People's rail — this
   keeps only what's this row's own */
.enroll-row-main { padding: 8px 2px; cursor: pointer; }
/* the caret rides on line one, before the id, so the two columns stay a clean
   1fr/auto split rather than needing a third track */
.en-caret { font-size: 10px; color: var(--muted); margin-right: 4px; vertical-align: baseline; }
.ri-name.mono { font-family: ui-monospace, monospace; font-size: 12px; }
.en-step { font-variant-numeric: tabular-nums; }
.en-exit { border: none; background: none; color: var(--muted); cursor: pointer; padding: 0; line-height: 1; display: inline-flex; }
.en-exit .material-symbols-outlined { font-size: 12px; }
.en-exit:hover { color: var(--danger, #dc2626); }
/* the run list is indented under its enrollment so the two levels read as
   parent and children rather than one flat list */
.enroll-detail { padding: 2px 0 8px 18px; }
.run-row { padding: 5px 0; }
.run-ico { font-size: 11px; color: var(--muted); margin-right: 5px; vertical-align: baseline; }
.run-row .ri-name { font-size: 12px; font-weight: 550; }
.run-id { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--muted); margin-left: 5px; }
.run-none { font-style: italic; }
</style>
