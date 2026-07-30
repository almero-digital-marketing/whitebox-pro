<script setup lang="ts">
// Audiences module:
//   left  = saved audiences (pick / + New)
//   mid   = the open audience: AND/OR/NOT composition + live size
//   right = Segments (the building blocks — drag or click into the rule) / Activation,
//           stacked as accordion panels (Segments first, expanded by default)
// An audience is a boolean composition of segments, resolved live at apply-time.
import { ref, computed, watch, nextTick, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Accordion from 'primevue/accordion'
import AccordionPanel from 'primevue/accordionpanel'
import AccordionHeader from 'primevue/accordionheader'
import AccordionContent from 'primevue/accordioncontent'
import RailPane from '../../components/RailPane.vue'
import { useAudiencesStore } from '../analytics/stores/audiences'
import { notifyError } from '../../shell/toast'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useAudiencesStore()
const { segments, audiences, networks } = storeToRefs(store)
// client-side rail search
// The rail is a SERVER query now, not a filter over a list already in memory:
// `q` lives in the store, is debounced there, and comes back as one page plus
// the real total. The whole-audiences catalogue is a separate ref — see the store.
const { rows: railRows, total: railTotal, q } = storeToRefs(store)

// the audience currently open in the builder — a local working copy of its rule
const working = ref<{ id: string | null; name: string; activation_id: string; op: 'all' | 'any'; members: { segment: string; negate: boolean }[]; delivery: Record<string, any>; client_side: boolean; campaigns: boolean }>(
  { id: null, name: 'Untitled audience', activation_id: '', op: 'all', members: [], delivery: {}, client_side: false, campaigns: false },
)
const idEdited = ref(false)   // once the user types an activation id, stop auto-deriving it from the name
const nameEdited = ref(false) // once the user types a name, stop auto-naming from the composition
// Empty-state gate: false only before the very first selection (fresh page load with no
// audienceId in the URL) — same "pick one on the left, or start one with +" placeholder as
// Campaigns/Users. Set true by opening a real audience OR starting a new one, and never
// reset back to false — discard/delete flows already funnel back into newAudience() (a
// fresh draft), never to "nothing selected", so there's no other transition that needs it.
const selected = ref(false)

// right-side pane — Segments / Activation accordion panels; Segments open by default
const activePanel = ref<'segments' | 'activation'>('segments')
const slugify = (s: string) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
function onName() { nameEdited.value = true; dirty.value = true; if (!idEdited.value) working.value.activation_id = slugify(working.value.name) }
function onActivationId(e: Event) { idEdited.value = true; dirty.value = true; working.value.activation_id = slugify((e.target as HTMLInputElement).value) }
const dirty = ref(false)
const saving = ref(false)
const size = ref<number | null>(null)
const sizing = ref(false)

// segment id → its row (name) and its lazily-previewed size, for display in the palette + chips
const segById = computed(() => new Map(segments.value.map((s: any) => [s.id, s])))
const segSizes = ref<Record<string, number | null>>({})
const segName = (id: string) => segById.value.get(id)?.name || 'Segment'
const usedIds = computed(() => new Set(working.value.members.map(m => m.segment)))

// at least one non-negated member → the rule is resolvable (a NOT-only rule has no base)
const hasPositive = computed(() => working.value.members.some(m => !m.negate))
const rule = computed(() => ({ op: working.value.op, members: working.value.members.map(m => ({ segment: m.segment, ...(m.negate ? { negate: true } : {}) })) }))

// onActivated (not onMounted): the module is kept-alive, so onMounted fires only once and a
// missed first load would leave the panes blank until a full refresh. onActivated runs on the
// first show AND every re-entry — so the lists always load, and segments created over in
// Analytics show up when you switch here. Cheap: only un-sized segments are previewed.
onActivated(async () => {
  // searchAudiences() is the rail's page; loadAudiences() is the catalogue the
  // pickers in Campaigns and Journeys read. Both, because this module needs each.
  await Promise.all([store.loadSegments(), store.loadAudiences(), store.searchAudiences(), store.loadNetworks()])
  segments.value.forEach((s: any) => {
    if (segSizes.value[s.id] != null) return
    store.previewSegment(s.source)
      .then((r: any) => { segSizes.value = { ...segSizes.value, [s.id]: r?.est_matches ?? null } })
      .catch(() => {})
  })
})

// ── audience selection ──
function openAudience(a: any) {
  working.value = { id: a.id, name: a.name, activation_id: a.activation_id || '', op: a.rule?.op || 'all', members: (a.rule?.members || []).map((m: any) => ({ segment: m.segment, negate: !!m.negate })), delivery: a.delivery || {}, client_side: !!a.client_side, campaigns: !!a.campaigns }
  idEdited.value = true   // a saved activation id is authoritative — don't overwrite it from the name
  nameEdited.value = true // a saved name is authoritative too — editing the rule won't silently rename it
  dirty.value = false
  activePanel.value = 'segments'
  selected.value = true
}
function newAudience() {
  working.value = { id: null, name: 'Untitled audience', activation_id: '', op: 'all', members: [], delivery: {}, client_side: false, campaigns: false }
  idEdited.value = false; nameEdited.value = false; dirty.value = false; size.value = null
  activePanel.value = 'segments'
  selected.value = true
}

// ── routing: the open audience lives in the URL (/audiences/:audienceId). Clicks push
// routes; this turns the route back into the open builder. Kept-alive across module
// switches, so guard to this module's route. Re-runs when the list loads (deep links). ──
function applyRoute() {
  if (route.name !== 'audiences') return
  const id = paramStr(route.params.audienceId)
  if (!id) { if (working.value.id) newAudience(); return }   // no id → blank builder (don't wipe an in-progress new one)
  if (working.value.id === id) return                        // already open
  const found = audiences.value.find((a: any) => a.id === id)
  if (found) openAudience(found)
}
watch([() => route.params.audienceId, audiences], applyRoute, { immediate: true })
function goAudience(id: string) { router.push({ name: 'audiences', params: { audienceId: id } }) }
function startNew() { router.push({ name: 'audiences', params: {} }) }

// ── rule edits (add via drag or click; toggle AND/NOT; remove) ──
const isEveryone = (id: string) => { const s: any = segById.value.get(id); return !!(s?.origin?.system || s?.name === 'Everyone') }
// ── inline rename of a segment (palette) ──
const editingId = ref<string | null>(null)
const editName = ref('')
function startRename(s: any) {
  editingId.value = s.id; editName.value = s.name
  nextTick(() => { const el = document.querySelector('.sp-edit') as HTMLInputElement | null; el?.focus(); el?.select() })
}
function cancelRename() { editingId.value = null }
function commitRename(s: any) {
  const wasEditing = editingId.value === s.id
  const name = editName.value.trim()
  // Deferred, not immediate: blur always fires before the click that dismisses it (e.g.
  // clicking a different segment pill to end the rename), so clearing editingId here
  // synchronously would make it read false by the time that click's addMember runs —
  // silently adding whatever segment the pointer happened to land on. Clearing it a tick
  // later means it's still true for that click, so addMember's guard actually blocks it.
  setTimeout(() => { editingId.value = null }, 0)
  if (!wasEditing || !name || name === s.name) return
  store.renameSegment(s.id, name).catch(() => { /* keep the old name on failure */ })
}

function addMember(segmentId: string) {
  if (!selected.value) return   // no audience open yet — nothing to add this segment to
  if (editingId.value) return
  if (!segmentId || usedIds.value.has(segmentId)) return
  // "Everyone AND segment" is just the segment; the useful pattern is "Everyone AND NOT
  // segment", so once Everyone anchors the audience, new segments come in as exclusions.
  const negate = !isEveryone(segmentId) && working.value.members.some(m => isEveryone(m.segment))
  working.value.members.push({ segment: segmentId, negate }); dirty.value = true
}
function removeMember(i: number) { working.value.members.splice(i, 1); dirty.value = true }
function toggleNegate(m: any) { m.negate = !m.negate; dirty.value = true }
function setOp(op: 'all' | 'any') { working.value.op = op; dirty.value = true }

// native drag-drop: a segment from the palette → the rule drop zone
const draggingId = ref<string | null>(null)
const dropActive = ref(false)
function onDrop() { if (draggingId.value) addMember(draggingId.value); draggingId.value = null; dropActive.value = false }

// ── live size: re-preview whenever the rule changes (debounced) ──
let pvTimer: any
watch(rule, () => {
  clearTimeout(pvTimer)
  if (!hasPositive.value) { size.value = null; sizing.value = false; return }
  sizing.value = true
  pvTimer = setTimeout(async () => {
    const snapshot = JSON.stringify(rule.value)
    try { const r = await store.previewAudience(rule.value); if (snapshot === JSON.stringify(rule.value)) { size.value = r?.est_matches ?? null; sizing.value = false } }
    catch { sizing.value = false }
  }, 300)
}, { deep: true, immediate: true })

// ── auto-name: until the user types a name of their own, name the audience from its
// composition on every rule change (the AI labels include/exclude segment names + match
// mode). Debounced — it's an AI call. The activation id keeps following the name. ──
let nameTimer: any
watch(rule, () => {
  if (nameEdited.value) return
  clearTimeout(nameTimer)
  if (!working.value.members.length) {                          // empty rule → back to the placeholder name
    working.value.name = 'Untitled audience'
    if (!idEdited.value) working.value.activation_id = ''
    return
  }
  nameTimer = setTimeout(async () => {
    if (nameEdited.value) return
    const snapshot = JSON.stringify(rule.value)
    try {
      const r = await store.nameAudience(rule.value)
      if (nameEdited.value || snapshot !== JSON.stringify(rule.value)) return   // user named it, or the rule moved on
      if (r?.name) { working.value.name = r.name; if (!idEdited.value) working.value.activation_id = slugify(r.name) }
    } catch { /* keep the current name on failure */ }
  }, 700)
}, { deep: true })

async function save() {
  if (!hasPositive.value || saving.value) return
  saving.value = true
  try {
    const row = await store.saveAudience({ id: working.value.id || undefined, name: working.value.name?.trim() || 'Untitled audience', activation_id: working.value.activation_id || undefined, rule: rule.value })
    working.value.id = row.id; working.value.activation_id = row.activation_id || ''; dirty.value = false   // backend may have deduped it
    if (paramStr(route.params.audienceId) !== row.id) router.replace({ name: 'audiences', params: { audienceId: row.id } })   // reflect the new id in the URL
  } catch (e: any) { notifyError(`Couldn't save the audience: ${e.message}`) }
  finally { saving.value = false }
}
// Discard: an existing audience reverts to its last-saved row (still sitting untouched in
// the store); a never-saved draft just goes back to blank — same "Discard" affordance used
// throughout Users.vue (profile/permissions/password), so editors behave the same everywhere.
function discardAudience() {
  if (working.value.id) {
    const found = audiences.value.find((a: any) => a.id === working.value.id)
    if (found) openAudience(found)
  } else {
    newAudience()
  }
}
function removeAudience(a: any) {
  confirm.require({
    header: 'Delete audience', message: `Delete “${a.name}”? This can’t be undone.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Delete', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      const wasOpen = working.value.id === a.id
      try { await store.removeAudience(a.id); if (wasOpen) startNew() }
      catch (e: any) { notifyError(`Couldn't delete “${a.name}”: ${e.message}`) }
    },
  })
}
const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString())

