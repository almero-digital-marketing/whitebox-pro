<script setup lang="ts">
// Branch step — split the flow into Yes/No paths, either on audience membership
// or on an ad-hoc fact/activity filter (the same condition builder Analytics'
// people-selector uses).
import { ref, watch, computed } from 'vue'
import PickList from './PickList.vue'
import ConditionsBuilder from '../../../shared/query/ConditionsBuilder.vue'
import { parseFilter, buildFilter } from '../../../shared/query/clause'
import './step-editor.css'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

// Both modes' state is held locally and BOTH are kept, so flipping between them
// doesn't discard what you had in the other one. A truthy `filter` (not a
// truthy audience_id) is what picks the initial mode: a brand-new branch node
// has audience_id: '', and '' is falsy, so testing that would wrongly land it
// in filter mode.
const cond = props.config.condition || {}
const audienceId = ref<string>(cond.audience_id || '')
// A branch SAVED against an audience stays on that tab even when the audiences
// plugin is gone — hiding it would misrepresent what the step actually does.
// It's offering audience mode as a NEW choice that's withdrawn.
const savedOnAudience = !cond.filter && !!cond.audience_id
const audienceLocked = computed(() => !props.vocab.canAudiences && !savedOnAudience)
// A fresh node defaults to { audience_id: '' } — audience mode. With audiences
// unavailable that would open on a tab its own header disables, so it starts
// on the filter side instead.
const mode = ref<'audience' | 'filter'>(
  cond.filter || (!props.vocab.canAudiences && !savedOnAudience) ? 'filter' : 'audience',
)
const parsed = parseFilter(cond.filter)
const combinator = ref(parsed.combinator)
const conditions = ref<any[]>(parsed.conditions)

// Write through to the draft config on every change rather than only at Save.
// The pane's dirty-check compares the draft against the live node, so state
// that lived outside the draft (as the conditions list used to) left Save
// disabled while you edited conditions — the edits were real but invisible to
// it. Serializing here means "edited" and "dirty" can't disagree.
// No `immediate`: merely opening a branch step must not mark it dirty.
watch([mode, audienceId, combinator, conditions], () => {
  props.config.condition = mode.value === 'audience'
    ? { audience_id: audienceId.value }
    : { filter: buildFilter(combinator.value, conditions.value) || {} }
}, { deep: true })


const setMode = (m: 'audience' | 'filter') => {
  if (props.disabled || (m === 'audience' && audienceLocked.value)) return
  mode.value = m
}
const pick = (id: string) => { if (!props.disabled) audienceId.value = id }
</script>

<template>
  <div class="mode-tabs">
    <button type="button" class="mode-tab" :class="{ on: mode === 'audience' }"
      :disabled="disabled || audienceLocked"
      :title="audienceLocked ? 'The audiences module is not available' : undefined"
      @click="setMode('audience')">By audience</button>
    <button type="button" class="mode-tab" :class="{ on: mode === 'filter' }" :disabled="disabled" @click="setMode('filter')">By filter</button>
  </div>
  <p v-if="audienceLocked" class="step-tip">Audiences aren't available here, so this branch matches on a filter.</p>
  <PickList v-if="mode === 'audience'" label="Audience" icon="group" :items="vocab.audiences" :selected="audienceId"
    :disabled="disabled" empty="No audiences yet — create one in the Audiences module." @pick="pick" />
  <ConditionsBuilder v-else v-model:combinator="combinator" :conditions="conditions"
    :fact-keys="vocab.factKeys" :event-opts="vocab.eventOpts" :campaign-opts="vocab.campaignOpts" :disabled="disabled" />
  <p class="step-tip">Connect the "Yes"/"No" handles on the canvas to the next steps.</p>
</template>

<style scoped>
/* the same segmented control as Analytics' query-builder .seg — a two-way
   mode switch, not a set of buttons. */
.mode-tabs { display: flex; gap: 4px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 3px; margin-bottom: 10px; }
.mode-tab { flex: 1; border: none; background: none; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); border-radius: 6px; padding: 6px 4px; transition: background .12s, color .12s; }
.mode-tab.on { background: var(--panel); color: var(--text-strong); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.mode-tab:disabled { opacity: .5; cursor: default; }
</style>
