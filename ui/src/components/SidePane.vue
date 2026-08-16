<script setup lang="ts">
// THE right pane, for every module.
//
// The counterpart to RailPane on the left, and here for the same reason it is:
// seven modules each declared their own <aside>, and four of the seven width
// rules were byte-identical already (`flex: none; width: 400px; … border-left;
// background: var(--panel)`). That is seven chances to drift, and it had already
// started — the collapse behaviour had to be hand-wired into all seven, which is
// exactly how Users got missed the first time.
//
// So the pane is one component and the module passes its content:
//
//   <SidePane module="people">
//     <Accordion class="ppl-accordion pane-accordion is-content-sized"> … </Accordion>
//   </SidePane>
//
// WIDTH is a prop rather than a per-module class, because it is the only thing
// six of the seven actually disagreed about (Live wants 340). The border, the
// background and the flex column are not negotiable — a pane that decided those
// for itself is the drift this replaces.
//
// `class` still lands on the <aside> (Vue's fallthrough), so a module keeps its
// own hook for extras — `.cmp-side .rail-list` and friends go on working.
//
// GRID HOSTS: Analytics' console is a grid, so the pane's width is its parent's
// `grid-template-columns` to give, not the pane's own. `collapsed` is exposed as
// a v-model for exactly that case — the parent watches it and collapses its own
// track. Everything else (the control, hiding the content) still comes from here.
import { computed, watch } from 'vue'
import SidePaneToggle from './SidePaneToggle.vue'
import { useSidePaneCollapsed } from './useSidePaneCollapsed'

const props = withDefaults(defineProps<{
  // storage key — `wb.<module>.pane-collapsed`. Per module on purpose; see the
  // composable for why one global flag would be wrong.
  module: string
  // `null` for a pane whose host decides the width — a grid track. Anything else
  // would be a second, quieter answer to a question the track has already settled.
  width?: number | null
}>(), { width: 400 })

// The pane owns the state, because it is the thing that persists it.
const collapsed = useSidePaneCollapsed(props.module)

// `v-model:collapsed` is an optional MIRROR, not a second owner — for a host that
// has to react to the pane rather than merely contain it (a grid parent collapsing
// its own track; a canvas re-fitting itself). One owner on purpose: two writers,
// one of them persisted and one of them a fresh `ref(false)` on every mount, means
// whichever ran last wins and the remembered state is lost about half the time.
//
// `immediate` so a host is correct on FIRST render. Without it the pane restores
// itself from storage and the grid track spends a tick at the wrong width, which
// is a visible flash of a 400px column on every load.
const mirror = defineModel<boolean>('collapsed', { default: undefined })
watch(collapsed, (v) => { mirror.value = v }, { immediate: true })

// Only the flex hosts get an inline width — on a grid child it would be a
// second, quieter answer to a question the track has already settled.
const style = computed(() => (props.width ? { width: `${props.width}px` } : undefined))
</script>

<template>
  <aside class="side-pane" :class="{ 'is-collapsed': collapsed }" :style="style">
    <SidePaneToggle v-model="collapsed" />
    <slot />
  </aside>
</template>