// ── delivery / activation ──
// Display metadata (label + brand dot) for the ad networks we support — the server's
// /networks doesn't carry branding. The CONNECTION status comes from the server, though:
// a network is deliverable only if it reports a configured, eligible adapter.
const NETWORK_META: Record<string, { label: string; dot: string }> = {
  meta: { label: 'Meta Ads', dot: '#185FA5' },
  google: { label: 'Google Ads', dot: '#3B6D11' },
  tiktok: { label: 'TikTok Ads', dot: '#9333ea' },
}
// supported networks ∪ any extra adapter the server reports, each with its live status.
// `connected` (an eligible server adapter) decides live toggle vs "Connect" prompt — so a
// network without a configured adapter can never be toggled into a silent dry-run.
const channels = computed(() => {
  const nets = networks.value || []
  const byName = new Map(nets.map((n: any) => [n.name, n]))
  const names = [...new Set([...Object.keys(NETWORK_META), ...nets.map((n: any) => n.name)])]
  return names.map(name => {
    const meta = NETWORK_META[name] || { label: name.charAt(0).toUpperCase() + name.slice(1), dot: 'var(--border-2)' }
    return { name, label: meta.label, dot: meta.dot, connected: byName.get(name)?.eligible === true }
  })
})
function ago(iso?: string) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
function netStatus(n: any) {                                  // only shown for connected networks
  const d = working.value.delivery?.[n.name]
  if (d?.enabled) return `live · synced ${ago(d.last_synced_at)}${d.dry_run ? ' · dry-run' : ''}`
  if (d?.last_synced_at) return `off · last synced ${ago(d.last_synced_at)}`
  return 'connected · not delivering'
}
const netOn = (n: any) => !!working.value.delivery?.[n.name]?.enabled

