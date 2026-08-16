<script setup lang="ts">
// Journeys module — multi-step, trigger-driven automation. Same 3-pane shape
// as the rest of the app: left = saved journeys, center = the step graph
// canvas (the thing you're building — Analytics' Board role), right = an
// accordion of Trigger/Enrollments/Node-editor settings (Analytics' ComposePane
// role, same shape as Campaigns' Audiences/Delivery/Objectives accordion).
// A journey's trigger + dedupe + step graph is one draft, saved as a whole
// via the same save/discard pattern as every other editor in this app — the
// pinned Discard/Save bar lives in the CENTER pane (with the canvas), not the
// accordion, since it's the center pane's own record being committed. The
// NAME is independent of that draft — renamed inline from the center header
// and committed immediately, exactly like Analytics' report rename.
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import SidePane from '../../components/SidePane.vue'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Accordion from 'primevue/accordion'
import AccordionPanel from 'primevue/accordionpanel'
import AccordionHeader from 'primevue/accordionheader'
import AccordionContent from 'primevue/accordioncontent'
import { VueFlow, applyNodeChanges, applyEdgeChanges, addEdge } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import StepCard from './StepCard.vue'
import RailPane from '../../components/RailPane.vue'
// every step kind's icon/label/default config/editor component lives in one
// registry — this file stays generic over step kinds and never enumerates them
import { STEP_KINDS, PALETTE, type StepVocab } from './steps'
import { factKeyOptions } from '../../shared/query/constants'
import TriggerPanel from './panels/TriggerPanel.vue'
import EnrollmentsPanel from './panels/EnrollmentsPanel.vue'
import GoalPanel from './panels/GoalPanel.vue'
import StepEditorPanel from './panels/StepEditorPanel.vue'
import './panels/panel.css'
import { useJourneysStore } from './stores/journeys'
import { useAudiencesStore } from '../analytics/stores/audiences'
import { useCampaignsStore } from '../campaigns/stores/campaigns'
import { api as analyticsApi } from '../analytics/api'
import { useAuthStore } from '../../shell/stores/auth'
import { notifyError } from '../../shell/toast'


const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useJourneysStore()
const audStore = useAudiencesStore()
const campStore = useCampaignsStore()
const authStore = useAuthStore()
// `enrollments` is read here only for the accordion header's count — the
// panel itself gets it from the store directly. Loaded eagerly on select, so
// the count is right while the panel is still collapsed.
const { journeys, eventsRegistry, eventFamilies, stepCounts, enrollments } = storeToRefs(store)
const { audiences, segments } = storeToRefs(audStore)
const { campaigns } = storeToRefs(campStore)
const canWrite = computed(() => authStore.hasPermission('journeys:write'))
// Audiences is an OPTIONAL dependency of this module: event triggers and
// fact/activity branches work without it, only the audience-backed affordances
// don't. A missing plugin leaves no audiences:* key in the permission catalog
// (see oauth's expandPermissions), so this one check answers both "is the
// plugin deployed?" and "may this user read audiences?" — which want the same
// UI either way.
const canAudiences = computed(() => authStore.hasPermission('audiences:read'))

// Step editors that reference the wider data model — branch's condition
// builder, Set Fact's key/value autocompletes — read that vocabulary from the
// analytics schema, the same generic, already-authenticated endpoint Analytics
// itself calls. Bundled into one `vocab` object so every editor shares a single
// prop signature and the pane can render them through <component :is>.
const analyticsSchema = ref<any>(null)
const stepVocab = computed<StepVocab>(() => ({
  audiences: audiences.value,
  lists: lists.value,
  campaigns: campaigns.value,
  canAudiences: canAudiences.value,
  factKeys: factKeyOptions(analyticsSchema.value),
  eventOpts: (analyticsSchema.value?.events || []).map((e: string) => ({ label: e, value: e })),
  campaignOpts: (analyticsSchema.value?.campaigns || []).map((c: string) => ({ label: c, value: c })),
}))

// client-side rail search
// The rail is a SERVER query now, not a filter over a list already in memory:
// `q` lives in the store, is debounced there, and comes back as one page plus
// the real total. The whole-journeys catalogue is a separate ref — see the store.
const { rows: railRows, total: railTotal, q } = storeToRefs(store)
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' }

