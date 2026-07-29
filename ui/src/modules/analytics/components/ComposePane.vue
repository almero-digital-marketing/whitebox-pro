<script setup lang="ts">
import { ref, watch, computed, onUnmounted, nextTick } from 'vue'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import QueryBuilder from './QueryBuilder.vue'
import { api } from '../api'

const props = defineProps<{ composing: boolean; report: any; selectedWidget: any; schema: any }>()
const emit = defineEmits(['compose', 'save', 'cancel'])

// mode is owned by the parent (v-model) so board actions — select a widget, add a
// widget — can drive it regardless of which mode you're in.
const mode = defineModel<'agent' | 'query'>('mode', { default: 'agent' })
const modes = [{ label: 'Agent', value: 'agent' }, { label: 'Query', value: 'query' }]

const q = ref('')
const askInput = ref<any>(null)
function send() { if (q.value.trim()) { emit('compose', q.value); q.value = '' } }
// Cancel clears the ask box and, if a widget happens to be selected, deselects it — the
// Agent-tab counterpart of the Query tab's Cancel (Ask still adds immediately).
function cancelAgent() { q.value = ''; if (props.selectedWidget) emit('cancel') }

// Clicking a suggestion fills the Ask box (rather than composing immediately) so you
// can refine the wording, then send via Ask — every compose routes through one path.
function pickSuggestion(s: string) {
  q.value = s
  nextTick(() => {
    const el = askInput.value?.$el || askInput.value
    el?.focus?.()
    const len = (el?.value ?? '').length
    el?.setSelectionRange?.(len, len)   // cursor at end, ready to edit
  })
}

// "Try one:" chips — generated from the report's state (its widgets, then its name,
// else just the data vocabulary) so they always reflect what you're looking at. The
// static list is the fallback if the AI call fails, and seeds the first paint.
const DEFAULT_SUGGESTIONS = [
  'How many active clients do we have?',
  'Bookings per week',
  'Clients by status',
  'Revenue per month',
  'Which clients are lapsed?',
  'What are clients most interested in?',
]
const suggestions = ref<string[]>(DEFAULT_SUGGESTIONS)
const loadingSug = ref(false)
const suggestHeading = computed(() => (props.report?.widgets?.length ? 'Add more:' : 'Try one:'))

async function fetchSuggestions() {
  loadingSug.value = true
  try {
    const { suggestions: s } = await api.suggestions(props.report?.id)
    suggestions.value = Array.isArray(s) && s.length ? s : DEFAULT_SUGGESTIONS
  } catch { suggestions.value = DEFAULT_SUGGESTIONS }
  finally { loadingSug.value = false }
}
// Refetch when the report identity / name / widget count changes — debounced so a
// compose that adds several widgets collapses into one call.
let sugTimer: any
watch(
  () => [props.report?.id || '', props.report?.name || '', props.report?.widgets?.length || 0].join('|'),
  () => { clearTimeout(sugTimer); sugTimer = setTimeout(fetchSuggestions, 250) },
  { immediate: true },
)
onUnmounted(() => clearTimeout(sugTimer))

// Switching Query → Agent summarizes the built query into the Agent box as free text,
// so you can refine it in words (the inverse of compose).
const qb = ref<any>(null)
const summarizing = ref(false)
watch(mode, async (now, prev) => {
  if (prev !== 'query' || now !== 'agent' || !qb.value?.hasContent?.()) return
  const w = props.selectedWidget
  const dirty = qb.value.isDirty?.()
  // unchanged query with a saved summary → reuse it, no AI call
  if (!dirty && w?.summary) { q.value = w.summary; return }
  summarizing.value = true; q.value = ''
  try {
    const { summary } = await api.describe(qb.value.build())
    q.value = summary
    if (!dirty && w) {                       // describes the SAVED query → cache it on the widget
      w.summary = summary
      api.updateWidget(w.id, { summary }).catch(() => {})
    }
  } catch { /* leave the box empty on failure */ }
  finally { summarizing.value = false }
})

</script>

<template>
  <div class="pane-head">
    <span>Compose</span>
  </div>

  <div class="mode-bar">
    <SelectButton v-model="mode" :options="modes" optionLabel="label" optionValue="value" :allowEmpty="false" />
  </div>

  <!-- AGENT: free-text compose -->
  <div v-if="mode === 'agent'" class="compose">
    <div class="box">
      <Textarea ref="askInput" v-model="q" rows="3" autoResize class="ask" :disabled="summarizing"
        :placeholder="summarizing ? 'Summarizing your query…' : 'Ask about your customers…  e.g. “bookings per week and clients by status”'"
        @keydown.enter.exact.prevent="send" />
    </div>
    <!-- footer action bar — mirrors the Query tab's Cancel / … / action layout -->
    <div class="agent-actions">
      <Button label="Cancel" text severity="secondary" size="small" class="ag-cancel" @click="cancelAgent" />
      <Button :label="composing ? 'Composing…' : 'Ask'" :loading="composing" size="small" :disabled="summarizing || !q.trim()" @click="send" />
    </div>
    <p v-if="report" class="muted hint">Ask a follow-up to add more widgets — or click a widget and switch to Query to edit it.</p>
    <div class="suggest" :class="{ dim: loadingSug }">
      <p class="muted">{{ suggestHeading }}</p>
      <Button v-for="s in suggestions" :key="s" :label="s" severity="secondary" outlined
        :disabled="composing" class="sug" @click="pickSuggestion(s)" />
    </div>
  </div>

  <!-- QUERY: structured builder — edit the selected widget, or build a new query -->
  <div v-else class="query-pane">
    <p class="qhead muted small">{{ selectedWidget ? 'Editing the selected widget' : 'New widget' }}</p>
    <QueryBuilder ref="qb" :widget="selectedWidget" :schema="schema" @save="emit('save', $event)" @cancel="emit('cancel')" />
  </div>
</template>

<style scoped>
.mode-bar { padding: 14px 16px 0; }
.mode-bar :deep(.p-selectbutton) { width: 100%; }
.mode-bar :deep(.p-togglebutton) { flex: 1; }
.compose { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.box { display: flex; flex-direction: column; gap: 10px; }
.ask { width: 100%; }
/* footer action bar — matches the Query tab's .qb-actions (Cancel pushed left, action right) */
.agent-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.agent-actions .ag-cancel { margin-right: auto; }
.suggest { display: flex; flex-direction: column; gap: 8px; transition: opacity .15s; }
.suggest.dim { opacity: .5; }   /* fetching fresh suggestions */
.suggest > p { margin: 4px 0; font-size: 13px; }
.sug { justify-content: flex-start; }
.sug :deep(.p-button-label) { flex: 1; text-align: left; font-weight: 400; }
.hint { font-size: 11.5px; padding: 0 2px; }
.query-pane { padding: 16px; }
.qhead { margin: 0 0 10px; }
.small { font-size: 11px; }
</style>