// A network with no configured server adapter: there's no live connect flow in-app (the
// adapter + credentials are set up server-side), so explain that rather than fake a toggle.
function connectNetwork(ch: any) {
  confirm.require({
    header: `Connect ${ch.label}`,
    message: `${ch.label} has no delivery adapter configured on the server yet. Add its CAPI adapter (with credentials) to the audiences plugin config — it then appears here as a live delivery toggle.`,
    icon: 'pi pi-link',
    acceptProps: { label: 'Got it' },
    rejectProps: { style: 'display:none' },
  })
}

// Client-side availability — whether the on-site SDK can read this audience's membership.
// First-party + immediate (no confirm): nothing leaves to a third party, it just flips a
// flag the membership endpoint honours. Must be saved first (the client reads by activation id).
async function toggleClientSide() {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()
  if (!working.value.id) return   // the save above failed (already toasted) — nothing to toggle yet
  try {
    const row = await store.setClientSide(working.value.id!, !working.value.client_side)
    working.value.client_side = !!row.client_side
  } catch (e: any) { notifyError(`Couldn't update client-side availability: ${e.message}`) }
}

// Campaigns availability — whether this audience can be picked as a send target in the
// Campaigns module (email & SMS). First-party + immediate, like client-side.
async function toggleCampaigns() {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()
  if (!working.value.id) return   // the save above failed (already toasted) — nothing to toggle yet
  try {
    const row = await store.setCampaigns(working.value.id!, !working.value.campaigns)
    working.value.campaigns = !!row.campaigns
  } catch (e: any) { notifyError(`Couldn't update campaigns availability: ${e.message}`) }
}

