<script setup lang="ts">
// Branch step — split the flow into Yes/No paths on audience membership, an
// ad-hoc fact/activity filter (the same condition builder Analytics'
// people-selector uses), or a judge: a question the model answers about this one
// person from their recorded activity.
//
// Judge is a THIRD MODE rather than a third row inside the conditions builder,
// because that is the shape the engine has. `filter` is a tree of fact/metric
// clauses; `judge` is a separate stage that runs after it (see
// server/src/selector/people.js). A judge row sitting among the others would
// imply it takes part in the all/any toggle, and it cannot — the engine only
// ever ANDs it. Keeping it a mode keeps the UI unable to express something the
// backend would silently reinterpret.
import { ref, watch, computed } from 'vue'
import Textarea from 'primevue/textarea'
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
// A fresh node defaults to `{ judge: { criteria: '' } }` (see steps/index.ts), so
// it opens on the first tab. The remaining arms are for SAVED nodes: a filter
// keeps filter mode, and an audience node with the audiences module gone would
// otherwise open on a tab its own header disables, so it falls to filter.
const mode = ref<'audience' | 'filter' | 'judge'>(
  cond.judge ? 'judge'
    : cond.filter || (!props.vocab.canAudiences && !savedOnAudience) ? 'filter' : 'audience',
)
const parsed = parseFilter(cond.filter)
const combinator = ref(parsed.combinator)
const conditions = ref<any[]>(parsed.conditions)
const criteria = ref<string>(cond.judge?.criteria || '')
// The selector's own default (rt.defaults / judge.evaluate), so a branch and an
// audience asked the same question agree by default.
const confidence = ref<number>(cond.judge?.confidence ?? 0.7)

// Write through to the draft config on every change rather than only at Save.
// The pane's dirty-check compares the draft against the live node, so state
// that lived outside the draft (as the conditions list used to) left Save
// disabled while you edited conditions — the edits were real but invisible to
// it. Serializing here means "edited" and "dirty" can't disagree.
// No `immediate`: merely opening a branch step must not mark it dirty.
watch([mode, audienceId, combinator, conditions, criteria, confidence], () => {
  props.config.condition = mode.value === 'audience'
    ? { audience_id: audienceId.value }
    : mode.value === 'judge'
      // Trimmed, because the criteria IS the prompt — trailing whitespace from a
      // textarea would otherwise ride into the model call.
      ? { judge: { criteria: criteria.value.trim(), confidence: confidence.value } }
      : { filter: buildFilter(combinator.value, conditions.value) || {} }
}, { deep: true })


const setMode = (m: 'audience' | 'filter' | 'judge') => {
  if (props.disabled || (m === 'audience' && audienceLocked.value)) return
  mode.value = m
}
const pick = (id: string) => { if (!props.disabled) audienceId.value = id }
</script>

<template>
  <div class="mode-tabs">
    <button type="button" class="mode-tab" :class="{ on: mode === 'judge' }" :disabled="disabled" @click="setMode('judge')">By judge</button>
    <button type="button" class="mode-tab" :class="{ on: mode === 'audience' }"
      :disabled="disabled || audienceLocked"
      :title="audienceLocked ? 'The audiences module is not available' : undefined"
      @click="setMode('audience')">By audience</button>
    <button type="button" class="mode-tab" :class="{ on: mode === 'filter' }" :disabled="disabled" @click="setMode('filter')">By filter</button>
  </div>
  <p v-if="audienceLocked" class="step-tip">Audiences aren't available here, so this branch matches on a filter.</p>

  <PickList v-if="mode === 'audience'" label="Audience" icon="group" :items="vocab.audiences" :selected="audienceId"
    :disabled="disabled" empty="No audiences yet — create one in the Audiences module." @pick="pick" />

  <template v-else-if="mode === 'judge'">
    <div class="fld jg-fld">
      <label class="fld-l" for="jg-criteria">Question</label>
      <Textarea id="jg-criteria" v-model="criteria" rows="3" :disabled="disabled" class="full"
        placeholder="Has this person shown interest in booking a treatment?" />
      <!-- Says what the model can and cannot see. Without it the natural
           assumption is that it knows the person, and a question there is no
           evidence for reads as a broken branch rather than an unanswerable one. -->
      <p class="fld-hint">
        Answered yes/no from this person's recorded activity — what they read, opened, clicked, said.
        It sees nothing you haven't recorded, and someone with no activity always takes <b>No</b>.
      </p>
    </div>

    <div class="fld jg-fld">
      <label class="fld-l" for="jg-conf">Confidence <span class="jg-val">{{ confidence.toFixed(2) }}</span></label>
      <input id="jg-conf" v-model.number="confidence" type="range" min="0" max="1" step="0.05"
        :disabled="disabled" class="full" />
      <p class="fld-hint">Below this, the answer counts as No.</p>
    </div>

    <!-- Stated because determinism is the one property the other two modes have
         and this one does not, and nothing on screen would otherwise reveal it. -->
    <p class="step-tip">
      Unlike a filter, this is a judgement rather than a lookup — the same person can be answered
      differently on a re-run. Every verdict is recorded on the step run, with its reason.
    </p>
  </template>

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

/* .fld is `flex: 1 1 0` because its usual home is a row of side-by-side fields
   (.unit-row). Stacked full-width here, so it must not stretch to share a line. */
.jg-fld { flex: none; margin-bottom: 12px; }
/* The live value beside the label, in the label's own row rather than under the
   slider — a range with no readout leaves you guessing what 0.7 looks like. */
.jg-val { float: right; font-variant-numeric: tabular-nums; letter-spacing: normal; text-transform: none; color: var(--text-strong); }
</style>
