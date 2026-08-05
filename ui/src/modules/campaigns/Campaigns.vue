<script setup lang="ts">
// Campaigns module — same three-pane logic as audiences:
//   left  = saved campaigns (pick / + New)
//   mid   = campaign-enabled audiences palette (click to attach — a campaign targets the UNION)
//   right = the open campaign: details + message + delivery preview/send, or (once sent) stats + report
// The UI authors the campaign end-to-end (audiences, message, delivery) and sends it. Campaign
// content can ALSO be upserted by an external pipeline (by external_id) — optional, not surfaced.
// Executing locks the campaign with real stats; a sent campaign can build a perf report.
// Delivery has two modes — Schedule (pick a date/time) or Manual (send immediately) — reflecting
// that bulk delivery is just ONE way this campaign's content ships: a Journey's `trigger_campaign` step
// can also activate it per-customer at any time, independent of this setting (see
// server-plugin-campaigns's activateForPassport()).
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
import SelectButton from 'primevue/selectbutton'
import Accordion from 'primevue/accordion'
import AccordionPanel from 'primevue/accordionpanel'
import AccordionHeader from 'primevue/accordionheader'
import AccordionContent from 'primevue/accordioncontent'
// Email body editor: TinyMCE, self-hosted (no cloud/API key) — it ships a native source-code
// view (the `code` plugin), so "view HTML" is built in.
import Editor from '@tinymce/tinymce-vue'
import 'tinymce/tinymce'
import 'tinymce/models/dom/model'
import 'tinymce/themes/silver/theme'
import 'tinymce/icons/default/icons'
import 'tinymce/skins/ui/oxide/skin.min.css'
import 'tinymce/plugins/code/plugin'
import 'tinymce/plugins/lists/plugin'
import 'tinymce/plugins/link/plugin'
import 'tinymce/plugins/image/plugin'
// content styles fed into the editor iframe (we self-host, so content_css is off)
import tinyContentCss from 'tinymce/skins/content/default/content.min.css?raw'
import tinyContentUiCss from 'tinymce/skins/ui/oxide/content.min.css?raw'
// Full-HTML email "View source": a plain-text CodeMirror (syntax-highlighted, editable) — unlike
// TinyMCE it never rewrites the markup, so the document stays intact.
import { Codemirror } from 'vue-codemirror'
import { basicSetup } from 'codemirror'
import { html as cmHtml } from '@codemirror/lang-html'
import RailPane from '../../components/RailPane.vue'
import ResultsBlock from './ResultsBlock.vue'
import { useCampaignsStore } from './stores/campaigns'
import { useAudiencesStore } from '../analytics/stores/audiences'
import { notifyError } from '../../shell/toast'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useCampaignsStore()
const audStore = useAudiencesStore()
const { campaigns, results } = storeToRefs(store)
// client-side rail search
// The rail is a SERVER query now, not a filter over a list already in memory:
// `q` lives in the store, is debounced there, and comes back as one page plus
// the real total. The whole-campaigns catalogue is a separate ref — see the store.
const { rows: railRows, total: railTotal, q } = storeToRefs(store)
const { audiences } = storeToRefs(audStore)

// the campaign currently open in the builder (the full row from getCampaign), or null
const working = ref<any>(null)
const pv = ref<any>(null)            // delivery preview (consent-gated union counts)
const saving = ref(false)
const building = ref(false)
// Composed content (name / subject / message) is edited in a LOCAL draft and committed with Save
// (or thrown away with Discard) — never auto-saved on every keystroke. `working` stays the
// persisted truth; `draft` is the in-progress edit.
const draft = ref<any>(null)
const fullDocSource = ref(false)   // full-HTML email: false = rendered preview, true = raw source
// A full HTML document (doctype/html/head/body) — built by an external email tool — would be
// wrecked by the fragment-only WYSIWYG, so it's previewed/source-viewed instead.
const FULLDOC_RE = /<\s*(?:!doctype|html|head|body)[\s>]/i
const isFullDoc = computed(() => FULLDOC_RE.test(draft.value?.message?.html || ''))
const cmExtensions = [basicSetup, cmHtml()]   // CodeMirror: full editor + HTML highlighting
// TinyMCE config — self-hosted (skin/content css imported above, so skin:false + content_css:false).
const tinymceInit = {
  height: '100%',   // fill the flex container (.msg-body); see the height chain in <style>

  menubar: false,
  branding: false,
  statusbar: false,
  skin: false,
  content_css: false,
  plugins: 'lists link image code',
  // full toolbar; tightened group spacing (CSS below) lets it fit the narrow compose pane on one
  // row. `wrap` (not the default overflow) so the source `</>` can never hide in a "more" menu.
  toolbar: 'blocks | bold italic underline forecolor | bullist numlist | link image | code',
  toolbar_mode: 'wrap',
  content_style: `${tinyContentUiCss}\n${tinyContentCss}\nbody{font-family:sans-serif;font-size:14px;line-height:1.5;margin:0;padding:12px}\nbody :first-child{margin-top:0}`,
}

// channels = delivery providers; radio list scales as more are added (viber, whatsapp, …)
const CHANNELS = [
  { label: 'Email', value: 'email', icon: 'mail' },
  { label: 'SMS', value: 'sms', icon: 'chat_bubble' },
]
const emailPreviewHtml = computed(() => working.value?.message?.html
  || '<p style="font-family:sans-serif;color:#94a3b8;padding:24px">Nothing to preview yet — switch to Source to write.</p>')