// Toggling delivery. Turning OFF is immediate (safe). Turning ON previews the
// deliverable cohort and asks before any data leaves to the network.
async function toggleNetwork(n: any) {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()          // must be saved to deliver
  if (!working.value.id) return   // the save above failed (already toasted) — nothing to deliver yet
  const id = working.value.id!
  if (netOn(n)) {
    try { const row = await store.setDelivery(id, n.name, false); working.value.delivery = row.delivery || {} }
    catch (e: any) { notifyError(`Couldn't turn off delivery to ${n.label}: ${e.message}`) }
    return
  }
  let pv: any
  try { pv = await store.previewDelivery(id) } catch (e: any) { notifyError(`Couldn't preview delivery: ${e.message}`); return }
  const parts = [`${fmt(pv.deliverable)} of ${fmt(pv.resolved)} people will be shared via CAPI`]
  if (pv.suppressed) parts.push(`${pv.suppressed} suppressed excluded`)
  if (pv.no_consent) parts.push(`${pv.no_consent} without consent excluded`)
  confirm.require({
    header: `Send to ${n.label}?`,
    message: `${parts.join(' · ')}.\nShares hashed email / phone. Re-resolves and re-syncs hourly while delivery is on.`,
    icon: 'pi pi-bolt',
    acceptProps: { label: `Send ${fmt(pv.deliverable)}` },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      try { const row = await store.setDelivery(id, n.name, true); working.value.delivery = row.delivery || {} }
      catch (e: any) { notifyError(`Couldn't turn on delivery to ${n.label}: ${e.message}`) }
    },
  })
}
</script>

