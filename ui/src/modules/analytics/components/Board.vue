<script setup lang="ts">
import { ref, watch } from 'vue'
import draggable from 'vuedraggable'
import Button from 'primevue/button'
import WidgetCard from './WidgetCard.vue'
import { useAnalyticsStore } from '../stores/analytics'

const props = defineProps<{ report: any; data: Record<string, any>; selectedId?: string }>()
const emit = defineEmits(['remove', 'select', 'reorder', 'deselect'])
const store = useAnalyticsStore()

// click on empty board space (not on a widget card) → deselect the current widget
function onBgClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.card') && !(e.target as HTMLElement).closest('.b-name')) emit('deselect')
}

// Local, draggable copy of the widget list. Kept in sync with the report; the
// drag library mutates this array, and on drop we emit the new id order.
const items = ref<any[]>([])
watch(() => props.report?.widgets, (w) => { items.value = (w || []).slice() }, { immediate: true })

function onReorder() {
  emit('reorder', items.value.map((w: any) => w.id))
}

// report name — edited in place at the top of the report itself, same save/discard
// pattern as Audiences' composition pane: a local draft + dirty flag, Discard reverts
// to the last-saved name, Save calls the store directly (this pane owns the store call
// itself, same as Audiences, rather than routing an awaitable save through an emit).
const nameDraft = ref('')
const dirty = ref(false)
const saving = ref(false)
watch(() => props.report?.id, () => { nameDraft.value = props.report?.name || ''; dirty.value = false }, { immediate: true })
watch(() => props.report?.name, (n) => { if (!dirty.value) nameDraft.value = n || '' })
function onNameInput() { dirty.value = nameDraft.value.trim() !== (props.report?.name || '').trim() }
function discardName() { nameDraft.value = props.report?.name || ''; dirty.value = false }
async function saveName() {
  if (!dirty.value || saving.value) return
  const v = nameDraft.value.trim()
  if (!v) { discardName(); return }
  saving.value = true
  try { await store.renameReport(v); dirty.value = false }
  finally { saving.value = false }
}
</script>

<template>
  <div v-if="!report" class="placeholder muted">
    <div>
      <h2>WhiteBox Analytics</h2>
      <p>Pick a report on the left, or ask a question to build one.</p>
    </div>
  </div>
  <div v-else class="doc-wrap" @click="onBgClick">
    <div class="b-scroll">
      <div class="b-head">
        <input v-model="nameDraft" class="b-name" placeholder="Report name" @input="onNameInput" />
      </div>
      <draggable v-model="items" item-key="id" handle=".card-head" :animation="160"
        ghost-class="drag-ghost" class="doc" @end="onReorder">
        <template #item="{ element }">
          <div class="doc-item">
            <WidgetCard :widget="element" :state="data[element.id]" :selected="element.id === selectedId"
              @remove="emit('remove', $event)" @select="emit('select', $event)" @deselect="emit('deselect')" />
          </div>
        </template>
      </draggable>
    </div>
    <div class="b-actions">
      <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discardName" />
      <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
      <Button label="Save changes" size="small" :disabled="!dirty" :loading="saving" @click="saveName">
        <template #icon><span class="material-symbols-outlined">check</span></template>
      </Button>
    </div>
  </div>
</template>

<style scoped>
.placeholder { display: grid; place-items: center; height: 100%; text-align: center; }
.placeholder h2 { margin: 0 0 6px; color: var(--text); }
.doc-wrap { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.b-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
/* report name — reads as a heading at rest; becomes a regular input box (border + bg) on
   hover/focus. Transparent border + negative margin keep the resting position so nothing
   shifts. Same pattern as Audiences' .b-name. */
.b-head { padding: 7px 16px 0; }
.b-name { width: 100%; box-sizing: border-box; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 20px; font-weight: 650; color: var(--text-strong); padding: 6px 10px; margin-left: -10px; transition: border-color .12s, background .12s; }
.b-name:hover { border-color: var(--border); }
.b-name:focus { outline: none; border-color: var(--accent); background: var(--panel); }
/* document flow — one full-width section on top of the other */
/* shrunk by 2×10px vs. the old 32/30/34 — WidgetCard's .card now carries that 10px as its
   own permanent padding on every side, so the total space between two cards' content is
   unchanged; it's just partly owned by each card instead of entirely by this gap. */
.doc { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.doc-item { width: 100%; min-width: 0; }
.drag-ghost > * { box-shadow: 0 0 0 2px var(--accent-soft); border-radius: 10px; }
/* fixed Discard/Save bar — same pattern as Audiences' .b-actions: always rendered,
   disabled (not hidden) when clean, a fading "Unsaved changes" note. */
.b-actions { flex: none; height: 52px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-top: 1px solid var(--border); }
.save-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-right: auto; }
.save-note .material-symbols-outlined { font-size: 8px; color: #d97706; }
.save-note--hidden { visibility: hidden; }
</style>