// Campaign objectives — what it's for; the AI performance report is built around these.
const OBJECTIVES = ['Bookings', 'Revenue', 'Re-engagement', 'Retention', 'Awareness', 'Referrals']
const goals = computed(() => draft.value?.objective?.goals || [])
// locked = committed (scheduled) or already sent — read-only until unlocked
const locked = computed(() => !!working.value && working.value.status !== 'draft')
const attachedIds = computed(() => new Set((working.value?.audiences || []).map((a: any) => a.id)))
// the campaign-enabled audiences are the palette (a campaign targets one or more of them)
const palette = computed(() => audiences.value.filter((a: any) => a.campaigns))
const ready = computed(() => {
  const w = working.value; if (!w) return false
  return w.channel === 'sms' ? !!w.message?.text?.trim() : !!w.message?.html
})
// unsaved edits in the composed content (name / subject / message)
const dirty = computed(() => {
  const w = working.value, d = draft.value
  if (!w || !d) return false
  return (d.name ?? '') !== (w.name ?? '')
    || (d.subject ?? '') !== (w.subject ?? '')
    || (d.message?.html ?? '') !== (w.message?.html ?? '')
    || (d.message?.text ?? '') !== (w.message?.text ?? '')
    || (d.objective?.notes ?? '') !== (w.objective?.notes ?? '')
    || [...(d.objective?.goals || [])].sort().join('') !== [...(w.objective?.goals || [])].sort().join('')
})
// delivery mode — Schedule (pick a date/time) or Manual (send immediately); purely local UI
// state, not persisted (nothing server-side distinguishes the two — "now" is just a due `scheduled_at`).
const DELIVERY_MODES = [{ label: 'Schedule', value: 'schedule' }, { label: 'Manual', value: 'now' }]
const deliveryMode = ref<'schedule' | 'now'>('schedule')

// right-pane accordion — Audiences (the palette) / Delivery / Objectives, stacked panels
// switched by expand/collapse (same pattern as Audiences.vue's Segments/Activation
// accordion), not stacked sections or a popup menu. Purely local UI state, reset
// whenever a different campaign opens. Audiences first since you attach a target
// before writing delivery settings or objectives.
const activePanel = ref<'audiences' | 'delivery' | 'objectives'>('audiences')
// schedulable: a SAVED draft with audiences, a ready message AND a send date/time set
const schedulable = computed(() => !!working.value && !locked.value && !dirty.value && (working.value.audiences?.length || 0) > 0 && ready.value && !!working.value.scheduled_at)
// sendableNow: same gate, minus the date requirement — "now" needs no scheduled_at at all
const sendableNow = computed(() => !!working.value && !locked.value && !dirty.value && (working.value.audiences?.length || 0) > 0 && ready.value)
// the Delivery panel's own accordion header — reflects lock/sent status, unlike the
// other two panels' static "Audiences"/"Objectives" headers
const deliveryHeaderLabel = computed(() => (!locked.value ? 'Delivery' : working.value?.status === 'sent' ? 'Sent' : 'Scheduled'))
const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
// the big number: live deliverable preview while drafting → projected reach once scheduled →
// actual sent count once delivered. Same visual either way.
const metric = computed(() => {
  const s = working.value?.stats
  if (locked.value && s) {
    const sent = working.value.status === 'sent'
    return { num: sent ? s.sent : s.reach, label: sent ? 'sent' : 'will reach', resolved: s.resolved, suppressed: s.suppressed, dry: s.dry_run }
  }
  if (!locked.value && pv.value) return { num: pv.value.deliverable, label: 'deliverable', resolved: pv.value.resolved, suppressed: pv.value.suppressed, dry: false }
  return null
})

onActivated(async () => {
  await Promise.all([store.loadCampaigns(), store.searchCampaigns(), audStore.loadAudiences()])
  applyRoute()
})

// ── routing: the open campaign lives in the URL (/campaigns/:campaignId) ──
// A journey-triggered send has no send RUN behind it (it's one passport, not a
// bulk run) but does produce attributed outbox rows, so the block can't hinge
// on runs alone — either half is reason enough to show it.
const hasResults = computed(() =>
  !!results.value && (results.value.runs?.length > 0 || Object.keys(results.value.delivery || {}).length > 0))

async function openCampaign(id: string) {
  const c = await store.getCampaign(id).catch((e: any) => { notifyError(`Couldn't open that campaign: ${e.message}`); return null })
  working.value = c
  resetDraft()              // seed the editable draft from the freshly-loaded campaign
  deliveryMode.value = 'schedule'
  activePanel.value = 'audiences'
  pv.value = null
  refreshPreview()
  // Always ask, never gate on status: a journey can activate a campaign
  // per-passport for months while it sits at 'draft' (activateForPassport is
  // independent of the bulk lifecycle), so a status check would hide real
  // sends. It's one indexed count per channel; hasResults decides what renders.
  store.loadResults(id)
}
function applyRoute() {
  if (route.name !== 'campaigns') return
  const id = paramStr(route.params.campaignId)
  if (!id) { working.value = null; return }
  if (working.value?.id === id) return
  openCampaign(id)
}
watch([() => route.params.campaignId, campaigns], applyRoute, { immediate: true })
function goCampaign(id: string) { router.push({ name: 'campaigns', params: { campaignId: id } }) }

// + New creates a draft immediately (it needs an id to attach audiences), then opens it.
async function startNew() {
  const row = await store.createCampaign({ name: 'Untitled campaign', channel: 'sms', message: { text: '' } })
  goCampaign(row.id)
}
function removeCampaign(c: any) {
  confirm.require({
    header: 'Delete campaign', message: `Delete “${c.name}”? This can’t be undone.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Delete', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      const open = working.value?.id === c.id
      try {
        await store.removeCampaign(c.id)
        if (open) { working.value = null; router.replace({ name: 'campaigns', params: {} }) }
      } catch (e: any) {
        notifyError(`Couldn't delete “${c.name}”: ${e.message}`)
      }
    },
  })
}

// All writes to `working` go through one serial chain, so rapid edits/attaches can't clobber
// each other with out-of-order responses — each op runs after the previous and reads the latest
// backend state. (Patch only updates the fields it's given, so order-preserving = no lost edits.)
let opChain: Promise<any> = Promise.resolve()
const serialize = (fn: () => Promise<any>) => { opChain = opChain.then(fn).catch((e: any) => notifyError(`Couldn't save that change: ${e.message}`)); return opChain }