<template>
  <div class="aud-console">
    <!-- left: saved audiences -->
    <aside class="aud-left">
      <RailPane v-model:q="q" placeholder="Search audiences"
        :total="railTotal" :page="store.page" :page-size="store.pageSize" @update:page="store.goToPage($event)"
        noun="audience">
        <!-- the add action belongs TO the search, not to a header above it:
             finding and creating are the same job at the top of the rail -->
        <template #action>
          <Button text size="small" class="rail-action" aria-label="New audience" @click="startNew">
            <template #icon><span class="material-symbols-outlined">add</span></template>
          </Button>
        </template>
        <!-- server-paged: the rows ARE the page -->
        <template #default>
          <li v-for="a in railRows" :key="a.id" class="rail-item" :class="{ on: a.id === working.id }" @click="goAudience(a.id)">
            <div class="ri-main">
              <span class="ri-name">{{ a.name }}</span>
              <span class="ri-sub">{{ (a.rule?.members?.length || 0) }} segment{{ (a.rule?.members?.length||0) === 1 ? '' : 's' }} · {{ a.rule?.op === 'any' ? 'any' : 'all' }}</span>
            </div>
            <button class="ri-x" title="Delete" @click.stop="removeAudience(a)"><span class="material-symbols-outlined">close</span></button>
          </li>
          <li v-if="!railRows.length" class="rail-empty">{{ q ? 'No matches.' : 'No audiences yet — start one with +' }}</li>
        </template>
      </RailPane>
    </aside>

    <!-- middle: the composition builder -->
    <section class="aud-right">
      <div v-if="!selected" class="placeholder muted">
        <div>
          <h2>WhiteBox Audiences</h2>
          <p>Pick an audience on the left, or start one with +.</p>
        </div>
      </div>
      <div v-else class="builder">
        <div class="b-scroll">
          <div class="b-head">
            <input v-model="working.name" class="b-name" placeholder="Audience name" @input="onName" />
          </div>
          <div class="b-rulebar">
            <span class="b-op">
              <button :class="{ on: working.op === 'all' }" @click="setOp('all')">Match all</button>
              <button :class="{ on: working.op === 'any' }" @click="setOp('any')">Match any</button>
            </span>
            <span class="b-resolve"><span class="material-symbols-outlined">refresh</span> resolved live at delivery</span>
          </div>

          <!-- the rule: segment members + AND/NOT, a drop target. The counter sits inside
               this box (top-right corner) since it's the count this rule produces. -->
          <div class="b-rule" :class="{ drop: dropActive }"
               @dragover.prevent="dropActive = true" @dragleave="dropActive = false" @drop.prevent="onDrop">
            <div class="b-size">
              <span class="bs-num">{{ hasPositive ? (sizing ? '…' : `~${fmt(size)}`) : '—' }}</span><span class="bs-lbl">people</span>
            </div>
            <template v-for="(m, i) in working.members" :key="m.segment">
              <span v-if="i > 0" class="op-join">{{ working.op === 'any' ? 'or' : 'and' }}</span>
              <span class="mem" :class="{ neg: m.negate }">
                <button class="mem-neg" :class="{ on: m.negate }" v-tooltip.top="m.negate ? 'Excluded — click to include' : 'Included — click to exclude'" :aria-label="m.negate ? 'Excluded' : 'Included'" @click="toggleNegate(m)"><span class="material-symbols-outlined">{{ m.negate ? 'block' : 'check' }}</span></button>
                <span class="mem-name">{{ segName(m.segment) }}</span>
                <span class="mem-size">{{ segSizes[m.segment] != null ? `~${fmt(segSizes[m.segment])}` : '' }}</span>
                <button class="mem-x" v-tooltip.top="'Remove'" aria-label="Remove" @click="removeMember(i)"><span class="material-symbols-outlined">close</span></button>
              </span>
            </template>
            <span v-if="!working.members.length" class="b-empty">Drag segments here (or click them) to compose this audience</span>
          </div>
        </div>

        <!-- fixed action bar — same 52px height as the Audiences pane-head -->
        <div class="b-actions">
          <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
          <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discardAudience" />
          <Button :label="working.id ? 'Save changes' : 'Create audience'" size="small" :disabled="!hasPositive || !dirty" :loading="saving" @click="save"><template #icon><span class="material-symbols-outlined">check</span></template></Button>
        </div>
      </div>
    </section>

    <!-- right: Segments (palette) / Activation — stacked accordion panels, Segments first
         and expanded by default. Activation's CAPI send is gated by an explicit confirm
         (preview of the deliverable cohort). -->
    <aside class="aud-side">
      <Accordion v-model:value="activePanel" class="aud-accordion pane-accordion is-content-scroll">
        <AccordionPanel value="segments">
          <AccordionHeader><span class="acc-title">Segments <span class="count-pill sm">{{ working?.members?.length ?? 0 }}</span></span></AccordionHeader>
          <AccordionContent>
            <p class="pane-tip seg-tip">{{ selected ? 'Drag or click a segment into the rule.' : 'Pick or start an audience to add segments to it.' }}</p>
            <ul class="rail-list seg-list">
              <li v-for="s in segments" :key="s.id" class="seg-pill" :class="{ used: usedIds.has(s.id), editing: editingId === s.id, disabled: !selected }"
                  :draggable="selected && editingId !== s.id" @dragstart="draggingId = s.id" @dragend="draggingId = null" @click="addMember(s.id)">
                <!-- the two segment kinds behave differently enough to be worth
                     telling apart at a glance: a query re-resolves every time,
                     a list is whoever was put on it. -->
                <span class="material-symbols-outlined"
                  :title="s.source?.list ? 'Static list — members are assigned by hand' : 'Dynamic segment — re-resolved from its query every time'">{{ s.source?.list ? 'checklist' : 'bolt' }}</span>
                <input v-if="editingId === s.id" class="sp-edit" v-model="editName" @click.stop
                  @keyup.enter="commitRename(s)" @keyup.esc="cancelRename" @blur="commitRename(s)" />
                <span v-else class="sp-name">{{ s.name }}</span>
                <span class="sp-size">{{ segSizes[s.id] != null ? `~${fmt(segSizes[s.id])}` : '' }}</span>
                <span v-if="usedIds.has(s.id)" class="material-symbols-outlined sp-used">check</span>
                <button v-if="editingId !== s.id" class="sp-rename" title="Rename" @click.stop="startRename(s)"><span class="material-symbols-outlined">edit</span></button>
              </li>
              <li v-if="!segments.length" class="rail-empty">No segments yet — create them from a chart in Analytics.</li>
            </ul>
          </AccordionContent>
        </AccordionPanel>
        <AccordionPanel value="activation">
          <AccordionHeader>Activation</AccordionHeader>
          <AccordionContent>
            <p class="pane-tip act-tip">Activate this audience across channels — re-resolved fresh on every sync.</p>
            <!-- activation id — the stable id the client side reads (membership lookup) -->
            <div class="actid-field">
              <label class="actid-label" for="aud-actid">Activation ID</label>
              <div class="actid-input"><input id="aud-actid" :value="working.activation_id" placeholder="activation-id" spellcheck="false" @input="onActivationId" /></div>
              <p class="actid-hint">The id this audience is delivered as — the custom-audience key sent to the ad networks (CAPI), and what the client side reads for membership.</p>
            </div>

            <!-- on-site (client SDK) — a first-party channel: it only exposes membership for your
                 own site/app to read (by activation id). Immediate, no third-party send. -->
            <div class="chan-head">On-site</div>
            <div class="net-row first">
              <span class="dot" :class="{ off: !working.client_side }" :style="working.client_side ? { background: 'var(--accent)' } : {}" />
              <div class="net-main">
                <div class="net-name" :class="{ muted: !working.client_side }">On-site</div>
                <div class="net-sub">{{ working.client_side ? 'readable on your site by activation id' : 'hidden from the client side' }}</div>
              </div>
              <button type="button" class="sw" :class="{ on: working.client_side }" :disabled="!hasPositive" aria-label="Toggle client-side availability" @click="toggleClientSide"><i /></button>
            </div>

            <!-- ad networks (CAPI) — driven by the server's configured adapters. Connected →
                 a live delivery toggle (third-party send, gated by an explicit confirm);
                 not connected → a Connect prompt, never a silent dry-run. -->
            <div class="chan-head">Ad networks</div>
            <div v-for="(ch, ci) in channels" :key="ch.name" class="net-row" :class="{ first: ci === 0 }">
              <span class="dot" :class="{ off: !ch.connected || !netOn(ch) }" :style="(ch.connected && netOn(ch)) ? { background: ch.dot } : {}" />
              <div class="net-main">
                <div class="net-name" :class="{ muted: !ch.connected || !netOn(ch) }">{{ ch.label }}</div>
                <div class="net-sub">{{ ch.connected ? netStatus(ch) : 'not connected' }}<span v-if="ch.connected && netOn(ch) && working.delivery?.[ch.name]?.last_count != null"> · {{ fmt(working.delivery[ch.name].last_count) }} sent</span></div>
              </div>
              <button v-if="ch.connected" type="button" class="sw" :class="{ on: netOn(ch) }" :disabled="!hasPositive" :aria-label="`Toggle ${ch.label}`" @click="toggleNetwork(ch)"><i /></button>
              <button v-else type="button" class="net-connect" @click="connectNetwork(ch)">Connect</button>
            </div>
            <!-- campaigns — your own email & SMS sends. First-party + immediate, like on-site. -->
            <div class="chan-head">Campaigns</div>
            <div class="net-row first">
              <span class="dot" :class="{ off: !working.campaigns }" :style="working.campaigns ? { background: 'var(--accent)' } : {}" />
              <div class="net-main">
                <div class="net-name" :class="{ muted: !working.campaigns }">Email &amp; SMS</div>
                <div class="net-sub">{{ working.campaigns ? 'available as a Campaigns send target' : 'not used by Campaigns' }}</div>
              </div>
              <button type="button" class="sw" :class="{ on: working.campaigns }" :disabled="!hasPositive" aria-label="Toggle Campaigns availability" @click="toggleCampaigns"><i /></button>
            </div>

            <p v-if="!hasPositive" class="act-hint">Compose an audience to enable delivery.</p>
            <p v-else-if="!working.id" class="act-hint">Toggling a channel saves the audience first.</p>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </aside>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.aud-console { display: flex; height: 100%; min-height: 0; }
