<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import { onAnalyticsChanged } from './realtime'
import { useAnalyticsStore } from './stores/analytics'
import ReportsList from './components/ReportsList.vue'
import RailSearch from '../../components/RailSearch.vue'
import ComposePane from './components/ComposePane.vue'
import Board from './components/Board.vue'
import './analytics.css'
import SidePaneToggle from '../../components/SidePaneToggle.vue'
import { useSidePaneCollapsed } from '../../components/useSidePaneCollapsed'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''

// Data lives in the store; selection lives in the URL; view/layout stays local here.
// storeToRefs keeps the template's `reports`/`current`/… names unchanged.
const store = useAnalyticsStore()
const { reports, current, widgetData, schema, composing } = storeToRefs(store)
// client-side rail search
const q = ref('')
const filteredReports = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? reports.value.filter((r: any) => (r.name || '').toLowerCase().includes(s)) : reports.value
})

const selectedWidget = ref<any>(null)             // the widget the Query editor is editing (derived from the route)
const mode = ref<'agent' | 'query'>('agent')      // Agent | Query (v-model into ComposePane)
// Compose pane collapsed. Unlike the other modules this pane is a GRID TRACK, so
// the flag also goes on `.console` — see the grid note in side-pane.css.
const paneCollapsed = useSidePaneCollapsed('analytics')

// ── routing: the open report (reportId) and the edited widget (widgetId) live in the
// URL. Clicks push routes; the watchers below turn the route back into store calls +
// local selection. So back/forward, refresh and deep links all work. A widgetId of
// 'new' is the blank builder (a not-yet-saved widget). ──────────────────────────────

// point selectedWidget at the fresh widget object the route names (null for none / 'new')
function resolveSelectedRef() {
  const wid = paramStr(route.params.widgetId)
  selectedWidget.value = wid && wid !== 'new'
    ? (current.value?.widgets?.find((w: any) => w.id === wid) || null)
    : null
}
// derive the compose-pane mode from the route's widgetId: a selection (or 'new') opens
// the Query editor; no widget returns to Agent.
function applyWidgetMode() {
  const wid = paramStr(route.params.widgetId)
  // Only open the builder if the report the route names actually loaded — a stale
  // /<rid>/new whose report 404'd must NOT force the editor open (Save would then
  // create a detached "Untitled report").
  const reportLoaded = current.value?.id === paramStr(route.params.reportId)
  if (reportLoaded && (wid === 'new' || (wid && selectedWidget.value))) { mode.value = 'query' }
  else if (!wid && mode.value === 'query') mode.value = 'agent'
}
// reportId → which report is open. Guarded to this module's route so navigating to
// another module (this component is kept-alive, its watchers still fire) doesn't wipe state.
watch(() => route.params.reportId, async (raw) => {
  if (route.name !== 'analytics') return
  const rid = paramStr(raw)
  if (!rid) { store.clear(); return }
  if (current.value?.id !== rid) await store.openReport(rid)
  resolveSelectedRef(); applyWidgetMode()
}, { immediate: true })
// widgetId → which widget the Query editor edits
watch(() => route.params.widgetId, () => {
  if (route.name !== 'analytics') return
  resolveSelectedRef(); applyWidgetMode()
})

// navigation — clicks/handlers push the route; the watchers above apply it
function goReport(id: string) { router.push({ name: 'analytics', params: { reportId: id } }) }
function goWidget(id: string) { router.push({ name: 'analytics', params: { reportId: current.value?.id, widgetId: id } }) }
// click on empty board space / Query "Cancel" → drop the widget selection, keep the report.
function deselectWidget() {
  if (!paramStr(route.params.widgetId)) return
  router.push({ name: 'analytics', params: { reportId: current.value?.id } })
}
// Cancel from the Query editor: back out fully. Routed when a report is open; otherwise
// (building with no report yet) just reset local state to Agent.
function cancelEdit() {
  if (paramStr(route.params.widgetId)) deselectWidget()
  else { selectedWidget.value = null; mode.value = 'agent' }
}

// Ask → the store fills the report and returns its id; we sync the URL (it's already
// loaded with primed data, so the route watcher won't re-fetch).
async function compose(question: string) {
  const rid = await store.compose(question)
  if (rid && paramStr(route.params.reportId) !== rid) router.replace({ name: 'analytics', params: { reportId: rid } })
}