// ── right-pane SETTINGS (channel · schedule · objectives) — applied immediately ──
// Optimistic: apply locally so the UI reacts instantly (and the delivery preview updates), then
// persist in the background. These are delivery settings, not composed content, so they're not
// part of the Save/Cancel draft. A field edit doesn't change the audience set, so we keep
// working.audiences (incl. sizes) as-is — no slow re-resolve, no waiting on the round-trip.
function patch(fields: Record<string, any>) {
  if (!working.value || locked.value) return
  const id = working.value.id
  working.value = { ...working.value, ...fields }
  return serialize(() => store.patchCampaign(id, fields))
}

// ── composed CONTENT (name · subject · message) — buffered in `draft`, committed with Save ──
function resetDraft() {
  const w = working.value
  draft.value = w ? {
    name: w.name ?? '', subject: w.subject ?? '', message: { ...(w.message || {}) },
    objective: { goals: [...(w.objective?.goals || [])], notes: w.objective?.notes ?? '' },
  } : null
  fullDocSource.value = false
}
// TinyMCE emits the new HTML on user edits; mirror it into the draft (Save commits it).
function onEditorHtml(html: string) {
  if (locked.value || !draft.value) return
  draft.value.message = { ...draft.value.message, html: html || '' }
}
function cancelEdits() { resetDraft() }
async function save() {
  if (!working.value || locked.value || !dirty.value || saving.value) return
  const id = working.value.id, w = working.value, d = draft.value
  const fields: Record<string, any> = {}
  if ((d.name ?? '') !== (w.name ?? '')) fields.name = d.name
  if ((d.subject ?? '') !== (w.subject ?? '')) fields.subject = d.subject
  if ((d.message?.html ?? '') !== (w.message?.html ?? '') || (d.message?.text ?? '') !== (w.message?.text ?? ''))
    fields.message = { ...(w.message || {}), ...d.message }
  if ((d.objective?.notes ?? '') !== (w.objective?.notes ?? '')
    || [...(d.objective?.goals || [])].sort().join('') !== [...(w.objective?.goals || [])].sort().join(''))
    fields.objective = { goals: [...(d.objective?.goals || [])], notes: d.objective?.notes ?? '' }
  saving.value = true
  try {
    const row = await store.patchCampaign(id, fields)
    if (working.value?.id !== id) return   // switched to a different campaign mid-save — don't stamp it with these fields
    working.value = { ...working.value, ...row }
    resetDraft()
  } catch (e: any) { notifyError(`Couldn't save changes: ${e.message}`) }
  finally { saving.value = false }
}
// scheduled_at is a single timestamp; the UI splits it into local date + time inputs and
// recombines on change (default 09:00 when only a date is given).
const setDate = (e: any) => commitSchedule(e.target.value, timeValue.value)
const setTime = (e: any) => commitSchedule(dateValue.value, e.target.value)
function commitSchedule(dateStr: string, timeStr: string) {
  if (!dateStr && !timeStr) return patch({ scheduled_at: null })
  const today = localDate(new Date().toISOString())
  patch({ scheduled_at: new Date(`${dateStr || today}T${timeStr || '09:00'}`).toISOString() })
}
async function setChannel(ch: 'email' | 'sms') { if (working.value && !locked.value) await patch({ channel: ch }) }
// objectives — toggle a goal chip / edit the notes; buffered in the draft like the rest of the
// composed content (Save commits them), and both drive the AI performance report.
function toggleGoal(g: string) {
  if (locked.value || !draft.value) return
  const cur = new Set(draft.value.objective.goals)
  cur.has(g) ? cur.delete(g) : cur.add(g)
  draft.value.objective = { ...draft.value.objective, goals: [...cur] }
}

// ── audiences (attach/detach → the campaign's union) ──
function toggleAudience(a: any) {
  if (!working.value || locked.value) return
  const id = working.value.id
  serialize(async () => {
    if (working.value?.id !== id) return
    const has = new Set((working.value.audiences || []).map((x: any) => x.id)).has(a.id)
    working.value = has ? await store.detachAudience(id, a.id) : await store.attachAudience(id, a.id)
  }).then(refreshPreview)
}
function detach(a: any) {
  if (!working.value || locked.value) return
  const id = working.value.id
  serialize(async () => { if (working.value?.id === id) working.value = await store.detachAudience(id, a.id) }).then(refreshPreview)
}

let pvTimer: any
function refreshPreview() {
  clearTimeout(pvTimer)
  if (!working.value?.audiences?.length) { pv.value = null; return }
  const id = working.value.id
  pvTimer = setTimeout(async () => {
    try { const r = await store.previewDelivery(id); if (working.value?.id === id) pv.value = r } catch { /* ignore */ }
  }, 150)
}

// ── schedule (commit for delivery at the set time) → locks the campaign ──
// The UI never "sends" from this tab; it schedules + locks. Delivery is a server-side job at
// scheduled_at — a time already in the past/now is simply "due" and fires immediately, but that's
// still framed as "you scheduled it and the time already passed," not an explicit send.
async function schedule() {
  if (!schedulable.value || saving.value) return
  const id = working.value.id
  let p = pv.value
  try { if (!p) p = await store.previewDelivery(id) }
  catch (e: any) { notifyError(`Couldn't preview delivery: ${e.message}`); return }
  if (working.value?.id !== id) return   // switched to a different campaign while the preview was loading
  const when = [dateValue.value, timeValue.value].filter(Boolean).join(' ')
  // A send time that's already passed is "due" — delivery fires immediately (dry-run or live is a
  // server config; the post-send badge reflects which it was, so the dialog doesn't assert a mode).
  const due = !!working.value.scheduled_at && new Date(working.value.scheduled_at).getTime() <= Date.now()
  const parts = [`~${fmt(p.deliverable)} of ${fmt(p.resolved)} people will receive this ${working.value.channel}`]
  if (p.suppressed) parts.push(`${p.suppressed} suppressed excluded`)
  if (p.no_consent) parts.push(`${p.no_consent} without consent excluded`)
  const lead = due ? `That time has passed, so this delivers immediately` : `Sends ${when ? `on ${when}` : 'at the scheduled time'}`
  confirm.require({
    header: `Schedule “${working.value.name}”?`,
    message: `${lead} — ${parts.join(' · ')}.\nThis locks the campaign for edits (unlock to change it).`,
    icon: 'pi pi-clock',
    acceptProps: { label: 'Schedule' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      saving.value = true
      try {
        const row = await store.scheduleCampaign(id, p)
        if (working.value?.id !== id) return   // switched away while the confirm/request was in flight
        working.value = { ...working.value, ...row }
      } catch (e: any) { notifyError(`Couldn't schedule the campaign: ${e.message}`) }
      finally { saving.value = false }
    },
  })
}

