<script setup lang="ts">
// Trigger panel — every journey configures exactly ONE automatic trigger
// (events or audiences). Manual enrollment is a separate, always-available
// capability (POST /:id/enroll, the journeys_enroll MCP tool) with no config
// here at all — see the plugin's journeys.js / triggers.js.
//
// Dedupe lives here too, rather than in a panel of its own. It answers "may
// this passport be enrolled AGAIN?" — the same question the trigger answers
// for the first time, and meaningless without one. Splitting them made the
// pane look like two subjects when it's one: who gets enrolled, and how often.
import { computed } from 'vue'
import SelectButton from 'primevue/selectbutton'
import InputText from 'primevue/inputtext'
import PickList from '../steps/PickList.vue'
import EventPicker from './EventPicker.vue'
import './panel.css'

// `draft` is the journey's live trigger/dedupe draft and is mutated in place —
// the module's dirty-check snapshots it, so writing through is what makes the
// journey-level Save light up.
const props = defineProps<{
  draft: any
  audiences: any[]
  eventsRegistry: any[]
  eventFamilies?: any[]
  canAudiences?: boolean
  disabled?: boolean
  empty?: boolean          // no journey open — show the tip instead of the form
}>()

// Audience triggers need the audiences plugin. A journey already ON one keeps
// the option (hiding it would misrepresent a saved trigger); it's only offered
// as a new choice when audiences is actually available.
const KINDS = computed(() => {
  const onAudience = props.draft?.trigger?.kind === 'audience'
  return [
    { label: 'Events', value: 'event' },
    { label: 'Audiences', value: 'audience', disabled: !props.canAudiences && !onAudience },
  ]
})

// Switching kind rebuilds the trigger object wholesale rather than merging, so
// a journey never carries both an event list and an audience list. The
// previous kind's own values are preserved in case the user switches back.
function setKind(kind: string) {
  if (props.disabled || !kind) return
  const t = props.draft.trigger || {}
  props.draft.trigger = kind === 'event'
    ? { kind: 'event', event: t.event || [] }
    : { kind: 'audience', audience_ids: t.audience_ids || [], op: t.op || 'any' }
}

const toggle = (list: string[], v: string) => {
  const i = list.indexOf(v)
  if (i >= 0) list.splice(i, 1); else list.push(v)
}
const toggleEvent = (type: string) => { if (!props.disabled) toggle(props.draft.trigger.event, type) }
// replace rather than mutate the nested object, so the module's JSON-snapshot
// dirty check sees the change even though `draft` itself is the same ref
const toggleReenroll = () => {
  if (props.disabled) return
  props.draft.dedupe = { ...props.draft.dedupe, reenroll: !props.draft.dedupe.reenroll }
}
const toggleAudience = (id: string) => { if (!props.disabled) toggle(props.draft.trigger.audience_ids, id) }
const setOp = (op: 'any' | 'all') => { if (!props.disabled) props.draft.trigger.op = op }

</script>