.aud-left { flex: none; width: 350px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.aud-right { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.aud-side { flex: none; width: 400px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-left: 1px solid var(--border); background: var(--panel); }
/* same empty state as Analytics'/Campaigns'/Users' — shown until the first audience is
   opened or a new one is started */
.placeholder { display: grid; place-items: center; height: 100%; text-align: center; }
.placeholder h2 { margin: 0 0 6px; color: var(--text); }

/* Segments / Activation accordion — headers styled to match this app's 52px pane-head
   rhythm (uppercase, muted, bordered) rather than PrimeVue's default card-like accordion look.
   The active panel's content always fills the remaining pane height (flex chain all the way
   down to the actual scrollable content div), rather than sitting only as tall as its own
   content with dead space below it — collapsed panels just keep their natural 52px header. */
/* min-height:0 here is load-bearing, not cosmetic: making the panel a flex container turns
   .p-accordioncontent into a flex ITEM, and flex items default to min-height:auto — refusing
   to shrink below their own content size. That silently defeats PrimeVue's collapse animation
   (a grid-template-rows 1fr->0fr keyframe on that same element): the grid track collapses but
   the flex item's auto-min-height floor keeps it from ever visually shrinking, so the
   animationend event Vue's <Transition> waits for never fires and the panel gets stuck
   mid-"leave" forever. Applies to every panel (not just active) since this is exactly what
   the COLLAPSING panel needs mid-transition. */
/* the flex-grow/fill treatment below IS scoped to the active panel only — unlike min-height:0
   above, forcing flex-grow on a collapsing panel would fight the animation the same way
   display:flex did before this fix. */
/* Every divider lives on a HEADER (hard-clamped to 52px), never on content (flex-grown,
   fractionally computed — comparing a fixed-height element's border against a flex-grown
   element's border is exactly what caused a sub-pixel mismatch before). A non-first header's
   own border-top marks "start of this header," deterministic regardless of what's above it
   (a collapsed header or a filled/empty panel of any height). An active header's own
   border-bottom marks "start of its own content" — that boundary is far from the next
   header's border-top whenever the panel is actually expanded, so the two borders are never
   adjacent and never double up. PrimeVue's own `:first-child > .p-accordionheader` rule
   resets border-width via a CSS variable at the same specificity as ours — !important
   guarantees we win regardless of stylesheet injection order. */

/* pane header — matches the analytics reports pane (.pane-head): a 52px bar with a
   bottom border, uppercase muted title, space-between */
.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
/* helper tip in the panel body (not the header) — like the analytics agent hint */
.pane-tip { margin: 0; padding: 12px 16px 2px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.act-tip { padding: 0; margin: 0 0 14px; }
.seg-tip { padding: 0; margin: 0 0 12px; }
.seg-list { padding: 0; }   /* .side-body already supplies the surround padding */
.rail-empty { padding: 14px 10px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }

.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: block; font-size: 11px; color: var(--muted); }
.ri-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; }
.rail-item:hover .ri-x { opacity: 1; } .ri-x:hover { color: var(--text-strong); }

/* no audience open yet — clicking/dragging a segment has nothing to add it to (see
   addMember's own guard); renaming still works, so this only dims the look and drops the
   grab affordance rather than blocking pointer-events outright */
.seg-pill.disabled { cursor: default; opacity: .6; }
/* borderless inline editor that matches the name's box exactly (no padding/border ⇒ no height jump) */
.sp-edit { flex: 1 1 auto; min-width: 0; border: none; outline: none; padding: 0; margin: 0; background: transparent; font: inherit; font-size: 12.5px; line-height: inherit; color: var(--text); }
/* on hover, the count + used-tick are hidden (space kept ⇒ no layout shift) and the rename pen
   is overlaid on the far right (absolute ⇒ also no shift) */
.sp-rename { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); border: none; background: none; color: var(--muted); cursor: pointer; padding: 0; line-height: 1; display: none; }
.sp-rename .material-symbols-outlined { font-size: 12px; }
/* dragging a segment into the rule is an Audiences affordance — People's
   copy of this pill is click-only, so the grab cursor stays here */