// ── manual send (deliver right now) → does NOT lock ──
// A genuinely separate action from schedule(), not "schedule for right now": locking exists to
// protect a one-time bulk commitment from accidental edits, which doesn't apply here — a manual
// send is meant to be repeatable (tweak the message, send again), the same way a Journey's
// `trigger_campaign` step can activate this campaign at any time, any number of times, independent
// of its bulk lifecycle. See service.js's sendManual().
async function sendNow() {
  if (!sendableNow.value || saving.value) return
  const id = working.value.id
  let p = pv.value
  try { if (!p) p = await store.previewDelivery(id) }
  catch (e: any) { notifyError(`Couldn't preview delivery: ${e.message}`); return }
  if (working.value?.id !== id) return   // switched to a different campaign while the preview was loading
  const parts = [`~${fmt(p.deliverable)} of ${fmt(p.resolved)} people will receive this ${working.value.channel}`]
  if (p.suppressed) parts.push(`${p.suppressed} suppressed excluded`)
  if (p.no_consent) parts.push(`${p.no_consent} without consent excluded`)
  confirm.require({
    header: `Send “${working.value.name}” now?`,
    message: `Sends immediately — ${parts.join(' · ')}.\nThe campaign stays editable afterward — send again any time.`,
    icon: 'pi pi-send',
    acceptProps: { label: 'Send now' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      saving.value = true
      try {
        const row = await store.sendManualCampaign(id, p)
        if (working.value?.id !== id) return   // switched away while the confirm/request was in flight
        working.value = { ...working.value, ...row }
      } catch (e: any) { notifyError(`Couldn't send the campaign: ${e.message}`) }
      finally { saving.value = false }
    },
  })
}

// Unlock a SCHEDULED campaign back to an editable draft — pull it back before it's delivered.
// (A sent campaign is final: no unlock in the UI; delete it from the rail if you want it gone.)
async function unlock() {
  if (!working.value || !locked.value || saving.value) return
  const id = working.value.id
  saving.value = true
  try {
    const row = await store.unlockCampaign(id)
    if (working.value?.id !== id) return   // switched to a different campaign mid-request
    working.value = { ...working.value, ...row }
    pv.value = null; refreshPreview()
  } catch (e: any) { notifyError(`Couldn't unlock the campaign: ${e.message}`) }
  finally { saving.value = false }
}

// ── build / open the Analytics performance report (sent campaigns) ──
async function buildReport() {
  if (building.value || !working.value) return
  const id = working.value.id
  building.value = true
  try {
    const reportId = await store.buildReport(working.value)   // prompt is the objective-derived analytics_prompt
    if (working.value?.id !== id) return   // switched to a different campaign — don't stamp it, and don't navigate into a report it didn't ask for
    working.value.report_id = reportId
    router.push({ name: 'analytics', params: { reportId } })
  } catch (e: any) { notifyError(`Couldn't build the report: ${e.message}`) }
  finally { building.value = false }
}
function openReport() { if (working.value?.report_id) router.push({ name: 'analytics', params: { reportId: working.value.report_id } }) }

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const localTime = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
// rail: a campaign's date — when it actually went out (sent) or when it's planned to (scheduled/draft)
function railDate(c: any): string {
  const iso = c?.status === 'sent' ? c.sent_at : c.scheduled_at
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}
// Draft shows the planned schedule; a sent campaign shows when it actually went out (sent_at).
const scheduleAt = computed(() => (locked.value ? (working.value?.sent_at || working.value?.scheduled_at) : working.value?.scheduled_at))
const dateValue = computed(() => (scheduleAt.value ? localDate(scheduleAt.value) : ''))
const timeValue = computed(() => (scheduleAt.value && String(scheduleAt.value).includes('T') ? localTime(scheduleAt.value) : ''))
function ago(iso?: string) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
</script>