// ── the open journey: `working` is the last-loaded server row; `draft` is the
// editable trigger/dedupe buffer (name is edited separately — see commitName
// below); the step graph lives directly in the Vue Flow `nodes`/`edges` refs
// below (steps.entry/nodes are derived from them on save, and a JSON
// snapshot of them feeds the dirty check). ──
const working = ref<any>(null)
const draft = ref<any>(null)
const entryId = ref<string | null>(null)
const nodes = ref<any[]>([])
const edges = ref<any[]>([])
const loadedSnapshot = ref('')
const saving = ref(false)
// right-pane accordion — resets to the first panel every time a different
// journey loads (see loadIntoEditor), same convention as Audiences'/
// Campaigns' activePanel.
const activePanel = ref<'trigger' | 'goal' | 'enrollments' | 'editor'>('trigger')
// fit-view-on-init only ever fires once (the very first pane-ready) — driving
// it by hand instead means switching journeys re-frames the view too.
// The instance MUST come from @pane-ready's payload, not a bare useVueFlow()
// call here — called in the parent, before <VueFlow> itself has mounted,
// useVueFlow() resolves to a different (nodeless) store instance.
//
// A FIXED zoom (not fitView/fitBounds's auto-computed scale) deliberately —
// a per-journey best-fit zoom means every switch reflows the view to a
// different scale, which reads as the canvas randomly zooming in and out.
// setCenter still re-frames the pan per journey (so a graph off in some
// corner isn't left off-screen), just never changes the zoom level itself.
const CARD_W = 190, CARD_H = 90   // StepCard.vue's fixed width + a rough max height (branch labels extend below)
const FIXED_ZOOM = 1
const TOP_GAP = 32   // breathing room between the floating palette bar and the topmost node
let flowInstance: any = null
const paletteRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLElement | null>(null)
// setViewport() silently no-ops until vue-flow's own ResizeObserver has
// measured the pane (its internal viewportInitialized flips true a tick
// after pane-ready fires, not synchronously with it) — a double rAF lets
// that measurement land before the very first fitToView() call.
function onPaneReady(instance: any) { flowInstance = instance; requestAnimationFrame(() => requestAnimationFrame(fitToView)) }
// Horizontally centered (unchanged), but vertically TOP-anchored rather than
// centered — a centered bounding box means the topmost node lands wherever
// the graph happens to be tall, which on a short graph can tuck it right
// behind the palette bar. Anchoring it a fixed gap below the palette's own
// (possibly wrapped, 1- or 2-row) rendered height keeps that gap consistent
// regardless of graph height or palette row count.
function fitToView() {
  if (!flowInstance || !nodes.value.length || !canvasRef.value) return
  const xs = nodes.value.map((n: any) => n.position.x)
  const ys = nodes.value.map((n: any) => n.position.y)
  const centerX = (Math.min(...xs) + Math.max(...xs) + CARD_W) / 2
  const topY = Math.min(...ys)
  const topInset = (paletteRef.value ? paletteRef.value.offsetTop + paletteRef.value.offsetHeight : 0) + TOP_GAP
  const width = canvasRef.value.clientWidth
  flowInstance.setViewport({ x: width / 2 - centerX * FIXED_ZOOM, y: topInset - topY * FIXED_ZOOM, zoom: FIXED_ZOOM })
}

const isEditable = computed(() => !working.value || working.value.status === 'draft' || working.value.status === 'paused')
// gates the step-config modal's own fields/actions — separate from isEditable
// itself so the modal can still OPEN read-only on a locked (active) journey
// (viewing a step's config is harmless; changing it isn't).
const stepLocked = computed(() => !isEditable.value || !canWrite.value)

