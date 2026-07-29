<script setup lang="ts">
// One condition on a person: a stored Fact (key/op/value) or an Activity they did
// (events + campaign + a count/sum threshold). Reused by Analytics' people-selector
// and custom-series, and by Journeys' branch-step condition editor (see
// ConditionsBuilder.vue for the combinator+list wrapper). `compact` (custom-series)
// shows only the events row; the `lead` slot holds the series name. Mutates the
// passed-in condition object (a model array item).
import { computed } from 'vue'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Button from 'primevue/button'
import { OPS, OP_GROUP, CLAUSE_TYPES, MEASURES, CMPS } from './constants'
import './conditions.css'

const props = defineProps<{
  condition: any
  factKeys: any[]
  eventOpts: any[]
  campaignOpts?: any[]
  compact?: boolean
  disabled?: boolean
}>()
defineEmits(['remove'])

// window is stored as one backend-shaped string (see server/src/selector/metric.js's
// windowMs — "7d", "24h", "2w") but edited as a number + unit pair; these compute
// getters/setters keep that single string the source of truth (parse on read,
// compose on write) rather than adding parallel state to keep in sync.
const WINDOW_UNITS = [{ label: 'hours', value: 'h' }, { label: 'days', value: 'd' }, { label: 'weeks', value: 'w' }]
const windowAmount = computed({
  get: () => { const m = /^(\d+)/.exec(props.condition.window || ''); return m ? Number(m[1]) : null },
  set: (v) => { props.condition.window = v ? `${v}${windowUnit.value}` : '' },
})
const windowUnit = computed({
  get: () => { const m = /(h|d|w)$/.exec(props.condition.window || ''); return m ? m[1] : 'd' },
  set: (v) => { if (windowAmount.value) props.condition.window = `${windowAmount.value}${v}` },
})

// ── what the chosen fact actually contains ──
// "client_status eq ___" is unanswerable without knowing the vocabulary, and
// "lifetime_value gte ___" is unanswerable without knowing the scale — so the
// row describes the key it's pointed at. WHICH description depends on the
// operator, because each one asks the data a different question (OP_GROUP):
// an exact match wants the values, a range wants the bounds, a presence check
// wants the population. The numbers come from the discovered schema
// (factKeyOptions), so they're the real data, never a guess.
const factMeta = computed(() => props.factKeys.find((k: any) => k.value === props.condition.key))

// A saved condition can name a fact the schema has never seen — facts are
// core and channel-agnostic (any plugin, import or API call can write one via
// ctx.facts.record), so a key with no rows yet is perfectly legitimate, not an
// error. Left out of the options, PrimeVue's Select falls back to its
// placeholder, so the row renders as if NOTHING were selected while the saved
// filter really does still filter on it. Union the current key in so the
// picker always shows what it's actually set to. (Same fix as the breakdown
// Values picker, for the same reason.)
const keyOpts = computed(() => {
  const key = props.condition.key
  if (!key || props.factKeys.some((k: any) => k.value === key)) return props.factKeys
  return [{ label: key, value: key, unknown: true }, ...props.factKeys]
})

const list = (vals: any[], max = 6) => vals.length <= max
  ? vals.join(', ')
  : `${vals.slice(0, max).join(', ')} …`

const factHint = computed(() => {
  if (props.condition.type !== 'fact') return ''
  const k: any = factMeta.value
  // named but never recorded — the most confusing state to leave undescribed,
  // since the row looks identical to one pointed at a fact full of data
  if (!k) {
    return props.condition.key
      ? `Nothing recorded for “${props.condition.key}” yet — it'll match once something writes it.`
      : ''
  }
  const people = k.people == null ? '' : ` · ${k.people} ${k.people === 1 ? 'person' : 'people'}`

  if (OP_GROUP[props.condition.op] === 'presence') {
    return k.people == null ? '' : `Recorded for ${k.people} ${k.people === 1 ? 'person' : 'people'}.`
  }

  if (OP_GROUP[props.condition.op] === 'range') {
    if (k.min == null || k.max == null) return `No range known for this fact${people}`
    // A range operator over text compares alphabetically, which is almost
    // never what someone means — say so rather than quietly showing bounds
    // that look numeric ("Burgas to Varna") and behave like a word sort.
    if (k.type !== 'number' && k.type !== 'date') {
      return `“${k.label}” holds text, so ranges compare alphabetically (${k.min} … ${k.max}). Use “eq” or “in” instead.`
    }
    return `Ranges from ${k.min} to ${k.max}${people}`
  }

  // exact match — the full vocabulary when it's short enough to be a real
  // choice list, otherwise a few examples plus how many there actually are,
  // so nobody reads a truncated list as the whole set.
  if (k.values?.length) return `One of: ${list(k.values)}`
  if (k.sample?.length) return `e.g. ${list(k.sample, 3)} — ${k.distinct} distinct values${people}`
  return ''
})
</script>

