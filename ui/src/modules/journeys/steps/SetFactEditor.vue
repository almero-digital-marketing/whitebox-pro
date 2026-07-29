<script setup lang="ts">
// Set Fact step — store a key/value fact on the enrollment's passport.
import { ref, computed } from 'vue'
import AutoComplete from 'primevue/autocomplete'
import './step-editor.css'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

// Autocompletes, not selects: this step's whole job can be to introduce a key
// nobody has recorded yet, so the observed vocabulary can only ever be a
// suggestion — free text always wins.
//
// Same enriched option shape (factKeyOptions) the condition builder uses, so
// both surfaces describe a fact from one definition instead of two that drift.
const factKeys = computed<any[]>(() => props.vocab.factKeys || [])
const meta = computed<any>(() => factKeys.value.find((k) => k.value === props.config.key))

// A fact value is stored as JSON but this editor holds the TYPED form — the
// same string Journeys.vue's coerceSetFactConfig() parses back at save time —
// so a suggestion has to be offered as you'd type it: bare text for strings,
// JSON for numbers and booleans.
const asTyped = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v))
// mirrors coerceSetFactConfig: what this value will ACTUALLY be once saved
const asStored = (raw: string) => { try { return JSON.parse(raw) } catch { return raw } }

// `values` is the COMPLETE distinct set for a categorical key and empty for a
// high-cardinality one like full_name (see the analytics plugin's
// discoverSchema). So the dropdown button only appears when picking from a list
// is actually meaningful — better than offering a truncated eight and implying
// that's all there is.
const valueChoices = computed<string[]>(() => (meta.value?.values || []).map(asTyped))

const list = (vals: any[], max = 6) => (vals.length <= max ? vals.join(', ') : `${vals.slice(0, max).join(', ')} …`)

// The mirror of the condition row's factHint, but for WRITING rather than
// reading — so the emphasis flips. A key nothing has recorded is the normal
// way to create a fact here, not the dead filter it would be in a condition;
// it's stated, never warned about. When the key does exist, what matters is
// what's already in it, so a new write stays consistent with the rest.
const keyHint = computed(() => {
  if (!props.config.key) return ''
  const k = meta.value
  if (!k) return 'New fact — nothing records this key yet.'
  const who = k.people == null ? '' : `${k.people} ${k.people === 1 ? 'person has' : 'people have'} this`
  const join = (rest: string) => [who, rest].filter(Boolean).join(' · ')
  if (k.values?.length) return join(`currently one of: ${list(k.values)}`)
  if ((k.type === 'number' || k.type === 'date') && k.min != null) return join(`currently ${k.min} … ${k.max}`)
  if (k.sample?.length) return join(`${k.distinct} distinct values, e.g. ${list(k.sample, 3)}`)
  return who
})

// The value line only speaks up when the write would be inconsistent with what
// the fact already holds — the two mistakes a picker can't prevent because the
// field is deliberately free text: a near-miss on an established vocabulary
// ("Active" vs "active"), and a number typed so it lands as a string.
const valueHint = computed(() => {
  const k = meta.value
  const raw = String(props.config.value ?? '').trim()
  if (!k || !raw) return ''
  const stored = asStored(raw)
  if (k.type === 'number' && typeof stored !== 'number') {
    return `“${k.label}” holds numbers — “${raw}” would be stored as text.`
  }
  if (k.values?.length && !k.values.map(String).includes(String(stored))) {
    return `Adds a new value — “${k.label}” currently only holds ${list(k.values)}.`
  }
  return ''
})

const keySuggestions = ref<string[]>([])
const valueSuggestions = ref<string[]>([])
// an empty query is the dropdown button, which must offer everything
const matching = (pool: string[], query: string) => {
  const s = query.trim().toLowerCase()
  return s ? pool.filter((v) => v.toLowerCase().includes(s)) : pool.slice()
}
const completeKey = (e: { query: string }) => { keySuggestions.value = matching(factKeys.value.map((k) => k.value), e.query) }
const completeValue = (e: { query: string }) => { valueSuggestions.value = matching(valueChoices.value, e.query) }
</script>

<template>
  <label class="fld"><span class="fld-l">Key</span>
    <AutoComplete v-model="config.key" :suggestions="keySuggestions" dropdown class="full ac"
      placeholder="an existing fact, or a new one" :disabled="disabled" @complete="completeKey" />
    <p v-if="keyHint" class="fld-hint">{{ keyHint }}</p>
  </label>
  <label class="fld"><span class="fld-l">Value</span>
    <AutoComplete v-model="config.value" :suggestions="valueSuggestions" :dropdown="!!valueChoices.length" class="full ac"
      placeholder="true, 42, or plain text" :disabled="disabled" @complete="completeValue" />
    <p v-if="valueHint" class="fld-hint">{{ valueHint }}</p>
  </label>
</template>