<template>
  <div class="cmp-console">
    <!-- left: saved campaigns -->
    <aside class="cmp-left">
      <RailPane v-model:q="q" placeholder="Search campaigns"
        :total="railTotal" :page="store.page" :page-size="store.pageSize" @update:page="store.goToPage($event)"
        noun="campaign">
        <!-- the add action belongs TO the search, not to a header above it:
             finding and creating are the same job at the top of the rail -->
        <template #action>
          <Button text size="small" class="rail-action" aria-label="New campaign" @click="startNew">
            <template #icon><span class="material-symbols-outlined">add</span></template>
          </Button>
        </template>
        <!-- server-paged: the rows ARE the page -->
        <template #default>
          <li v-for="c in railRows" :key="c.id" class="rail-item" :class="{ on: c.id === working?.id }" @click="goCampaign(c.id)">
            <div class="ri-main">
              <span class="ri-name">{{ c.name }}</span>
              <span class="ri-sub">{{ c.channel }} · {{ c.status }}<template v-if="railDate(c)"> · {{ railDate(c) }}</template><span v-if="c.status !== 'draft'" class="material-symbols-outlined lock">lock</span></span>
            </div>
            <button class="ri-x" title="Delete" @click.stop="removeCampaign(c)"><span class="material-symbols-outlined">close</span></button>
          </li>
          <li v-if="!railRows.length" class="rail-empty">{{ q ? 'No matches.' : 'No campaigns yet — start one with +' }}</li>
        </template>
      </RailPane>
    </aside>

    <!-- center: compose the campaign (content + audiences) -->
    <section class="cmp-center">
      <div v-if="!working" class="placeholder muted">
        <div>
          <h2>WhiteBox Campaigns</h2>
          <p>Pick a campaign on the left, or start one with +.</p>
        </div>
      </div>

      <div v-else class="builder" :class="{ tall: working.channel === 'email' }">
        <div class="b-scroll">
          <div class="b-head">
            <input v-model="draft.name" class="b-name" :disabled="locked" placeholder="Campaign name" />
            <span v-if="locked" class="material-symbols-outlined lock" title="Locked — unlock to edit">lock</span>
          </div>

          <!-- attached audiences — same pattern as Audiences' segments box: the counter
               (deliverable preview → projected reach → actual sent) sits inside the box
               it counts, pinned to the corner, vertically centered, rather than in the
               title row above. -->
          <div class="aud-block">
            <div class="blk-head">Audiences</div>
            <div class="chips">
              <div v-if="metric" class="b-size">
                <span class="bs-num">~{{ fmt(metric.num) }}</span><span class="bs-lbl">{{ metric.label }}</span>
              </div>
              <span v-for="a in working.audiences" :key="a.id" class="chip">
                {{ a.name }} <span class="chip-size">~{{ fmt(a.size) }}</span>
                <button v-if="!locked" class="chip-x" title="Remove" @click="detach(a)"><span class="material-symbols-outlined">close</span></button>
              </span>
              <span v-if="!working.audiences?.length" class="chips-empty">{{ locked ? 'No audiences.' : 'Attach an audience in the Audiences panel on the right.' }}</span>
            </div>
          </div>

          <!-- message -->
          <div class="msg-block">
            <div class="blk-head">Message</div>
            <!-- SMS -->
            <Textarea v-if="working.channel === 'sms'" v-model="draft.message.text" rows="4" autoResize class="sms" :disabled="locked"
              placeholder="Write your SMS… (≤160 chars per segment)" />
            <!-- EMAIL -->
            <template v-else>
              <InputText v-model="draft.subject" class="subj-input" :disabled="locked" placeholder="Email subject" />
              <!-- the editor/preview fills the remaining height of the pane -->
              <div class="msg-body">
                <!-- A FULL HTML document is READ-ONLY output from an external email builder: the UI just
                     previews + ships the compiled HTML (its editable source lives in that tool). Editing
                     it here would be overwritten when it's rebuilt — so we preview it (sandboxed iframe) +
                     offer a read-only source view, never the WYSIWYG (which would also mangle the
                     head/styles/conditionals/tables). -->
                <div v-if="!locked && isFullDoc" class="fulldoc">
                  <div class="fulldoc-bar">
                    <span class="fulldoc-tag"><span class="material-symbols-outlined">description</span> Full HTML email</span>
                    <button type="button" class="src-toggle" @click="fullDocSource = !fullDocSource">{{ fullDocSource ? 'Preview' : 'View source' }}</button>
                  </div>
                  <iframe v-if="!fullDocSource" class="fulldoc-view" :srcdoc="draft.message.html" sandbox title="Email preview" />
                  <Codemirror v-else v-model="draft.message.html" class="fulldoc-view fulldoc-cm" :extensions="cmExtensions"
                    :indent-with-tab="true" :tab-size="2" :autofocus="false" />
                </div>
                <!-- simple UI-authored fragment → TinyMCE WYSIWYG -->
                <Editor v-else-if="!locked" :key="working.id" :model-value="draft.message.html || ''" :init="tinymceInit"
                  class="tiny" @update:model-value="onEditorHtml" />
                <iframe v-else class="email-preview" :srcdoc="emailPreviewHtml" sandbox title="Email preview" />
              </div>
            </template>
          </div>

          <!-- Results — only once something real was sent. Not rendered at all
               otherwise (rather than an empty block saying "no data yet"), the
               same convention the People centre pane follows. -->
          <ResultsBlock v-if="hasResults" :results="results"
            :report-id="working.report_id" @open-report="openReport" />
        </div>

        <!-- save / discard the composed content — always rendered, disabled (not hidden) when
             clean, same pattern as Audiences'/Analytics' builder panes -->
        <div v-if="!locked" class="b-actions">
          <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="cancelEdits" />
          <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
          <Button label="Save changes" size="small" :disabled="!dirty" :loading="saving" @click="save"><template #icon><span class="material-symbols-outlined">check</span></template></Button>
        </div>
      </div>
    </section>

    <!-- far-right: Audiences (palette) / Delivery / Objectives — stacked accordion panels,
         Audiences first (attach a target before writing delivery settings or objectives),
         same pattern as Audiences.vue's Segments/Activation accordion. -->
    <aside class="cmp-side">
      <Accordion v-model:value="activePanel" class="cmp-accordion pane-accordion is-content-scroll">
        <AccordionPanel value="audiences">
          <AccordionHeader><span class="acc-title">Audiences <span class="count-pill sm">{{ working?.audiences?.length ?? 0 }}</span></span></AccordionHeader>
          <AccordionContent>
            <!-- Suppressed when the palette is empty, so the empty-list message below stands
                 alone. Both used to render: "Pick or start a campaign to attach audiences to
                 it." directly above "No campaign-enabled audiences" — advice to do something
                 that cannot work yet, on top of the reason it cannot. An empty palette is the
                 blocking condition and applies whichever campaign is selected, so it is the
                 only message worth showing. -->
            <p v-if="palette.length" class="pane-tip">{{ working ? 'Click an audience to target it — a campaign reaches the de-duped union of all attached audiences.' : 'Pick or start a campaign to attach audiences to it.' }}</p>
            <ul class="rail-list">
              <li v-for="a in palette" :key="a.id" class="seg-pill" :class="{ used: attachedIds.has(a.id), disabled: !working || locked }"
                  @click="toggleAudience(a)">
                <span class="material-symbols-outlined">group</span>
                <span class="sp-name">{{ a.name }}</span>
                <span v-if="attachedIds.has(a.id)" class="material-symbols-outlined sp-used">check</span>
              </li>
              <li v-if="!palette.length" class="rail-empty">No campaign-enabled audiences. In Audiences, toggle an audience's “Campaigns” on.</li>
            </ul>
          </AccordionContent>
        </AccordionPanel>

        <AccordionPanel value="delivery">
          <AccordionHeader>{{ deliveryHeaderLabel }}</AccordionHeader>
          <AccordionContent>
            <p v-if="!working" class="pane-tip">Pick or start a campaign to set up its delivery.</p>
            <template v-else>
            <!-- channel — same UI for both; disabled once sent -->
            <div class="chan-select">
              <label v-for="c in CHANNELS" :key="c.value" class="chan-opt" :class="{ on: working.channel === c.value, off: locked }">
                <input type="radio" name="channel" :value="c.value" :checked="working.channel === c.value" :disabled="locked" @change="setChannel(c.value)" />
                <span class="chan-tx">{{ c.label }}</span>
                <span class="material-symbols-outlined chan-ic">{{ c.icon }}</span>
              </label>
            </div>

            <!-- delivery mode — bulk delivery is one option among several ways this campaign's
                 content ships (a Journey can also trigger it per-customer, any time) -->
            <div v-if="!locked" class="side-section">
              <div class="mode-bar"><SelectButton v-model="deliveryMode" :options="DELIVERY_MODES" optionLabel="label" optionValue="value" :allowEmpty="false" /></div>
              <div v-if="deliveryMode === 'schedule'" class="row sched-row">
                <label class="fld"><span class="fld-l">Send date</span>
                  <input type="date" class="date-input" :value="dateValue" @change="setDate" /></label>
                <label class="fld"><span class="fld-l">Send time</span>
                  <input type="time" class="date-input" :value="timeValue" @change="setTime" /></label>
              </div>
              <p class="dlv-tip">A Journey's "Trigger Campaign" step can also activate this per-customer, any time — independent of this setting.</p>
            </div>

            <!-- resolved/suppressed breakdown behind the headline number in .b-head (center pane) —
                 stays here since it's about how the send resolves, not the campaign identity. -->
            <p v-if="metric" class="dlv-sub"><span v-if="metric.dry" class="dry">dry-run</span>{{ fmt(metric.resolved) }} resolved · {{ fmt(metric.suppressed) }} suppressed</p>

            <!-- action: Schedule / Send now (draft) → Unlock (scheduled, locked, not yet delivered).
                 Nothing renders here once actually delivered — see the Objectives panel for the report. -->
            <div class="send-section">
              <template v-if="!locked">
                <p v-if="dirty" class="hint">Save your changes first.</p>
                <p v-else-if="!working.audiences?.length" class="hint">Attach an audience first.</p>
                <p v-else-if="!ready" class="hint">{{ working.channel === 'sms' ? 'Write the SMS first.' : 'Write the email first.' }}</p>
                <p v-else-if="deliveryMode === 'schedule' && !working.scheduled_at" class="hint">Set a send date above.</p>
                <p v-else-if="deliveryMode === 'schedule'" class="hint long">Scheduling commits delivery for that time and locks the campaign — unlock to change it.</p>
                <p v-else class="hint">Sends immediately</p>
                <Button v-if="deliveryMode === 'schedule'" class="send-btn" label="Schedule" size="small"
                  :loading="saving" :disabled="!schedulable" @click="schedule()" />
                <Button v-else class="send-btn" label="Send now" size="small"
                  :loading="saving" :disabled="!sendableNow" @click="sendNow" />
              </template>
              <template v-else-if="working.status !== 'sent'">
                <!-- scheduled but not yet delivered: nothing to report on yet -->
                <p class="hint long"><span class="material-symbols-outlined">schedule</span> Scheduled{{ dateValue ? ` for ${dateValue}${timeValue ? ` ${timeValue}` : ''}` : '' }} — locked. The performance report becomes available once it’s delivered.</p>
                <Button class="send-btn unlock-btn solo" label="Unlock to edit" text severity="secondary" size="small" :loading="saving" @click="unlock" />
              </template>
            </div>
            </template>
          </AccordionContent>
        </AccordionPanel>

        <!-- objectives + the report they drive — independent of lock: a manual send doesn't lock
             the campaign, so there can be real stats to report on well before (or without) ever
             scheduling/locking it. -->
        <AccordionPanel value="objectives">
          <AccordionHeader><span class="acc-title">Objectives <span class="count-pill sm">{{ goals.length }}</span></span></AccordionHeader>
          <AccordionContent>
            <p v-if="!working" class="pane-tip">Pick or start a campaign to set its objectives.</p>
            <template v-else>
            <p v-if="working.report_id" class="obj-tip">The performance report is built from these.</p>
            <p v-else class="obj-tip">Ready — generate a performance report from these.</p>
            <div class="obj-chips">
              <button v-for="o in OBJECTIVES" :key="o" type="button" class="obj-chip" :class="{ on: goals.includes(o) }" :disabled="locked" @click="toggleGoal(o)">{{ o }}</button>
            </div>
            <Textarea v-model="draft.objective.notes" rows="3" autoResize class="obj-notes" :disabled="locked" placeholder="Specific goals (optional) — e.g. re-engage lapsed VIPs, lift average spend…" />
            <div class="report-actions">
              <Button v-if="working.report_id" class="send-btn" label="Open report" size="small" @click="openReport" />
              <Button v-else class="send-btn" label="Generate report" size="small" :loading="building" @click="buildReport" />
            </div>
            </template>
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </aside>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.cmp-console { display: flex; height: 100%; min-height: 0; }
.cmp-left { flex: none; width: 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.cmp-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.cmp-side { flex: none; width: 400px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); }
/* same empty state as Analytics' Board.vue */
.placeholder { display: grid; place-items: center; height: 100%; text-align: center; }
.placeholder h2 { margin: 0 0 6px; color: var(--text); }