// Submit from the Query builder: update the selected widget, or create a new one. If
// there's no report yet, the store creates one first; then we route to the new widget.
async function saveWidget(patch: any) {
  let rid = current.value?.id
  if (!rid) { const r = await store.createReport(); if (!r) return; rid = r.id }
  if (selectedWidget.value?.id) {
    await store.updateWidget(selectedWidget.value.id, patch)
  } else {
    const row = await store.addWidget(rid, { ...patch, provenance: 'human' })
    if (row) goWidget(row.id)                              // select & edit the new widget
  }
}

function reorderWidgets(order: string[]) { store.reorderWidgets(order) }

// Explicit report creation — the "+" button. Store creates + opens; we route to it.
async function createReport() {
  const r = await store.createReport()
  if (r) router.push({ name: 'analytics', params: { reportId: r.id } })
}

// confirm before deleting a widget — like report delete, it can't be undone
function removeWidget(id: string) {
  const w = current.value?.widgets?.find((x: any) => x.id === id)
  confirm.require({
    header: 'Delete widget',
    message: `Delete “${w?.title || 'this widget'}”? This can’t be undone.`,
    icon: 'pi pi-trash',
    defaultFocus: 'reject',
    acceptProps: { label: 'Delete', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: () => store.deleteWidget(id),
  })
}
// confirm before deleting — a report delete cascades all its widgets
function removeReport(report: any) {
  confirm.require({
    header: 'Delete report',
    message: `Delete “${report.name}”? This removes the report and all of its widgets. This can’t be undone.`,
    icon: 'pi pi-trash',
    defaultFocus: 'reject',
    acceptProps: { label: 'Delete', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: () => doDeleteReport(report.id),
  })
}
async function doDeleteReport(id: string) {
  const wasCurrent = await store.deleteReport(id)
  if (wasCurrent) router.push({ name: 'analytics', params: {} })   // watcher → store.clear()
}

// Live sync. Debounced + accumulated so a burst (a compose adding N widgets, or our own
// echoes) collapses into one refresh — by which point our optimistic updates have primed
// widgetData, so openReport(keepData) is a no-op locally but resolves new widgets for OTHER tabs.
let off: (() => void) | undefined
let refreshTimer: any
let touchedCurrent = false
let currentDeleted = false
const staleWidgets = new Set<string>()
function onAnalyticsEvent({ report_id, action, widget_id }: { report_id: string; action: string; widget_id?: string }) {
  if (current.value?.id === report_id) {
    touchedCurrent = true
    if (action === 'report.deleted') currentDeleted = true
    if (action === 'widget.updated' && widget_id) staleWidgets.add(widget_id)   // its data is stale → force re-resolve
  }
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    store.loadReports()                               // rail: create / rename / delete anywhere
    if (touchedCurrent) {
      if (currentDeleted) router.push({ name: 'analytics', params: {} })   // watcher → store.clear()
      else if (current.value) {
        if (staleWidgets.size) store.invalidateWidgets([...staleWidgets])
        store.openReport(current.value.id, { keepData: true })             // open board: widgets / rename / edits
      }
    }
    touchedCurrent = false; currentDeleted = false; staleWidgets.clear()
  }, 300)
}
onMounted(async () => {
  await store.loadReports()
  store.loadSchema()
  off = onAnalyticsChanged(onAnalyticsEvent)
})
onUnmounted(() => { off?.(); clearTimeout(refreshTimer) })
// kept-alive across module switches: onMounted doesn't re-run on return, so refresh the
// reports rail — a missed first load (or a report created elsewhere) shouldn't need a
// full refresh.
onActivated(() => { store.loadReports() })
</script>

<template>
  <div class="console" :class="{ 'is-right-collapsed': paneCollapsed }">
    <aside class="left">
      <ReportsList :reports="filteredReports" :current-id="current?.id"
        @open="goReport" @new="createReport" @remove="removeReport" />
      <RailSearch v-model="q" placeholder="Search reports" />
    </aside>
    <main class="center">
      <Board :report="current" :data="widgetData" :selected-id="selectedWidget?.id"
        @remove="removeWidget" @select="goWidget" @reorder="reorderWidgets" @deselect="deselectWidget" />
    </main>
    <section class="right side-pane" :class="{ 'is-collapsed': paneCollapsed }">
      <SidePaneToggle v-model="paneCollapsed" />
      <ComposePane v-model:mode="mode" :composing="composing" :report="current" :selected-widget="selectedWidget" :schema="schema"
        @compose="compose" @save="saveWidget" @cancel="cancelEdit" />
    </section>
  </div>
  <ConfirmDialog />
</template>