<template>
  <p v-if="empty" class="pane-tip">Pick a journey on the left, or start one with +, to configure its trigger.</p>
  <template v-else>
    <div class="mode-bar">
      <SelectButton :modelValue="draft.trigger.kind" :options="KINDS" optionLabel="label" optionValue="value"
        optionDisabled="disabled" :allowEmpty="false" :disabled="disabled" @update:modelValue="setKind" />
    </div>

    <!-- above the kind branches, and outside them: dedupe applies to
         enrollment however it was triggered, including a manual one, so it
         reads as a property of the journey rather than of the event list -->
    <div class="dedupe-sec">
      <span class="event-group-label">How often one passport may enroll</span>
      <div class="net-row">
        <div class="net-main">
          <div class="net-name">Allow re-enrollment</div>
          <div class="net-sub">Otherwise a passport runs this journey at most once, ever.</div>
        </div>
        <button type="button" class="sw" :class="{ on: draft.dedupe.reenroll }" :disabled="disabled"
          aria-label="Toggle re-enrollment" @click="toggleReenroll"><i /></button>
      </div>
      <div v-if="draft.dedupe.reenroll" class="net-row">
        <div class="net-main">
          <div class="net-name">Cooldown before re-enrollment</div>
          <div class="net-sub">Wait at least this long after exiting before a passport can re-enroll. Leave blank to allow immediately.</div>
        </div>
        <div class="cooldown-input">
          <InputText v-model.number="draft.dedupe.cooldown_days" :disabled="disabled" placeholder="0" />
          <span class="cooldown-unit">days</span>
        </div>
      </div>
    </div>

    <div v-if="draft.trigger.kind === 'event'" class="trig-fields">
      <span class="event-group-label">Events that trigger this journey</span>
      <p class="pane-tip">Any journey can also be enrolled into directly via the API/MCP, regardless of its trigger.</p>
      <EventPicker :selected="draft.trigger.event" :events-registry="eventsRegistry" :event-families="eventFamilies"
        :disabled="disabled" @toggle="toggleEvent" />
    </div>

    <div v-else class="trig-fields">
      <span class="event-group-label">Audiences that trigger this journey</span>
      <div class="b-rulebar aud-rulebar">
        <span class="b-op">
          <button type="button" :class="{ on: draft.trigger.op === 'all' }" :disabled="disabled" @click="setOp('all')">Match all</button>
          <button type="button" :class="{ on: draft.trigger.op === 'any' }" :disabled="disabled" @click="setOp('any')">Match any</button>
        </span>
        <span class="b-resolve"><span class="material-symbols-outlined">refresh</span> resolved live</span>
      </div>
      <PickList icon="group" :items="audiences" :selected="draft.trigger.audience_ids" :disabled="disabled"
        empty="No audiences yet — create one in the Audiences module." @pick="toggleAudience" />
    </div>
  </template>
</template>

<style scoped>
/* matches Analytics' ComposePane.vue mode-bar's 16px gap to the content below
   (there it's 0 bottom padding + 16px top padding on the next block; here the
   accordion content has one shared padding, so it's a margin instead) */
.mode-bar { margin-bottom: 16px; }
.mode-bar :deep(.p-selectbutton) { width: 100%; }
.mode-bar :deep(.p-togglebutton) { flex: 1; }

.trig-fields { display: flex; flex-direction: column; gap: 10px; }
/* the section title sits directly in .trig-fields' own flex gap (10px) — its
   margin-bottom would stack on top of that gap, so it's zeroed here. Nested
   .event-group-labels (MAIL, SMS, …) aren't flex children of .trig-fields, so
   their margin-bottom is still the only spacing there. */
.trig-fields > .event-group-label { margin-bottom: 0; }


/* dedupe — the same divider the event groups use, so it reads as one form
   rather than a different kind of thing. It leads, so the rule goes BELOW it:
   the mode bar's own 16px already separates it from the toggle above. */
.dedupe-sec { border-bottom: 1px solid var(--border); margin-bottom: 12px; padding-bottom: 12px; }
.net-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); }
/* the section label already sits above it */
.dedupe-sec .net-row:first-of-type { border-top: none; }
.net-main { flex: 1 1 auto; }
.net-name { font-size: 13px; }
.net-sub { font-size: 11px; color: var(--muted); }
.cooldown-input { display: flex; align-items: center; gap: 6px; flex: none; }
.cooldown-input :deep(input) { width: 56px; text-align: right; }
.cooldown-unit { font-size: 12px; color: var(--muted); }

/* audience trigger's any/all switch — same shape and vocabulary as Audiences'
   own rule combinator (.b-rulebar/.b-op/.b-resolve there). .aud-rulebar needs
   its own align-self: .trig-fields is a COLUMN flex container with the default
   align-items: stretch, which — unlike Audiences' own ROW context — stretches
   a child's cross axis (width), so without this the inline-flex switch would
   span the whole pane instead of hugging its content. */
.b-rulebar { display: flex; align-items: center; gap: 12px; }
.aud-rulebar { align-self: flex-start; }
.b-op { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.b-op button { border: none; background: none; font: inherit; font-size: 12px; padding: 5px 11px; cursor: pointer; color: var(--muted); }
.b-op button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.b-op button:disabled { opacity: .5; cursor: default; }
.b-resolve { font-size: 11.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px; }
</style>
