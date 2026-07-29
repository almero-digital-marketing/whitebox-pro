<script setup lang="ts">
// breakdown / donut / radar / pivot / heatmap — all share the same "break down by a
// dimension" builder; only the rendering differs. The verb/unit wording comes
// from the model (bdVerb/bdUnit) per kind.
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import { MEASURE2 } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab">{{ model.bdVerb }}</label>
  <Select v-model="model.breakdownSlice" :options="model.breakdownSlices" optionLabel="label" optionValue="value" class="w"
    placeholder="pick a dimension" />
  <!-- Event attributes only: narrow the (long, unrelated) key list to one
       collecting subsystem first. Purely a picker filter — the saved
       dimension is still attr:<key>. -->
  <template v-if="model.needsAttrSource">
    <label class="lab">Source</label>
    <!-- "All sources" is the empty value, and PrimeVue renders '' as
         no-selection — so the placeholder has to carry that same wording or
         the field just looks blank. -->
    <Select v-model="model.attrSource" :options="model.attrSources" optionLabel="label" optionValue="value" class="w"
      placeholder="All sources" />
  </template>
  <template v-if="model.needsBreakdownKey">
    <label class="lab">{{ model.breakdownSlice === 'fact' ? 'Which fact' : 'Which attribute' }}</label>
    <Select v-model="model.breakdownKey" :options="model.breakdownKeyOpts" optionLabel="label" optionValue="value" filter class="w"
      :placeholder="model.breakdownSlice === 'fact' ? 'pick a fact' : 'pick an attribute'">
      <template #option="{ option }">
        <span class="opt-row">
          <span>{{ option.label }}</span>
          <span v-if="option.hint" class="opt-hint">{{ option.hint }}</span>
        </span>
      </template>
      <template #empty>No attributes from this source.</template>
    </Select>
  </template>
  <template v-if="model.isFactDim">
    <label class="lab">Values</label>
    <MultiSelect v-model="model.breakdownValues" :options="model.breakdownValueOpts" optionLabel="label" optionValue="value"
      filter display="chip" class="w" placeholder="pick values" />
    <p class="hint">One {{ model.bdUnit }} per value — pick the fact values to compare.</p>
  </template>
  <template v-else-if="model.breakdownDim">
    <label class="lab">Measure</label>
    <Select v-model="model.breakdownMeasure" :options="MEASURE2" optionLabel="label" optionValue="value" class="w" />
    <p class="hint">People = distinct customers per {{ model.bdUnit }}; Events = total events.</p>
  </template>
</template>
