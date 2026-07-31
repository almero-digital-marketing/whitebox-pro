<script setup lang="ts">
// The event vocabulary as a toggle list, grouped by the event's own dot-prefix
// (mail/sms/journey/campaigns/…) — the same shape as Users' permissions catalog.
//
// Extracted because two places pick from the same vocabulary for opposite
// reasons: the TRIGGER picks the events that start a journey, the GOAL picks the
// ones that mean it worked. Same list, same interaction, and keeping one copy is
// what stops them drifting apart.
//
// It used to list only events that had ALREADY OCCURRED, and its empty state said
// so: "trigger one anywhere in the app and it'll show up here to pick from". That
// made it useless for the events people most want to automate on — you could not
// build "when a booking arrives, do X" until a booking had already arrived.
//
// Three sources now, because no one of them is enough (see the server's
// event-registry list()):
//   · declared  — every exact type a loaded plugin says it emits, offerable on a
//                 fresh install. Marked "not seen yet" rather than hidden.
//   · observed  — what has actually happened, with counts.
//   · families  — the open-ended prefixes (`crm.`, `conversion.`) whose members
//                 are the host system's vocabulary. Nothing can list them, so
//                 they get free-text entry under the prefix.
import { computed, ref } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import '../steps/step-editor.css'   // .event-group-label

const props = defineProps<{
  selected: string[]
  eventsRegistry: any[]
  eventFamilies?: any[]
  disabled?: boolean
  empty?: string
}>()
const emit = defineEmits<{ (e: 'toggle', type: string): void }>()

// Grouped by the type's own prefix, which is not always the owning module
// (`journey.*` belongs to `journeys`) — the prefix is what a person scanning the
// list actually reads.
const byGroup = computed(() => {
  const groups: Record<string, any[]> = {}
  for (const e of props.eventsRegistry) (groups[e.type.split('.')[0]] ||= []).push(e)
  // A selected type that is neither declared nor yet observed still has to appear,
  // or picking one from an open family would look like it did nothing.
  for (const t of props.selected) {
    const g = t.split('.')[0]
    if (!(groups[g] || []).some(e => e.type === t)) (groups[g] ||= []).push({ type: t, count: 0, custom: true })
  }
  for (const items of Object.values(groups)) items.sort((a, b) => a.type.localeCompare(b.type))
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
})

const families = computed(() => props.eventFamilies ?? [])

// Free-text entry, one input per family, so the prefix is fixed and the user only
// supplies the part only they can know.
const drafts = ref<Record<string, string>>({})
function addCustom(prefix: string) {
  const suffix = (drafts.value[prefix] || '').trim().replace(/^\.+/, '')
  if (!suffix) return
  const type = `${prefix}${suffix}`
  drafts.value[prefix] = ''
  if (!props.selected.includes(type)) emit('toggle', type)
}

const fmtDate = (s: string) => (s ? new Date(s).toLocaleString() : '')
const seenLabel = (e: any) =>
  e.count > 0 ? `seen ${e.count}× · last ${fmtDate(e.last_seen_at)}` : 'not seen yet'
</script>

<template>
  <p v-if="!eventsRegistry.length && !families.length" class="pane-tip">
    {{ empty || 'No events available — no plugin has declared any and none have been observed.' }}
  </p>

  <div v-for="[group, items] in byGroup" :key="group" class="event-group">
    <div class="event-group-label">{{ group }}</div>
    <div v-for="e in items" :key="e.type" class="event-item" :class="{ disabled }">
      <span class="event-item-main">
        <span class="event-item-label">{{ e.type }}</span>
        <!-- `count: 0` is a DECLARED event that hasn't fired. Saying "not seen yet"
             rather than hiding it is the whole point: you can automate on it now. -->
        <span class="event-item-desc" :class="{ unseen: !e.count }">{{ seenLabel(e) }}</span>
      </span>
      <button type="button" class="sw" :class="{ on: selected.includes(e.type) }"
        :disabled="disabled" :aria-label="`Toggle ${e.type}`" @click="emit('toggle', e.type)"><i /></button>
    </div>
  </div>

  <!-- The open vocabularies. A prefix with no fixed member list isn't a gap to
       hide — it's a namespace the host system owns, so ask for the rest of it. -->
  <div v-if="families.length" class="event-group">
    <div class="event-group-label">anything else</div>
    <p class="pane-tip fam-tip">
      These namespaces carry names from outside WhiteBox, so they can't be listed.
      Type one to add it — it works before the event has ever fired.
    </p>
    <div v-for="f in families" :key="f.prefix" class="fam-row">
      <span class="fam-prefix">{{ f.prefix }}</span>
      <InputText v-model="drafts[f.prefix]" :disabled="disabled" class="fam-input"
        :placeholder="f.module === 'crm' ? 'booking' : 'name'"
        @keyup.enter="addCustom(f.prefix)" />
      <Button label="Add" size="small" severity="secondary" outlined
        :disabled="disabled || !(drafts[f.prefix] || '').trim()" @click="addCustom(f.prefix)" />
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
/* A never-fired event is offerable but not the same claim as a busy one. */
.event-item-desc.unseen { font-style: italic; opacity: .8; }

.fam-tip { margin: 0 0 8px; }
/* flex-grow, not pixels: fixed prefix + button, one flexible input between them */
.fam-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.fam-prefix { flex: 0 0 auto; font-size: 13px; font-weight: 550; color: var(--text-strong); font-family: ui-monospace, monospace; }
.fam-input { flex: 1 1 auto; min-width: 0; }
</style>
