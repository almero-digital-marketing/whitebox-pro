<script setup lang="ts">
// Facts: the ones on record, and the form to add another — for a correction,
// or something learned off-system.
//
// ONE component for one person and for a whole selection. Recording a fact is
// the same act either way — same schema, same append-only timeline, same
// `source` — so a second bulk-flavoured panel would only be a chance for the
// two to drift. `bulk` swaps the target of submit() and the source of the key
// suggestions; everything else on screen is the same control in the same place.
//
// The key is FREE TEXT and stays that way: facts have no fixed vocabulary and
// every deployment names them differently. Seeing the keys that already exist
// is what makes that survivable — you can spot `client_status` before typing
// `clientStatus` next to it. For one person that's their own list, right above
// the field; for a selection there's no such list, which is exactly why the
// deployment-wide vocabulary is fetched and fed to the same suggestions.
import { ref, computed, watch } from 'vue'
import AutoComplete from 'primevue/autocomplete'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { usePeopleStore } from '../stores/people'
import type { Person } from '../people'
import './panel.css'

const props = defineProps<{ person?: Person | null; disabled?: boolean; bulk?: boolean }>()
const store = usePeopleStore()

const key = ref('')
const value = ref('')
const saving = ref(false)
const error = ref('')
const note = ref('')
// a receipt that outlived the selection it describes would be a lie about what
// the panel is currently pointed at
watch(() => [props.person?.id, store.selectionCount], () => { note.value = '' })

// Whatever keys this deployment happens to have put on this person. Nothing
// here assumes any particular one exists — there is no such thing as a
// standard fact key.
const entries = computed(() => Object.entries(props.person?.facts || {}))
const asText = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v))

// This person's keys first, then everything else in use — the ones they
// already have are the likeliest next edit, and are also the ones a typo would
// silently fork. In bulk there is no "this person", so it's the vocabulary alone.
const existingKeys = computed(() => {
  const mine = props.bulk ? [] : entries.value.map(([k]) => k)
  return [...mine, ...store.factKeys.filter(k => !mine.includes(k))]
})
const suggestions = ref<string[]>([])
const complete = (e: { query: string }) => {
  const s = e.query.trim().toLowerCase()
  suggestions.value = s ? existingKeys.value.filter(k => k.toLowerCase().includes(s)) : [...existingKeys.value]
}

// The value that's actually there now, so an overwrite is visible before you
// commit it rather than after. Only answerable for one person: across a
// selection there is no single "current" value to warn about.
const currentValue = computed(() => {
  const k = key.value.trim()
  if (props.bulk || !k || !(k in (props.person?.facts || {}))) return null
  return asText(props.person!.facts[k])
})

const dirty = computed(() => !!key.value.trim() || value.value !== '')
const hasTarget = computed(() => (props.bulk ? store.selectionCount > 0 : !!props.person))
const canSubmit = computed(() =>
  !props.disabled && hasTarget.value && !!key.value.trim() && value.value !== '' && !saving.value)
// Only ever adds, so there's no prior state to snap back to — Discard clears
// the form (ADR rule 5's "never saved" case).
function discard() { key.value = ''; value.value = ''; error.value = ''; note.value = '' }

async function submit() {
  if (!canSubmit.value) return
  saving.value = true; error.value = ''; note.value = ''
  const fact = { key: key.value.trim(), value: value.value }
  try {
    // send as text — the server infers the type, the same way any plugin's
    // facts.record() call does
    if (props.bulk) {
      // An inline receipt, because bulk has nothing to show: for one person the
      // new fact simply appears in the list above, which IS the confirmation.
      const r = await store.recordFactForSelection(fact)
      const merged = r.requested - r.recorded
      note.value = `Recorded ${fact.key} on ${r.recorded}`
        + (merged > 0 ? ` · ${merged} resolved to someone already in the set` : '')
        + (r.truncated ? ' · capped at 5000, narrow the search and run it again' : '')
    } else {
      await store.recordFact(props.person!.id, fact)
    }
    value.value = ''
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <p v-if="!person && !bulk" class="pane-tip">Open someone to see their facts.</p>
  <div v-else class="p-form">
    <!-- Only for one person. A selection's members each have their own facts,
         and merging them into a list would invent a shared truth that isn't
         there — "client_status: active" for 3 of 40 reads as if it applied to
         all of them. The form below is the part that generalises. -->
    <ul v-if="!bulk" class="plain-list closed">
      <!-- key over value, not side by side: a fact value can be a sentence,
           and a fixed-width key column would leave it a sliver of the pane -->
      <li v-for="[k, v] in entries" :key="k" class="ent-row">
        <div class="ent-top"><span class="fact-key">{{ k }}</span></div>
        <span class="fact-value">{{ asText(v) }}</span>
      </li>
      <li v-if="!entries.length" class="rail-empty">
        No facts recorded. Keys are arbitrary — whatever you type below starts a new one.
      </li>
    </ul>
    <p v-else class="pane-tip">
      Records the same fact on all {{ store.selectionCount }}. It's appended, not overwritten —
      anyone who already has this key keeps their old value in history.
    </p>

    <label class="fld"><span class="fld-l">Key</span>
      <AutoComplete v-model="key" :suggestions="suggestions" :dropdown="!!existingKeys.length" class="full ac"
        placeholder="an existing key, or a new one" :disabled="disabled" @complete="complete" />
    </label>
    <label class="fld"><span class="fld-l">Value</span>
      <InputText v-model="value" class="full" placeholder="true, 42, or plain text" :disabled="disabled"
        @keyup.enter="submit" />
    </label>
    <!-- facts are an append-only timeline, so this doesn't destroy the old
         value — but it does change what the person currently reads as -->
    <p v-if="currentValue !== null" class="fld-hint warn">
      Currently <b>{{ currentValue }}</b>. Recording adds a newer value; the old one stays in history.
    </p>
    <p v-if="error" class="fld-hint danger">{{ error }}</p>
    <p v-if="note" class="fld-hint ok">{{ note }}</p>
    <!-- "Record fact", not "Save": this appends a new value to the person's
         timeline rather than committing an edit. With no section title above,
         the button is what names the action — same as Identities and Lists.
         In bulk the count rides in the verb, stating the scope at the one
         moment it matters: when you commit to it. -->
    <div class="b-actions">
      <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
      <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discard" />
      <Button :label="bulk ? `Record on ${store.selectionCount} selected` : 'Record fact'" size="small"
        :loading="saving" :disabled="!canSubmit" @click="submit" />
    </div>
  </div>
</template>

<style scoped>
.ac { display: flex; }
.ac :deep(.p-autocomplete-input) { flex: 1 1 auto; min-width: 0; }
</style>
