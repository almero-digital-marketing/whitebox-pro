<script setup lang="ts">
// Collapse control for a module's RIGHT pane.
//
// Every module's right pane is 340–400px of permanently-reserved width, which is
// the right default (it is where the open record's detail lives) and the wrong
// one whenever the centre is the thing you're actually reading — a journey
// canvas, a live feed, an audience preview. This gives that width back without
// navigating away, and hands it straight back on the next click.
//
// It is a PLAIN <button>, not PrimeVue's, because the look it has to match is a
// 30px bordered square and PrimeVue's Button brings a theme's padding, focus ring
// and background to argue with first. See side-pane.css for the look, and the
// note there about its twin in RailPane.
//
// The collapsed state belongs to the MODULE, not to this component: the pane it
// controls is the module's element, and a module that reset the pane on every
// re-render would be a surprise this component could not see. `defineModel`
// keeps that ownership explicit.
const collapsed = defineModel<boolean>({ required: true })

// One control, two directions — a separate "expand" affordance elsewhere would
// be a second thing to find, and there is nowhere to put it once the pane is
// 44px wide.
const label = () => (collapsed.value ? 'Expand panel' : 'Collapse panel')
</script>

<template>
  <!-- `title` as well as `aria-label`: collapsed, the glyph is the only thing
       left in the pane, so a pointer user gets no other clue what it does. -->
  <button
    type="button"
    class="side-pane-toggle"
    :aria-label="label()"
    :title="label()"
    :aria-expanded="!collapsed"
    @click="collapsed = !collapsed"
  >
    <span class="material-symbols-outlined">{{ collapsed ? 'left_panel_open' : 'right_panel_close' }}</span>
  </button>
</template>