function nodesFromSteps(steps: any): any[] {
  if (!steps?.nodes) return []
  // deep-clone each node's config — the inspector pane now mutates
  // `selectedNode.data.config` directly (no buffer+commit step), so this MUST
  // be an independent copy, not the same object referenced by `working`'s
  // last-loaded-from-server snapshot, or a live edit corrupts the very
  // baseline Discard is supposed to revert to.
  return Object.entries(steps.nodes).map(([id, node]: [string, any]) => ({
    id, type: 'step', position: node.position ? { ...node.position } : { x: 0, y: 0 },
    data: { kind: node.kind, label: node.label, config: JSON.parse(JSON.stringify(node.config || {})) },
  }))
}
function edgesFromSteps(steps: any): any[] {
  if (!steps?.nodes) return []
  const out: any[] = []
  for (const [id, node] of Object.entries(steps.nodes) as [string, any][]) {
    if (node.kind === 'branch') {
      if (node.on_true) out.push({ id: `${id}-true`, source: id, sourceHandle: 'true', target: node.on_true, label: 'Yes' })
      if (node.on_false) out.push({ id: `${id}-false`, source: id, sourceHandle: 'false', target: node.on_false, label: 'No' })
    } else if (node.next) {
      out.push({ id: `${id}-next`, source: id, target: node.next })
    }
  }
  return out
}
// The inverse — walks the CURRENT canvas state back into a {entry, nodes} steps
// object, both for the dirty-check snapshot and for the actual Save payload.
// set_fact's value field is a plain text input (numbers/booleans/JSON typed
// as a string while editing) — coerced to real JSON here, at serialization
// time, rather than on every keystroke, so the input can hold "true"/"42"
// mid-edit without fighting a live type conversion.
function coerceSetFactConfig(config: any): any {
  const raw = config.value
  if (typeof raw !== 'string') return config
  try { return { ...config, value: JSON.parse(raw) } } catch { return config }
}
function stepsFromGraph(): any {
  const nodesMap: Record<string, any> = {}
  for (const n of nodes.value) {
    const config = n.data.kind === 'set_fact' ? coerceSetFactConfig(n.data.config) : n.data.config
    nodesMap[n.id] = { kind: n.data.kind, config, position: n.position }
    if (n.data.label) nodesMap[n.id].label = n.data.label
  }
  for (const e of edges.value) {
    const n = nodesMap[e.source]; if (!n) continue
    if (n.kind === 'branch') { if (e.sourceHandle === 'true') n.on_true = e.target; else if (e.sourceHandle === 'false') n.on_false = e.target }
    else n.next = e.target
  }
  return { entry: entryId.value || Object.keys(nodesMap)[0] || '', nodes: nodesMap }
}

const currentSnapshot = computed(() => JSON.stringify({ trigger: draft.value?.trigger, dedupe: draft.value?.dedupe, goal: draft.value?.goal ?? null, steps: stepsFromGraph() }))
const dirty = computed(() => !!working.value && currentSnapshot.value !== loadedSnapshot.value)

function loadIntoEditor(row: any) {
  working.value = row
  nameEdit.value = row.name
  draft.value = { trigger: row.trigger || { kind: 'event', event: [] }, dedupe: row.dedupe || { reenroll: false, cooldown_days: null }, goal: row.goal || null }
  nodes.value = nodesFromSteps(row.steps)
  edges.value = edgesFromSteps(row.steps)
  entryId.value = row.steps?.entry || null
  loadedSnapshot.value = currentSnapshot.value
  activePanel.value = 'trigger'
  store.loadResults(row.id)
  // (the enrollment status filter and expanded row live in EnrollmentsPanel and
  // reset themselves when journeyId changes — this used to poke them from here,
  // via two refs that no longer exist)
  store.loadEnrollments(row.id)
  store.loadStepCounts(row.id)
  fitToView()
}

onActivated(async () => {
  await Promise.all([store.loadJourneys(), store.searchJourneys(), audStore.loadAudiences(), audStore.loadSegments(), campStore.loadCampaigns(), store.loadEventsRegistry()])
  applyRoute()
  analyticsApi.schema().then((s: any) => { analyticsSchema.value = s }).catch(() => {})
})

