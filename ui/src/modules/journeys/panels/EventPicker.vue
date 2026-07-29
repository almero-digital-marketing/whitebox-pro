<script setup lang="ts">
// The observed-events toggle list, grouped by the event's own dot-prefix
// (mail/sms/journey/campaigns/…) — the same shape as Users' permissions
// catalog, grouped by a real prefix rather than a declared module.
//
// Extracted because two places now pick from the same vocabulary for opposite
// reasons: the TRIGGER picks the events that start a journey, the GOAL picks
// the ones that mean it worked. Same list, same interaction, and keeping one
// copy is what stops them drifting apart.
import { computed } from 'vue'
import '../steps/step-editor.css'   // .event-group-label

const props = defineProps<{
  selected: string[]
  eventsRegistry: any[]
  disabled?: boolean
  empty?: string
}>()
const emit = defineEmits<{ (e: 'toggle', type: string): void }>()

const byGroup = computed(() => {
  const groups: Record<string, any[]> = {}
  for (const e of props.eventsRegistry) (groups[e.type.split('.')[0]] ||= []).push(e)
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
})

const fmtDate = (s: string) => (s ? new Date(s).toLocaleString() : '')
</script>

<template>
  <p v-if="!eventsRegistry.length" class="pane-tip">
    {{ empty || "No events observed yet — trigger one anywhere in the app (send a mail, log in, etc.) and it'll show up here to pick from." }}
  </p>
  <div v-for="[group, items] in byGroup" :key="group" class="event-group">
    <div class="event-group-label">{{ group }}</div>
    <div v-for="e in items" :key="e.type" class="event-item" :class="{ disabled }">
      <span class="event-item-main">
        <span class="event-item-label">{{ e.type }}</span>
        <span class="event-item-desc">seen {{ e.count }}× · last {{ fmtDate(e.last_seen_at) }}</span>
      </span>
      <button type="button" class="sw" :class="{ on: selected.includes(e.type) }"
        :disabled="disabled" :aria-label="`Toggle ${e.type}`" @click="emit('toggle', e.type)"><i /></button>
    </div>
  </div>
</template>

<style scoped>
/* same grouped-toggle-list pattern as Users.vue's permissions catalog */
.event-group { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
.event-group:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
.event-item { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.event-item.disabled { opacity: .6; }
.event-item-main { flex: 1 1 auto; min-width: 0; }
.event-item-label { display: block; font-size: 13px; font-weight: 550; color: var(--text-strong); font-family: ui-monospace, monospace; }
.event-item-desc { display: block; font-size: 11.5px; color: var(--muted); }
</style>
