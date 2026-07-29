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
}>()
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
        <button type="button" :class="{ on: combinator === 'all' }" :disabled="disabled" @click="$emit('update:combinator', 'all')">All of these</button>
        <button type="button" :class="{ on: combinator === 'any' }" :disabled="disabled" @click="$emit('update:combinator', 'any')">Any of these</button>
      </span>
      <Button text rounded size="small" :disabled="disabled" @click="add">
        <template #icon><span class="material-symbols-outlined">add</span></template>
      </Button>
    </div>

    <ConditionRow v-for="(c, i) in conditions" :key="i" :condition="c"
      :fact-keys="factKeys" :event-opts="eventOpts" :campaign-opts="campaignOpts" :disabled="disabled"
      @remove="remove(i)" />
    <p v-if="!conditions.length" class="cb-hint">No conditions — matches everyone.</p>
  </div>
</template>