// ── routing: the open journey lives in the URL (/journeys/:journeyId) ──
async function openJourney(id: string) {
  const j = await store.getJourney(id).catch((e: any) => { notifyError(`Couldn't open that journey: ${e.message}`); return null })
  if (j) loadIntoEditor(j)
}
function applyRoute() {
  if (route.name !== 'journeys') return
  const id = paramStr(route.params.journeyId)
  if (!id) { working.value = null; return }
  if (working.value?.id === id) return
  openJourney(id)
}
watch([() => route.params.journeyId, journeys], applyRoute, { immediate: true })
function goJourney(id: string) { router.push({ name: 'journeys', params: { journeyId: id } }) }

// + New seeds a minimal valid graph (name/trigger/steps are all required server-side)
// — a single exit step — then opens it, matching Campaigns'/Audiences' "create then edit" flow.
async function startNew() {
  const id = crypto.randomUUID()
  const row = await store.createJourney({
    name: 'Untitled journey', trigger: { kind: 'event', event: [] },
    steps: { entry: id, nodes: { [id]: { kind: 'exit', config: {}, position: { x: 80, y: 80 } } } },
  }).catch((e: any) => { notifyError(`Couldn't create journey: ${e.message}`); return null })
  if (row) goJourney(row.id)
}
function removeJourney(j: any) {
  confirm.require({
    header: 'Delete journey', message: `Delete “${j.name}”? This can’t be undone — all enrollments and their history go with it.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Delete', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      const open = working.value?.id === j.id
      try { await store.removeJourney(j.id); if (open) { working.value = null; router.replace({ name: 'journeys', params: {} }) } }
      catch (e: any) { notifyError(`Couldn't delete “${j.name}”: ${e.message}`) }
    },
  })
}

// ── save / discard the whole draft (trigger + dedupe + step graph) ──
function discard() { if (working.value) loadIntoEditor(working.value) }
async function save() {
  if (!working.value || !dirty.value || saving.value) return
  const id = working.value.id
  saving.value = true
  try {
    const row = await store.patchJourney(id, { trigger: draft.value.trigger, dedupe: draft.value.dedupe, goal: draft.value.goal, steps: stepsFromGraph() })
    if (working.value?.id !== id) return
    loadIntoEditor(row)
  } catch (e: any) { notifyError(`Couldn't save changes: ${e.message}`) }
  finally { saving.value = false }
}

// ── rename — a plain input styled like a heading at rest (Campaigns'/
// Audiences' .b-name look), but unlike theirs it commits immediately on
// blur/enter via its own API call rather than riding the trigger/dedupe/step
// draft's Save — independent of that draft, exactly like Analytics' report
// rename, so an in-progress unsaved step-graph edit isn't discarded by a
// rename (and vice versa: Discard doesn't undo an already-committed rename). ──
const nameEdit = ref('')
async function commitName() {
  if (!working.value) return
  const name = nameEdit.value.trim() || 'Untitled journey'
  nameEdit.value = name
  if (name === working.value.name) return
  try {
    const row = await store.patchJourney(working.value.id, { name })
    working.value = { ...working.value, name: row.name }
    nameEdit.value = row.name
  } catch (e: any) {
    notifyError(`Couldn't rename: ${e.message}`)
    nameEdit.value = working.value.name
  }
}
function cancelEditName(e: any) { nameEdit.value = working.value?.name || ''; e.target?.blur?.() }

// ── lifecycle actions ──
async function activate() {
  if (!working.value || saving.value) return
  saving.value = true
  try { loadIntoEditor(await store.activateJourney(working.value.id)) }
  catch (e: any) { notifyError(`Couldn't activate: ${e.message}`) }
  finally { saving.value = false }
}
async function pause() {
  if (!working.value || saving.value) return
  saving.value = true
  try { loadIntoEditor(await store.pauseJourney(working.value.id)) }
  catch (e: any) { notifyError(`Couldn't pause: ${e.message}`) }
  finally { saving.value = false }
}

const campaignNameById = computed(() => Object.fromEntries(campaigns.value.map((c: any) => [c.id, c.name])))
// Static lists are just segments with a `list` source, so there's no second
// endpoint to call — the segments the Audiences store already holds, filtered.
const lists = computed(() => segments.value.filter((s: any) => s.source?.list))
const listNameById = computed(() => Object.fromEntries(lists.value.map((l: any) => [l.id, l.name])))

