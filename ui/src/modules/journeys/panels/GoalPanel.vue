<script setup lang="ts">
// What this journey is FOR — the events that mean it worked, and how long
// after enrolling they still count.
//
// Same picker as the trigger, deliberately: the trigger chooses the events
// that START someone's journey, the goal chooses the ones that mean it
// SUCCEEDED. Same vocabulary, opposite ends.
//
// The window runs from each person's OWN enrolled_at, not a calendar range —
// someone who enrolled yesterday has their full window ahead of them while
// someone from last month has spent theirs. That's why it's expressed in days
// rather than as dates.
import { computed } from 'vue'
import InputText from 'primevue/inputtext'
import EventPicker from './EventPicker.vue'
import './panel.css'

const props = defineProps<{
  draft: any
  eventsRegistry: any[]
  disabled?: boolean
  empty?: boolean
}>()

const goal = computed(() => props.draft?.goal)
const events = computed<string[]>(() => goal.value?.event || [])

// Replaced wholesale rather than mutated: the module's dirty check compares a
// JSON snapshot of the draft, and a goal going from null to set has to register
// as a change.
function toggleEvent(type: string) {
  if (props.disabled) return
  const next = events.value.includes(type)
    ? events.value.filter(e => e !== type)
    : [...events.value, type]
  // no events left means no goal at all — a goal with an empty event list
  // would be a shape the server rejects and a question nobody asked
  props.draft.goal = next.length ? { event: next, window_days: goal.value?.window_days ?? null } : null
}

function setWindow(raw: string) {
  if (props.disabled || !goal.value) return
  const n = parseInt(raw, 10)
  props.draft.goal = { ...goal.value, window_days: Number.isFinite(n) && n > 0 ? n : null }
}
</script>

<template>
  <p v-if="empty" class="pane-tip">Pick or start a journey to give it a goal.</p>
  <template v-else>
    <p class="pane-tip">
      Pick what counts as success. Results then show how many enrolled people went on to do it —
      a journey with no goal still reports its enrollments, it just can't say whether they mattered.
    </p>

    <!-- no section eyebrow above the picker: the accordion header already says
         GOAL and the picker draws its own group labels (CAMPAIGNS, CRM, …), so
         a third uppercase label sat directly on top of an identical one and
         made the two levels indistinguishable -->
    <div class="goal-sec">
      <EventPicker :selected="events" :events-registry="eventsRegistry" :disabled="disabled"
        empty="No events observed yet — a goal is measured against real events, so trigger one first."
        @toggle="toggleEvent" />
    </div>

    <!-- only meaningful once something counts as success -->
    <!-- the row's own label says what the number is; "…within" above it was a
         second heading for a single field -->
    <div v-if="events.length" class="goal-sec window-sec">
      <div class="win-row">
        <div class="win-main">
          <div class="net-name">Days after enrolling</div>
          <div class="net-sub">Leave blank to count it whenever it happens, however long after.</div>
        </div>
        <div class="win-input">
          <InputText :modelValue="goal?.window_days ?? ''" :disabled="disabled" placeholder="∞"
            @update:modelValue="setWindow(String($event ?? ''))" />
          <span class="win-unit">days</span>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.goal-sec { margin-top: 12px; }
.window-sec { border-top: 1px solid var(--border); padding-top: 12px; }
.win-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; }
.win-main { flex: 1 1 auto; }
.net-name { font-size: 13px; }
.net-sub { font-size: 11px; color: var(--muted); }
.win-input { display: flex; align-items: center; gap: 6px; flex: none; }
.win-input :deep(input) { width: 56px; text-align: right; }
.win-unit { font-size: 12px; color: var(--muted); }
</style>
