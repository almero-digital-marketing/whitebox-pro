<script setup lang="ts">
// Wait step — pause the enrollment for a fixed duration.
import { ref, computed } from 'vue'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import './step-editor.css'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

// The amount + unit pair is a display-only convenience — the one thing actually
// persisted is config.duration_ms (journeys.js's wait schema). Same shape as
// the shared condition builder's Lookback field: the stored scalar stays the
// source of truth and these computeds just divide/multiply by the chosen unit,
// so there's no shadow state to keep in sync and a getter can't dirty the draft.
const UNITS = [{ label: 'minutes', value: 60_000 }, { label: 'hours', value: 3_600_000 }, { label: 'days', value: 86_400_000 }]
// The unit isn't recoverable from duration_ms alone (7200000 is equally "120
// minutes" and "2 hours"), so it's local state — seeded once here to the
// coarsest unit the stored value divides into cleanly, then left to the user.
// This component is keyed on the node id, so opening another step re-runs it.
const ms0 = props.config.duration_ms || 0
const unitMs = ref(ms0 && ms0 % 86_400_000 === 0 ? 86_400_000 : ms0 && ms0 % 3_600_000 === 0 ? 3_600_000 : 60_000)

const amount = computed({
  get: () => { const ms = props.config.duration_ms || 0; return ms ? Math.round(ms / unitMs.value) : null },
  set: (v) => { props.config.duration_ms = (v || 0) * unitMs.value },
})
// changing the unit keeps the number the user is looking at and rescales the
// stored ms to match ("2" + hours→days becomes 2 days, not 0.083 days).
const unit = computed({
  get: () => unitMs.value,
  set: (u) => { const amt = amount.value; unitMs.value = u; if (amt) props.config.duration_ms = amt * u },
})
</script>

<template>
  <div class="unit-row">
    <span class="fld-l">Duration</span>
    <InputNumber v-model="amount" :min="1" placeholder="any" class="unit-num" :disabled="disabled" />
    <Select v-model="unit" :options="UNITS" optionLabel="label" optionValue="value" class="unit-sel" :disabled="disabled" />
  </div>
</template>