/* Audiences / Delivery / Objectives accordion — same proven pattern as Audiences.vue's
   .aud-accordion: 52px box-sized headers, the active panel fills all remaining pane
   height, and the unconditional min-height:0 below keeps PrimeVue's collapse animation
   from getting stuck (making the panel a flex container turns .p-accordioncontent into a
   flex item, which defaults to min-height:auto and refuses to shrink for the collapse
   keyframe unless overridden here for every panel, not just the active one). */
/* every divider lives on a header's own border-top (deterministic, hard-clamped to 52px),
   never on flex-grown content — !important wins the specificity tie with PrimeVue's own
   :first-child > .p-accordionheader rule regardless of stylesheet injection order. */
/* the Audiences panel's tip + list already sit inside AccordionContent's own 16px/18px
   padding above — zero their own, so it isn't doubled (the .cmp-left campaigns rail below
   is NOT inside the accordion and keeps its normal padding). */
.cmp-accordion .pane-tip { padding: 0; margin: 0 0 12px; }

.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.pane-tip { margin: 0; padding: 12px 16px 2px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }

.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); text-transform: capitalize; }
.lock { font-size: 10px; color: var(--muted); }
.ri-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; }
.rail-item:hover .ri-x { opacity: 1; } .ri-x:hover { color: var(--text-strong); }

