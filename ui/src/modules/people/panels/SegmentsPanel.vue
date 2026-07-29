<script setup lang="ts">
// The static lists. Two existing idioms, nothing new:
//   · the create form is a plain `.fld` + InputText with the standard
//     note/Discard/action row — the action reads "Add new" because it
//     creates a list rather than saving an edit to this person
//   · the lists themselves are the `.seg-pill` palette Audiences uses to
//     compose a rule — same gesture, click to put in or take out
//
// ONE component for one person and for a whole selection, same as FactsPanel:
// putting people on a list is the same act at either size, and a separate bulk
// panel would only be a second place for the idiom to drift.
//
// Only LIST segments appear. A query segment recomputes its membership from a
// predicate on every resolve, so "adding" someone to one would be undone the
// next time it ran — a pill that lies.
import { ref, computed, watch } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { usePeopleStore } from '../stores/people'
import type { Person } from '../people'
import './panel.css'

const props = defineProps<{ person?: Person | null; disabled?: boolean; bulk?: boolean }>()
const store = usePeopleStore()

// Which lists the subject is already on. Only answerable for one person: the
// search rows behind a selection don't carry membership, and "on it" for a
// cohort would have to mean all-of-them, which is a different question from
// the one a tick answers. So in bulk the pills are targets, not toggles.
const onIds = computed(() => new Set(props.bulk ? [] : (props.person?.segments || []).map(s => s.id)))
const error = ref('')
const note = ref('')
watch(() => [props.person?.id, store.selectionCount], () => { note.value = '' })

const hasTarget = computed(() => (props.bulk ? store.selectionCount > 0 : !!props.person))
// what a bulk write reports back, phrased the same way wherever it's shown
const receipt = (verb: string, r: { added: number; requested: number; truncated?: boolean }, listName: string) =>
  `${verb} ${r.added} to ${listName}`
  + (r.requested - r.added > 0 ? ` · ${r.requested - r.added} already on it` : '')
  + (r.truncated ? ' · capped at 5000, narrow the search and run it again' : '')

// ── create ──────────────────────────────────────────────────────────────────
const name = ref('')
const saving = ref(false)
const dirty = computed(() => !!name.value.trim())
const taken = computed(() =>
  store.lists.some(l => l.name.toLowerCase() === name.value.trim().toLowerCase()))
const canSubmit = computed(() => !props.disabled && hasTarget.value && dirty.value && !taken.value && !saving.value)
// Only ever adds, so there's nothing to revert to — Discard clears the field
// (ADR rule 5's "never saved" case).
function discard() { name.value = ''; error.value = ''; note.value = '' }

async function submit() {
  if (!canSubmit.value) return
  saving.value = true; error.value = ''; note.value = ''
  const listName = name.value.trim()
  try {
    if (props.bulk) {
      const r = await store.addSelectionToListNamed(listName)
      note.value = receipt('Created and added', r, r.listName)
    } else {
      await store.createAndAdd(props.person!.id, listName)
    }
    name.value = ''
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

// ── membership ──────────────────────────────────────────────────────────────
// Click toggles, like the Audiences palette. No save row of its own: there's no
// draft, each click is one request, and a Discard would have nothing to revert.
// In bulk it only ever adds — see onIds.
const busy = ref<string | null>(null)
async function toggle(id: string) {
  if (props.disabled || busy.value || !hasTarget.value) return
  busy.value = id; error.value = ''; note.value = ''
  try {
    if (props.bulk) {
      const r = await store.addSelectionToList(id)
      note.value = receipt('Added', r, store.lists.find(l => l.id === id)?.name || 'the list')
    } else if (onIds.value.has(id)) {
      await store.removeFromList(props.person!.id, id)
    } else {
      await store.addToList(props.person!.id, id)
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <p v-if="!person && !bulk" class="pane-tip">Open someone to see their lists.</p>
  <!-- null (not []) means the audiences plugin isn't registered at all -->
  <p v-else-if="person && person.segments === null" class="pane-tip">
    Lists come from the audiences plugin, which isn't registered on this deployment.
  </p>
  <div v-else class="p-form">
    <!-- no field label: one input, in a panel called Lists, with Save as the
         add action — "NEW LIST" above it restated both -->
    <label class="fld">
      <InputText v-model="name" class="full" placeholder="name a new list" :disabled="disabled"
        @keyup.enter="submit" />
    </label>
    <p v-if="taken" class="fld-hint warn">
      A list called <b>{{ name.trim() }}</b> already exists — click it below instead.
    </p>
    <p v-else class="fld-hint">
      Creating it also puts {{ bulk ? `all ${store.selectionCount} on it` : 'this person on it' }}.
      It becomes available to audiences like any other segment.
    </p>
    <p v-if="error" class="fld-hint danger">{{ error }}</p>
    <p v-if="note" class="fld-hint ok">{{ note }}</p>

    <!-- .save-bar, not .b-actions: the .sub-title below already draws a
         divider, and two would stack (ADR rule 6) -->
    <div class="save-bar">
      <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
      <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discard" />
      <!-- "Add new", not the usual "Save": this row doesn't commit an edit to
           the thing the panel is about, it creates a list that didn't exist.
           Membership below changes on click, with no save step at all. -->
      <Button :label="bulk ? `Add new for ${store.selectionCount}` : 'Add new'" size="small"
        :loading="saving" :disabled="!canSubmit" @click="submit" />
    </div>

    <div class="sub-title">Lists</div>
    <!-- One person: a tick marks the lists they're on and clicking removes
         them. A selection: no ticks, because "on it" would have to mean all of
         them and the search rows don't carry membership — so a click only ever
         adds, and the receipt above says how many actually moved. -->
    <p v-if="bulk" class="fld-hint seg-tip">Click a list to add all {{ store.selectionCount }} to it.</p>
    <ul class="rail-list seg-list">
      <li v-for="l in store.lists" :key="l.id" class="seg-pill"
        :class="{ used: onIds.has(l.id), disabled, busy: busy === l.id }" @click="toggle(l.id)">
        <span class="material-symbols-outlined" title="Static list">checklist</span>
        <span class="sp-name">{{ l.name }}</span>
        <span class="sp-size">{{ l.count != null ? l.count : '' }}</span>
        <span v-if="onIds.has(l.id)" class="material-symbols-outlined sp-used">check</span>
      </li>
      <li v-if="!store.lists.length" class="rail-empty">No lists yet — name one above.</li>
    </ul>
  </div>
</template>

<style scoped>
/* clickable, not draggable — Audiences owns the grab cursor because only it
   composes a rule by dragging */
.seg-pill { cursor: pointer; }
.seg-pill.disabled { cursor: default; opacity: .6; }
/* a bulk add over "all matching" re-runs the query server-side, so it's the one
   click here that can take a visible moment */
.seg-pill.busy { opacity: .6; pointer-events: none; }
/* sits between the .sub-title and the pills it explains, so it takes the
   heading's spacing rather than adding a third gap of its own */
.seg-tip { margin-top: -4px; }
/* no margin of its own — .p-form's 12px gap already separates it from the
   .sub-title above, the same as every other element in the form */
.seg-list { padding: 0; margin: 0; list-style: none; overflow: visible; }
</style>