.aud-side .seg-pill { cursor: grab; }
.seg-pill:hover .sp-rename { display: inline-flex; }
.seg-pill:hover .sp-size, .seg-pill:hover .sp-used { visibility: hidden; }
.sp-rename:hover { color: var(--text-strong); }
.seg-pill.editing { cursor: default; }

.builder { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.b-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 18px; padding: 9px 16px 22px; }
.b-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
/* reads as a heading at rest; becomes a regular input box (border + bg) on hover/focus.
   transparent border + negative margin keep the resting position so nothing shifts. */
.b-name { flex: 1 1 auto; min-width: 0; box-sizing: border-box; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 20px; font-weight: 650; color: var(--text-strong); padding: 6px 10px; margin-left: -10px; transition: border-color .12s, background .12s; }
.b-name:hover { border-color: var(--border); }
.b-name:focus { outline: none; border-color: var(--accent); background: var(--panel); }
.b-size { display: flex; align-items: baseline; gap: 5px; background: var(--panel-2); border-radius: 8px; padding: 5px 12px; }
.bs-num { font-size: 20px; font-weight: 650; color: var(--text-strong); } .bs-lbl { font-size: 12px; color: var(--muted); }

/* margin-bottom counteracts .b-scroll's own 18px flex gap (which applies between every
   child) down to a tight 6px — the toggle directly governs the rule box right below it,
   so they should read as one unit, unlike the more generous gap elsewhere in this pane. */
