<script setup lang="ts">
// Node editor panel — the chrome around whichever per-kind editor the selected
// step needs (steps/index.ts's registry). This component knows nothing about
// any individual kind: it renders the kind's icon/label/description and its
// Name field, then hands the draft config to the registered editor.
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { stepKind, stepMeta, type StepVocab } from '../steps'
import '../steps/step-editor.css'
import './panel.css'

defineProps<{
  kind?: string
  draft: { label?: string; config: any } | null
  vocab: StepVocab
  dirty?: boolean
  disabled?: boolean
  nodeId?: string | null
}>()
defineEmits(['delete', 'discard', 'save'])
</script>

<template>
  <p v-if="!kind || !draft" class="pane-tip">Pick a step on the canvas to edit its properties.</p>
  <template v-else>
    <div class="step-title">
      <span class="material-symbols-outlined" :class="{ fill: stepMeta(kind).fill }">{{ stepMeta(kind).icon }}</span>
      <span class="step-kind-name">{{ stepMeta(kind).label }}</span>
    </div>
    <p class="pane-tip">{{ stepMeta(kind).description }}</p>
    <div class="step-form">
      <label class="fld"><span class="fld-l">Name</span>
        <InputText v-model="draft.label" class="full" :placeholder="stepMeta(kind).label" :disabled="disabled" />
      </label>
      <!-- Keyed on the node id so opening another step of the same kind gives
           the editor a fresh setup() rather than reusing state derived from
           the previous node (Wait's display unit, Branch's parsed filter). -->
      <component :is="stepKind(kind)!.editor" v-if="stepKind(kind)"
        :key="nodeId" :config="draft.config" :vocab="vocab" :disabled="disabled" />
    </div>
    <div class="b-actions">
      <Button label="Delete" text severity="danger" size="small" :disabled="disabled" @click="$emit('delete')" />
      <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
      <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="$emit('discard')" />
      <Button label="Save" size="small" :disabled="!dirty || disabled" @click="$emit('save')" />
    </div>
  </template>
</template>

<style scoped>
.step-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; margin-bottom: 12px; }
.step-title > .material-symbols-outlined { color: var(--accent); font-size: 13px; flex: none; }
/* click-target-sized rename header for a narrow pane — unrelated to the
   journey title in the center pane. */
.step-kind-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 14px; font-weight: 650; color: var(--text-strong); }
.step-form { display: flex; flex-direction: column; gap: 12px; }
/* same double-spacing fix as TriggerPanel's .trig-fields > .event-group-label:
   the label's own margin-bottom would stack on .step-form's flex gap. */
.step-form :deep(.event-group-label) { margin-bottom: 0; }
</style>
