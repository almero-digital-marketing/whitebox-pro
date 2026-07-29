<script setup lang="ts">
// A pick-one-or-many list of named records (campaigns, audiences), rendered as
// the same pill toggles Audiences' segment picker uses. Journeys renders this
// shape in three places — the trigger's audience list, the Campaign step and
// the Branch step's audience mode — which is why it's a component and not
// three copies of the same <ul>.
//
// `selected` takes an id or a list of ids, so the same component covers the
// single-select steps and the multi-select trigger; the parent decides what a
// pick means (replace vs toggle) by what it does in @pick.
import './step-editor.css'   // .event-group-label

defineProps<{
  items: any[]
  selected: string | string[] | null | undefined
  icon: string
  empty: string
  label?: string
  disabled?: boolean
}>()
defineEmits<{ pick: [id: string] }>()

const isOn = (selected: string | string[] | null | undefined, id: string) =>
  Array.isArray(selected) ? selected.includes(id) : selected === id
</script>

<template>
  <span v-if="label" class="event-group-label">{{ label }}</span>
  <ul class="pick-list">
    <li v-for="it in items" :key="it.id" class="pick-pill"
      :class="{ selected: isOn(selected, it.id), disabled }" @click="!disabled && $emit('pick', it.id)">
      <span class="material-symbols-outlined">{{ icon }}</span>
      <span class="pick-name">{{ it.name }}</span>
      <span v-if="isOn(selected, it.id)" class="material-symbols-outlined pick-check">check</span>
    </li>
    <li v-if="!items.length" class="pick-empty">{{ empty }}</li>
  </ul>
</template>

<style scoped>
.pick-list { list-style: none; margin: 0; padding: 0; }
.pick-pill { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--panel); }
.pick-pill:hover { border-color: var(--border-2); }
.pick-pill.selected { border-color: var(--accent); background: var(--accent-soft); }
.pick-pill.disabled { cursor: default; opacity: .6; }
.pick-pill .material-symbols-outlined { font-size: 12px; color: var(--muted); }
.pick-name { flex: 1 1 auto; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick-pill.selected .pick-name { color: var(--accent); font-weight: 600; }
.pick-check { font-size: 11px; color: var(--accent) !important; }
.pick-empty { padding: 14px 10px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
</style>