.seg-pill { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--panel); }
.seg-pill:hover { border-color: var(--border-2); }
.seg-pill.used { border-color: var(--accent); background: var(--accent-soft); }
.seg-pill.disabled { opacity: .5; pointer-events: none; }
.seg-pill .material-symbols-outlined { font-size: 12px; color: var(--accent); }
.sp-name { flex: 1 1 auto; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-used { font-size: 11px; color: var(--accent); }

.builder { width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.b-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 9px 16px 22px; display: flex; flex-direction: column; }
.b-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
/* reads as a heading at rest; becomes a regular input box (border + bg) on hover/focus —
   same pattern as Audiences'/Reports' (Board.vue) .b-name */
.b-name { flex: 1 1 auto; min-width: 0; box-sizing: border-box; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 20px; font-weight: 650; color: var(--text-strong); padding: 6px 10px; margin-left: -10px; transition: border-color .12s, background .12s; }
.b-name:hover { border-color: var(--border); }
.b-name:focus { outline: none; border-color: var(--accent); background: var(--panel); }
.b-name:disabled { color: var(--muted); cursor: default; }
.b-name:disabled:hover { border-color: transparent; }
.b-name-static { flex: 1 1 auto; margin: 0; font-size: 20px; font-weight: 650; color: var(--text-strong); display: flex; align-items: center; gap: 8px; }
.chan-static { font-size: 12px; color: var(--muted); text-transform: capitalize; }

.row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.fld { display: flex; flex-direction: column; gap: 5px; } .fld.grow { flex: 1 1 220px; }
.fld-l { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.fld :deep(input), .date-input { width: 100%; }
.date-input { border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; color: var(--text-strong); background: var(--panel); }

/* widget-title styling, copied from Analytics' WidgetCard .title — see the
   note in people/panels/panel.css */
.blk-head { font-size: 16px; font-weight: 650; line-height: 1.3; letter-spacing: normal; text-transform: none; color: var(--text-strong); margin-bottom: 8px; }
.aud-block, .msg-block, .obj-block, .res-block { margin-bottom: 18px; }
/* email: the message area grows to fill the builder; the editor/preview fills it in turn */
.msg-block { display: flex; flex-direction: column; }
.builder.tall .msg-block { flex: 1 1 auto; min-height: 0; margin-bottom: 0; }
.msg-body { flex: 1 1 auto; min-height: 220px; }
/* objectives — goal chips + notes; drive the AI report */
.obj-tip { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.obj-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.obj-chip { border: 1px solid var(--border); background: var(--panel); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 12.5px; cursor: pointer; color: var(--text); transition: border-color .12s, background .12s, color .12s; }
.obj-chip:hover { border-color: var(--border-2); }
.obj-chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
/* read-only (sent): the chosen objectives stay highlighted; the rest dim so they stand out */
.obj-chip:disabled { cursor: default; }
.obj-chip:disabled:not(.on) { opacity: .4; }
.obj-notes { width: 100%; }
.obj-readonly { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.obj-tag { font-size: 12px; font-weight: 600; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 3px 10px; }
.obj-note-ro { font-size: 12.5px; color: var(--text); }
/* read-only (sent) variants of the composed fields */
.subj-static { font-size: 14px; font-weight: 550; color: var(--text-strong); }
.sms-static { margin: 0; font-size: 13px; line-height: 1.55; color: var(--text); white-space: pre-wrap; }
/* bordered box — same treatment as Audiences' .b-rule (segments box) */
/* padding-right reserves the strip the absolutely-positioned counter sits in.
   Without it a second chip wraps straight underneath "~13 deliverable" — the
   counter is out of flow, so nothing else knows it is there. .b-size is capped
   to that same strip so a seven-figure count can't grow back over the chips. */
.chips { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 68px; padding: 14px 150px 14px 14px; border: 1.5px dashed var(--border); border-radius: 10px; }
/* the counter badge — inside the box it counts, pinned to its corner, vertically
   centered — same treatment as Audiences' .b-rule .b-size */
.chips .b-size { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); max-width: 138px; }
/* This is the same chip Audiences' centre pane draws for a segment in its rule
   (.mem there) — a named cohort with its size and a remove ×, inside the same
   dashed drop box with the same corner counter. Size/padding/gap are copied
   from it verbatim: 12.5px/5-11/6 here vs 13px/6-10/7 there made one component
   render two ways depending on which module you opened. */
.chip { display: inline-flex; align-items: center; gap: 7px; padding: 6px 8px 6px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; font-size: 13px; font-weight: 550; color: var(--text-strong); }
.chip-size { font-size: 11px; color: var(--muted); font-weight: 400; }
.chip-x { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 11px; padding: 0; }
.chip-x:hover { color: var(--text-strong); }
/* leaves room on the right for the .b-size counter badge (pinned there, see .chips
   .b-size below) so the hint text wraps before reaching it instead of running underneath */
.chips-empty { font-size: 12.5px; color: var(--muted); }

.sms { width: 100%; }
.subj-input { width: 100%; margin-bottom: 12px; }
/* fixed Discard/Save bar — same pattern as Audiences'/Analytics' builder panes: always
   rendered, disabled (not hidden) when clean, a fading "Unsaved changes" note. */
.b-actions { flex: none; height: 52px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-top: 1px solid var(--border); }
.save-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-right: auto; }
.save-note .material-symbols-outlined { font-size: 8px; color: #d97706; }
.save-note--hidden { visibility: hidden; }
/* TinyMCE renders its chrome as a SIBLING of the (hidden) textarea, so we must scope from
   .cmp-center (a real ancestor), not the editor element. Round the frame, and collapse the skin's
   wide group padding (~23px each — the "separator") so the full toolbar fits one row in the narrow
   pane. !important to beat the skin css. */
.cmp-center :deep(.tox-tinymce) { border: 1px solid var(--p-inputtext-border-color) !important; border-radius: 6px; height: 100% !important; }
.cmp-center :deep(.tox-toolbar__group) { padding: 0 1px !important; }
/* the right edge already sits ~13px in; pad the first group's left to match so both align with the
   content inset below (the left was nearly flush after the group-padding collapse) */
.cmp-center :deep(.tox-toolbar__group:first-child) { padding-left: 12px !important; }
.cmp-center :deep(.tox-tbtn) { margin: 2px 0 !important; }
/* shave icon buttons a touch (NOT the text "Heading" dropdown) so the full set + source fit one row */
.cmp-center :deep(.tox-tbtn:not(.tox-tbtn--bespoke)) { width: 29px !important; }
/* flat — drop the skin's drop-shadow under the toolbar */
.cmp-center :deep(.tox-editor-header) { box-shadow: none !important; }
/* focus: behave like the inputs — drop TinyMCE's blue ring, darken the border + show the same
   focus ring (PrimeVue tokens) when editing */
.cmp-center :deep(.tox-edit-area::before) { display: none !important; }
.cmp-center :deep(.tox-tinymce.tox-edit-focus),
.cmp-center :deep(.tox-tinymce:focus-within) {
  border-color: var(--p-inputtext-focus-border-color) !important;
  outline: var(--p-focus-ring-width) var(--p-focus-ring-style) var(--p-focus-ring-color);
  outline-offset: var(--p-focus-ring-offset);
}
.email-preview { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: #fff; display: block; }
/* full HTML email (external builder output) — previewed/source-viewed, never sent through the WYSIWYG */
.fulldoc { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; height: 100%; display: flex; flex-direction: column; }
.fulldoc-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px 7px 12px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
.fulldoc-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.fulldoc .src-toggle { font-size: 12px; font-weight: 600; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.fulldoc-view { width: 100%; flex: 1 1 auto; min-height: 0; border: none; display: block; background: #fff; }
/* CodeMirror source editor — fills the frame, HTML-highlighted, editable */
.fulldoc-cm { display: flex; flex-direction: column; overflow: hidden; background: #fff; }
.fulldoc-cm :deep(.cm-editor) { flex: 1 1 auto; height: 100%; font-size: 12.5px; }
.fulldoc-cm :deep(.cm-editor.cm-focused) { outline: none; }
.fulldoc-cm :deep(.cm-scroller) { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* far-right SEND pane (draft) */
.chan-select { margin-bottom: 18px; }
.chan-opt { display: flex; align-items: center; gap: 9px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; cursor: pointer; font-size: 13px; font-weight: 550; color: var(--text-strong); }
.chan-opt:hover { border-color: var(--border-2); }
.chan-opt.off { cursor: default; }
.chan-opt.off:hover { border-color: var(--border); }
.chan-opt.off:not(.on) { opacity: .55; }
.chan-opt.on { border-color: var(--accent); background: var(--accent-soft); }
.chan-opt input { accent-color: var(--accent); margin: 0; }
.chan-tx { flex: 1 1 auto; }
.chan-ic { font-size: 13px; color: var(--muted); }
.chan-opt.on .chan-ic { color: var(--accent); }
/* same counter pill as Audiences' center-pane .b-size/.bs-num/.bs-lbl, in .b-head next to
   the campaign name */
.b-size { display: flex; align-items: baseline; gap: 5px; background: var(--panel-2); border-radius: 8px; padding: 5px 12px; }
.bs-num { font-size: 20px; font-weight: 650; color: var(--text-strong); }
.bs-lbl { font-size: 12px; color: var(--muted); }
/* resolved/suppressed breakdown behind that pill's headline number — stays in the Delivery
   panel since it's about how the send resolves, not the campaign's identity */
.dlv-sub { margin: 14px 0 0; font-size: 12px; color: var(--muted); }
/* delivery mode switcher — matches Analytics' ComposePane.vue mode-bar exactly */
.mode-bar { margin-bottom: 10px; }
.mode-bar :deep(.p-selectbutton) { width: 100%; }
.mode-bar :deep(.p-togglebutton) { flex: 1; }

.dlv-tip { margin: 10px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.sched-row { gap: 10px; margin: 14px 0 16px; }
.sched-row .fld { flex: 1 1 0; min-width: 0; }
/* hint on the left, button on the right, same row — a short hint (.hint) shrinks to fit
   beside the button; a full-sentence one (.hint.long) takes its own line via flex-basis:
   100% instead (see below), so it's never squeezed into an awkward multi-line column. */
.send-section { margin-top: 18px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.send-btn { flex: none; margin-left: auto; }
.unlock-btn { margin-top: 8px; }
.unlock-btn.solo { margin-top: 0; }
.hint { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.hint.long { flex-basis: 100%; }
.side-section { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
.side-section.no-border { border-top: none; margin-top: 0; padding-top: 0; }
/* right-aligned, like .send-section and the reference .qb-actions bar */
.report-actions { margin-top: 12px; display: flex; justify-content: flex-end; }

/* far-right RESULTS pane (sent) */
.stats { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap; margin: 2px 0 6px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.s-num { font-size: 26px; font-weight: 700; line-height: 1; color: var(--text-strong); }
.s-lbl { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.dry { display: inline-block; font-size: 10px; font-weight: 700; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; margin-right: 6px; }
.sent-meta { font-size: 12.5px; color: var(--muted); margin: 0 0 18px; }
.report-block { border-top: 1px solid var(--border); padding-top: 16px; }
.rep-tip { padding: 0; margin: 0 0 10px; }
.prompt { width: 100%; margin-bottom: 10px; }
</style>