.b-rulebar { display: flex; align-items: center; gap: 12px; margin-bottom: -12px; }
.b-op { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.b-op button { border: none; background: none; font: inherit; font-size: 12px; padding: 5px 11px; cursor: pointer; color: var(--muted); }
.b-op button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.b-resolve { font-size: 11.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px; }

/* padding-right reserves the strip the absolutely-positioned counter sits in.
   Without it a second chip wraps straight underneath "~13 deliverable" — the
   counter is out of flow, so nothing else knows it is there. .b-size is capped
   to that same strip so a seven-figure count can't grow back over the chips. */
.b-rule { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 68px; padding: 14px 150px 14px 14px; border: 1.5px dashed var(--border); border-radius: 10px; }
/* the counter badge — inside the box it counts, pinned to its corner rather than
   flowing with the segment pills */
.b-rule .b-size { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); max-width: 138px; }
.b-rule.drop { border-color: var(--accent); background: var(--accent-soft); }
/* leaves room on the right for the .b-size counter badge (pinned there, see .b-rule
   .b-size below) so the hint text wraps before reaching it instead of running underneath */
.b-empty { font-size: 12.5px; color: var(--muted); }
.op-join { font-size: 11px; font-weight: 600; color: var(--muted); }
.mem { display: inline-flex; align-items: center; gap: 7px; padding: 6px 8px 6px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; font-size: 13px; }
.mem.neg { background: var(--danger-soft, rgba(239,68,68,.08)); border-color: rgba(239,68,68,.25); }
.mem-name { font-weight: 550; color: var(--text-strong); }
.mem-size { font-size: 11px; color: var(--muted); }
.mem-neg { display: inline-flex; align-items: center; border: none; background: none; cursor: pointer; padding: 0 1px; color: var(--muted); }
.mem-neg .material-symbols-outlined { font-size: 12px; }
.mem-neg:hover { color: var(--text-strong); }
.mem-neg.on { color: var(--danger); }
.mem-neg.on:hover { color: var(--danger); }
.mem-x { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 11px; padding: 0; }
.mem-x:hover { color: var(--text-strong); }

.b-actions { box-sizing: border-box; flex: 0 0 52px; height: 52px; min-height: 52px; max-height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-top: 1px solid var(--border); }
/* same "note fades, buttons disable rather than hide" save/discard behavior as Users.vue's
   profile/permissions/password editors — kept in sync with those class names on purpose */
.save-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-right: auto; }
.save-note .material-symbols-outlined { font-size: 8px; color: #d97706; }
.save-note--hidden { visibility: hidden; }

.actid-field { padding-bottom: 14px; }
.actid-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.actid-input { display: flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; }
.actid-input > span { color: var(--muted); font-size: 13px; }
.actid-input input { flex: 1; min-width: 0; border: none; background: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; color: var(--text-strong); padding: 0; }
.actid-input input:focus { outline: none; }
.actid-input:focus-within { border-color: var(--accent); }
.actid-hint { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
/* channel group label (On-site / Ad networks) */
.chan-head { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 16px 0 0; }
.net-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); }
.net-row.first { border-top: none; }   /* the chan-head above is the separator */
.net-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; } .net-row .dot.off { background: var(--border-2); }
.net-main { flex: 1 1 auto; } .net-name { font-size: 13px; } .net-name.muted { color: var(--muted); } .net-sub { font-size: 11px; color: var(--muted); }
.sw { width: 30px; height: 18px; border-radius: 999px; background: var(--border-2); position: relative; flex: none; border: none; padding: 0; cursor: pointer; }
.sw i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .14s, right .14s; }
.sw.on { background: var(--accent); } .sw.on i { left: auto; right: 2px; }
.sw:disabled { opacity: .5; cursor: default; }
.net-connect { flex: none; border: 1px solid var(--border); background: none; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 999px; cursor: pointer; transition: border-color .12s, background .12s; }
.net-connect:hover { border-color: var(--accent); background: var(--accent-soft); }
.act-hint { margin: 10px 0 0; font-size: 11.5px; color: var(--muted); }
</style>