<template>
  <div class="cond">
    <div class="cond-top">
      <slot name="lead" />
      <Button :label="condition.not ? 'is not' : 'is'" size="small" :severity="condition.not ? 'danger' : 'secondary'"
        :outlined="!condition.not" class="notbtn" :disabled="disabled" @click="condition.not = !condition.not" />
      <Select v-model="condition.type" :options="CLAUSE_TYPES" optionLabel="label" optionValue="value" class="cond-type" :disabled="disabled" />
      <span v-if="!compact" class="cond-note muted">{{ condition.type === 'fact' ? 'a stored attribute' : 'an action they took' }}</span>
      <Button text rounded size="small" severity="secondary" :disabled="disabled" @click="$emit('remove')"><template #icon><span class="material-symbols-outlined">close</span></template></Button>
    </div>

    <template v-if="condition.type === 'fact'">
      <div class="cond-fields">
        <Select v-model="condition.key" :options="keyOpts" optionLabel="label" optionValue="value" filter placeholder="fact" class="f-key" :disabled="disabled">
          <!-- the unioned-in key (see keyOpts) sits among real facts and would
               otherwise be indistinguishable from one that has data -->
          <template #option="{ option }">
            <span class="k-opt">
              <span>{{ option.label }}</span>
              <span v-if="option.unknown" class="k-opt-note">not recorded yet</span>
            </span>
          </template>
        </Select>
        <Select v-model="condition.op" :options="OPS" optionLabel="label" optionValue="value" class="f-op" :disabled="disabled" />
        <InputText v-if="condition.op !== 'present'" v-model="condition.value" class="f-val" placeholder="value" :disabled="disabled" />
      </div>
      <!-- sits outside .cond-fields (a wrapping row) so it always gets its own
           line rather than trying to squeeze in beside the last control -->
      <p v-if="factHint" class="f-hint">{{ factHint }}</p>
    </template>

    <div v-else class="cond-metric">
      <div class="m-group"><span class="m-lab">Events</span>
        <MultiSelect v-model="condition.events" :options="eventOpts" optionLabel="label" optionValue="value" filter display="chip" placeholder="any event" class="m-grow" :disabled="disabled" /></div>
      <template v-if="!compact">
        <div class="m-group"><span class="m-lab">Campaigns</span>
          <MultiSelect v-model="condition.campaigns" :options="campaignOpts" optionLabel="label" optionValue="value" filter display="chip" placeholder="any campaign" class="m-grow" :disabled="disabled" /></div>
        <div class="m-row">
          <Select v-model="condition.measure" :options="MEASURES" optionLabel="label" optionValue="value" class="f-op" :disabled="disabled" />
          <Select v-model="condition.cmp" :options="CMPS" optionLabel="label" optionValue="value" class="f-cmp" :disabled="disabled" />
          <InputText v-model="condition.mvalue" class="f-num" placeholder="n" :disabled="disabled" />
        </div>
        <div class="m-row">
          <span class="m-lab f-win-lab">Lookback</span>
          <InputNumber v-model="windowAmount" :min="1" placeholder="any" class="f-win-num" :disabled="disabled" />
          <Select v-model="windowUnit" :options="WINDOW_UNITS" optionLabel="label" optionValue="value" class="f-win-unit" :disabled="disabled" />
        </div>
      </template>
    </div>
  </div>
</template>
