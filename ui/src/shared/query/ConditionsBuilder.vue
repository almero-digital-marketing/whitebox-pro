<script setup lang="ts">
// combinator + a list of ConditionRow — "match all/any of these conditions",
// with add/remove. The generic, reusable half of what used to be inlined in
// Analytics' PeopleSelector.vue; used there and by Journeys' branch-step
// "by filter" editor. `conditions`/`combinator` are mutated in place (add/
// remove push/splice the passed array directly), matching ConditionRow's
// own established "mutate the passed-in model" convention — same reason
// Vue's reactivity already requires that array to be a ref the caller owns.
// The all/any toggle is the same two-button pill Audiences.vue's rule
// builder and Journeys' own trigger-audience picker use (.b-op there) —
// namespaced .cb-op here since this component crosses module boundaries and
// a bare `.b-op` would collide with Journeys.vue's own scoped rule for its
// (unrelated) trigger-audience picker.
import Button from 'primevue/button'
import ConditionRow from './ConditionRow.vue'
import { newCondition } from './clause'
import './conditions.css'

const props = defineProps<{
  conditions: any[]
  combinator: 'all' | 'any'
  factKeys: any[]
  eventOpts: any[]
  campaignOpts?: any[]
  disabled?: boolean
  // Clauses this flat builder cannot draw — a nested all/any group, or a `not`
  // around one. Preserved on save, so the rows above are a SUBSET of what the
  // query matches, and the user has to be able to see the difference.
  //
  // Shown as JSON, not as a count and not as prose. A count says nothing. The
  // widget's AI summary describes the WHOLE query, so it cannot tell you which
  // part is the part you can't see. The clauses themselves are exact, already
  // in hand client-side, and cost nothing to render — and they are the only
  // thing here scoped to precisely what is missing.
  //
  // The all/any toggle locks, and only it: flipping the combinator would apply
  // to these too, rewriting a part of the query the user cannot edit. Editing
  // the visible rows stays safe — each row is its own clause.
  hidden?: any[]
}>()

const hiddenJson = () => JSON.stringify(props.hidden, null, 2)
defineEmits<{ 'update:combinator': [val: 'all' | 'any'] }>()

function add() { props.conditions.push(newCondition(props.factKeys[0]?.value || '')) }
function remove(i: number) { props.conditions.splice(i, 1) }
</script>

<template>
  <div class="cbx-root">
    <span class="cb-title">Conditions</span>
    <p class="cb-hint"><b>Fact</b> = a stored attribute (status, membership…). <b>Activity</b> = events they did (emails, calls, bookings…) by action and campaign.</p>
    <div class="cb-rulebar">
      <span class="cb-op">
        <button type="button" :class="{ on: combinator === 'all' }" :disabled="disabled || !!hidden?.length" @click="$emit('update:combinator', 'all')">All of these</button>
        <button type="button" :class="{ on: combinator === 'any' }" :disabled="disabled || !!hidden?.length" @click="$emit('update:combinator', 'any')">Any of these</button>
      </span>
      <Button text rounded size="small" :disabled="disabled" @click="add">
        <template #icon><span class="material-symbols-outlined">add</span></template>
      </Button>
    </div>

    <ConditionRow v-for="(c, i) in conditions" :key="i" :condition="c"
      :fact-keys="factKeys" :event-opts="eventOpts" :campaign-opts="campaignOpts" :disabled="disabled"
      @remove="remove(i)" />
    <p v-if="!conditions.length && !hidden?.length" class="cb-hint">No conditions — matches everyone.</p>
    <template v-if="hidden?.length">
      <p class="cb-hint">
        Also matching on {{ hidden.length }} grouped condition{{ hidden.length === 1 ? '' : 's' }} this builder can't draw.
        Kept as-is when you save; all/any is locked because it would apply to {{ hidden.length === 1 ? 'it' : 'them' }} too.
      </p>
      <pre class="cb-raw">{{ hiddenJson() }}</pre>
    </template>
  </div>
</template>