// ── the palette: add a step ── (PALETTE / STEP_KINDS come from steps/index.ts)
function addStep(kind: string) {
  if (!isEditable.value) return
  const id = crypto.randomUUID()
  const selected = nodes.value.find(n => n.id === selectedNodeId.value)
  const position = selected ? { x: selected.position.x, y: selected.position.y + 150 } : { x: 60 + (nodes.value.length % 4) * 220, y: 60 + Math.floor(nodes.value.length / 4) * 170 }
  nodes.value = [...nodes.value, { id, type: 'step', position, data: { kind, config: STEP_KINDS[kind].defaultConfig() } }]
  if (!entryId.value) entryId.value = id
  selectedNodeId.value = id
}
function removeSelectedNode(id: string) {
  nodes.value = nodes.value.filter(n => n.id !== id)
  edges.value = edges.value.filter(e => e.source !== id && e.target !== id)
  if (entryId.value === id) entryId.value = nodes.value[0]?.id || null
}

// ── Vue Flow controlled state ──
function onNodesChange(changes: any[]) { nodes.value = applyNodeChanges(changes, nodes.value) }
function onEdgesChange(changes: any[]) { edges.value = applyEdgeChanges(changes, edges.value) }
function onConnect(connection: any) { edges.value = addEdge({ ...connection, label: connection.sourceHandle === 'true' ? 'Yes' : connection.sourceHandle === 'false' ? 'No' : undefined }, edges.value) }
const selectedNodeId = ref<string | null>(null)
function onNodeClick({ node }: any) { selectedNodeId.value = node.id }
// Discard and clicking away on the canvas are both the same "leave without
// applying" action — the draft below is simply dropped.
function closeStepPanel() { selectedNodeId.value = null }

// ── step inspector — the Editor accordion panel, buffered: fields bind to
// `stepDraft` (a deep clone taken the moment a node is selected), never to
// the live node directly. Save copies the draft onto the real node (which is
// what rides into the journey-level Discard/Save, same as before); Discard
// just drops the draft — the live node is untouched either way until Save. ──
const selectedNode = computed(() => nodes.value.find(n => n.id === selectedNodeId.value) || null)
const stepDraft = ref<{ label?: string; config: any } | null>(null)
const stepDirty = computed(() => {
  if (!selectedNode.value || !stepDraft.value) return false
  return JSON.stringify(stepDraft.value) !== JSON.stringify({ label: selectedNode.value.data.label, config: selectedNode.value.data.config })
})
// This watcher is deliberately kind-agnostic: it only clones the config. Any
// per-kind setup (Wait deriving its display unit, Branch parsing its filter)
// belongs to that kind's own editor, which is keyed on the node id and so gets
// a fresh setup() every time a different step is opened.
watch(selectedNodeId, (id) => {
  const n = nodes.value.find(x => x.id === id)
  if (!n) { stepDraft.value = null; return }
  stepDraft.value = { label: n.data.label, config: JSON.parse(JSON.stringify(n.data.config || {})) }
  activePanel.value = 'editor'   // a node was just picked — jump straight to its properties
})
function confirmStepPanel() {
  if (!selectedNode.value || !stepDraft.value || stepLocked.value) return
  selectedNode.value.data.label = stepDraft.value.label
  selectedNode.value.data.config = JSON.parse(JSON.stringify(stepDraft.value.config))
  selectedNodeId.value = null
}
function deleteSelectedStep() {
  if (!selectedNodeId.value) return
  removeSelectedNode(selectedNodeId.value)
  selectedNodeId.value = null
}
function setEntryToSelected() { if (selectedNodeId.value) entryId.value = selectedNodeId.value }

</script>

<template>
  <div class="jrn-console">
    <!-- left: saved journeys -->
    <aside class="jrn-left">
      <RailPane v-model:q="q" placeholder="Search journeys"
        :total="railTotal" :page="store.page" :page-size="store.pageSize" @update:page="store.goToPage($event)"
        noun="journey">
        <!-- the add action belongs TO the search, not to a header above it:
             finding and creating are the same job at the top of the rail -->
        <template #action>
          <Button text size="small" class="rail-action" aria-label="New journey" :disabled="!canWrite" @click="startNew">
            <template #icon><span class="material-symbols-outlined">add</span></template>
          </Button>
        </template>
        <!-- server-paged: the rows ARE the page -->
        <template #default>
          <li v-for="j in railRows" :key="j.id" class="rail-item" :class="{ on: j.id === working?.id }" @click="goJourney(j.id)">
            <div class="ri-main">
              <span class="ri-name">{{ j.name }}</span>
              <span class="ri-sub">{{ STATUS_LABEL[j.status] }} · {{ j.trigger?.kind }}</span>
            </div>
            <button class="ri-x" title="Delete" :disabled="!canWrite" @click.stop="removeJourney(j)"><span class="material-symbols-outlined">close</span></button>
          </li>
          <li v-if="!railRows.length" class="rail-empty">{{ q ? 'No matches.' : 'No journeys yet — start one with +' }}</li>
        </template>
      </RailPane>
    </aside>

    <!-- center: the step graph canvas — the thing you're building (Analytics'
         Board role). Always rendered, empty-state tip when no journey is
         open. Its header carries the record's editable name, and its own
         pinned Discard/Save bar commits the WHOLE draft (trigger + dedupe +
         this canvas' step graph as one unit) — same pinned-bar convention as
         every other module's center pane, even though what it saves spans
         into the right-pane accordion too. -->
    <section class="jrn-center">
      <div v-if="!working" class="jrn-empty">Pick a journey on the left, or start one with +.</div>
      <template v-else>
        <div class="pane-head">
          <input v-if="isEditable && canWrite" v-model="nameEdit" class="b-name" placeholder="Untitled journey"
            @blur="commitName" @keyup.enter="($event.target as HTMLInputElement).blur()" @keyup.esc="cancelEditName" />
          <span v-else class="b-name-static">{{ working.name }}</span>
          <span class="badge lg" :class="working.status">{{ STATUS_LABEL[working.status] }}</span>
        </div>
        <div class="jrn-canvas" ref="canvasRef">
          <div class="jrn-palette" ref="paletteRef">
            <button v-for="p in PALETTE" :key="p.kind" class="pal-btn" :disabled="!isEditable || !canWrite" :title="`Add ${p.label}`" @click="addStep(p.kind)">
              <span class="material-symbols-outlined" :class="{ fill: p.fill }">{{ p.icon }}</span><span>{{ p.label }}</span>
            </button>
            <p v-if="!isEditable" class="pal-hint"><span class="material-symbols-outlined">lock</span> Pause this journey to edit its steps.</p>
          </div>
          <button v-if="selectedNode && selectedNodeId !== entryId && !stepLocked" type="button" class="set-entry-overlay" @click="setEntryToSelected">
            <span class="material-symbols-outlined">flag</span> Set as entry
          </button>
          <VueFlow v-model:nodes="nodes" v-model:edges="edges" :max-zoom="1.25" :nodes-draggable="isEditable && canWrite"
            :nodes-connectable="isEditable && canWrite" :edges-updatable="false" @nodes-change="onNodesChange" @edges-change="onEdgesChange"
            @connect="onConnect" @node-click="onNodeClick" @pane-click="closeStepPanel" @pane-ready="onPaneReady">
            <template #node-step="nodeProps">
              <StepCard v-bind="nodeProps"
                :campaign-name="nodeProps.data.kind === 'trigger_campaign' ? campaignNameById[nodeProps.data.config.campaign_id] : undefined"
                :list-name="nodeProps.data.kind === 'add_to_list' ? listNameById[nodeProps.data.config.segment_id] : undefined"
                :enrollment-count="stepCounts[nodeProps.id] || 0" />
              <span v-if="nodeProps.id === entryId" class="entry-badge">Entry</span>
            </template>
          </VueFlow>
        </div>
        <div v-if="!isEditable || canWrite" class="b-actions">
          <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discard" />
          <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
          <Button label="Save" size="small" :disabled="!dirty || saving" :loading="saving" @click="save"><template #icon><span class="material-symbols-outlined">check</span></template></Button>
          <Button v-if="working.status === 'draft' || working.status === 'paused'" label="Activate" size="small" :disabled="!canWrite || dirty" :loading="saving" :title="dirty ? 'Save your changes first' : undefined" @click="activate"><template #icon><span class="material-symbols-outlined">play_arrow</span></template></Button>
          <Button v-else-if="working.status === 'active'" label="Pause" size="small" severity="secondary" outlined :disabled="!canWrite" :loading="saving" @click="pause"><template #icon><span class="material-symbols-outlined">pause</span></template></Button>
        </div>
      </template>
    </section>

    <!-- right: Trigger / Enrollments / Node editor — an accordion of settings for
         the open journey (Analytics' ComposePane role, same shape as
         Campaigns' Audiences/Delivery/Objectives accordion). Always
         rendered — each panel shows an empty-state tip when no journey is
         open instead of the whole pane vanishing (same convention as
         Campaigns'/Audiences'/Users' side panes). Resets to the first panel
         every time a different journey loads (see loadIntoEditor). -->
    <SidePane module="journeys" class="jrn-details">
      <Accordion v-model:value="activePanel" class="jrn-accordion pane-accordion">
        <AccordionPanel value="trigger">
          <AccordionHeader>Trigger</AccordionHeader>
          <AccordionContent>
            <TriggerPanel :draft="draft" :audiences="audiences" :events-registry="eventsRegistry" :event-families="eventFamilies"
              :can-audiences="canAudiences" :disabled="!isEditable || !canWrite" :empty="!working" />
          </AccordionContent>
        </AccordionPanel>

        <AccordionPanel value="goal">
          <AccordionHeader>Goal</AccordionHeader>
          <AccordionContent>
            <GoalPanel :draft="draft" :events-registry="eventsRegistry" :event-families="eventFamilies"
              :disabled="!isEditable || !canWrite" :empty="!working" />
          </AccordionContent>
        </AccordionPanel>

        <AccordionPanel value="enrollments">
          <AccordionHeader><span class="acc-title">Enrollments <span class="count-pill sm">{{ enrollments.length }}</span></span></AccordionHeader>
          <AccordionContent>
            <EnrollmentsPanel :journey-id="working?.id" :empty="!working" />
          </AccordionContent>
        </AccordionPanel>

        <AccordionPanel value="editor">
          <AccordionHeader>Node editor</AccordionHeader>
          <AccordionContent>
            <StepEditorPanel :kind="selectedNode?.data.kind" :draft="stepDraft" :vocab="stepVocab"
              :node-id="selectedNodeId" :dirty="stepDirty" :disabled="stepLocked"
              @delete="deleteSelectedStep" @discard="closeStepPanel" @save="confirmStepPanel" />
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </SidePane>

    <ConfirmDialog />
  </div>
</template>

<style scoped>
.jrn-console { display: flex; height: 100%; min-height: 0; }
.jrn-left { flex: none; width: 350px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.jrn-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
/* Geometry (width, border, flex column, background) is SidePane's — see side-pane.css. */
.jrn-empty { margin: auto; color: var(--muted); font-size: 14px; }
.side-body { flex: 1 1 auto; overflow: auto; padding: 18px; }

.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
/* The centre pane's own inset is 16px — the palette floating over the canvas
   and the pinned bottom bar both sit there. .b-name pulls itself left by its
   own padding PLUS its 1px transparent hover border (-11px), so the title TEXT
   lands on that same line while its hover box still extends past it.
   .pane-head is shared with the side panes, which keep 18px. */
.jrn-center .pane-head { padding-left: 16px; }
.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); text-transform: capitalize; }
.ri-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; }
.rail-item:hover .ri-x { opacity: 1; } .ri-x:hover { color: var(--text-strong); }

.jrn-canvas { flex: 1 1 auto; min-height: 0; position: relative; background: var(--panel-2); }
/* floating directly on top of the canvas (not a separate row pushing it
   down) — genuinely transparent, since it's now really an overlay on the
   canvas rather than a sibling bar trying to color-match it. The outer
   element ignores clicks (so empty gaps between buttons don't block
   dragging the canvas underneath); real controls opt back in. */
.jrn-palette { position: absolute; top: 12px; left: 16px; right: 16px; z-index: 5; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; pointer-events: none; }
.jrn-palette > * { pointer-events: auto; }
.pal-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--panel); border-radius: 8px; padding: 6px 11px; font-size: 12px; font-weight: 550; color: var(--text); cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.pal-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.pal-btn:disabled { opacity: .5; cursor: default; }
.pal-btn .material-symbols-outlined { font-size: 11px; }
.pal-hint { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.entry-badge { position: absolute; top: -10px; left: -6px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #fff; background: var(--accent); border-radius: 999px; padding: 2px 7px; pointer-events: none; }
/* floating on top of the canvas rather than in the step inspector's bottom
   bar — it acts on the CANVAS's entry marker, not the step form below. */
.set-entry-overlay { position: absolute; bottom: 12px; left: 16px; z-index: 5; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--panel); border-radius: 999px; padding: 7px 14px; font-size: 12px; font-weight: 600; color: var(--text); cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.set-entry-overlay:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.set-entry-overlay .material-symbols-outlined { font-size: 13px; }

.row { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
/* journey title — same proven pattern as Campaigns'/Audiences' .b-name: a
   plain input that looks like a heading at rest, gains a border on hover,
   and highlights on focus. Unlike theirs it isn't bound to `draft` (see
   commitName above for why). */
.b-name { flex: 1 1 auto; min-width: 0; box-sizing: border-box; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 20px; font-weight: 650; color: var(--text-strong); padding: 6px 10px; margin-left: -11px; transition: border-color .12s, background .12s; }
.b-name:hover { border-color: var(--border); }
.b-name:focus { outline: none; border-color: var(--accent); background: var(--panel); }
/* An active journey isn't renamable, so its title renders as a <span> instead
   of the .b-name <input> above. That span sits in .pane-head, which is an
   uppercase 0.72px-tracked eyebrow bar — and unlike a form control, a span
   inherits both. The result was the same title rendering as
   "Cart Abandonment Recovery" while a draft and "CART ABANDONMENT RECOVERY"
   once activated. Mirror .b-name's box exactly, so activating a journey
   changes nothing about how its name is drawn or where it sits. */
.b-name-static { flex: 1 1 auto; min-width: 0; box-sizing: border-box; margin: 0 0 0 -11px; padding: 6px 10px; border: 1px solid transparent; font-size: 20px; font-weight: 650; text-transform: none; letter-spacing: normal; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Trigger / Enrollments / Node editor accordion — same proven pattern as
   Campaigns'/Audiences' .cmp-accordion/.aud-accordion: 52px box-sized
   headers, the active panel fills all remaining pane height, and the
   unconditional min-height:0 below keeps PrimeVue's collapse animation from
   getting stuck (making the panel a flex container turns .p-accordioncontent
   into a flex item, which defaults to min-height:auto and refuses to shrink
   for the collapse keyframe unless overridden here for every panel, not just
   the active one). */
/* No scrollbar-gutter here. Reserving a gutter squares up the two sides but
   pushes the content inset from 18px to ~34px, which no other module's
   accordion does — conformity with them matters more than the few px of
   asymmetry a classic scrollbar adds, and on overlay scrollbars (the usual
   case) there is no asymmetry to fix. */
/* every divider lives on a header's own border-top (deterministic, hard-clamped to 52px),
   never on flex-grown content — !important wins the specificity tie with PrimeVue's own
   :first-child > .p-accordionheader rule regardless of stylesheet injection order. */
/* ONE scroller: the wrapper above. This element carries the padding, so an
   overflow here draws a second scrollbar whose width comes off the padded
   box — leaving rows inset ~19px left and ~33px right. */
/* Each panel's own look lives in panels/*.vue; the chrome they share with this
   shell (.pane-tip, .sw, .badge, the Discard/Save row) is in panels/panel.css,
   imported above. Nothing here may style a panel's internals — a scoped rule
   can't cross into a child component anyway, and :deep() reaching in would put
   two owners on the same element. */
</style>
