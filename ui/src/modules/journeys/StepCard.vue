<script setup lang="ts">
// Custom Vue Flow node — one step in a journey's graph. Renders a kind icon +
// label + a one-line config summary; the actual per-kind editing form lives
// in the parent's right-hand inspector pane (Journeys.vue), not inline here —
// Vue Flow just needs a compact, glanceable card.
//
// The icon/label/summary all come from steps/index.ts, the one registry both
// this card and the inspector read. This file used to carry its own second
// copy of the kind map, which had already drifted from the inspector's
// ("Trigger Campaign" here vs "Campaign" there).
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { stepKind, stepMeta } from './steps'

const props = defineProps<{ id: string; data: { kind: string; config: any; label?: string }; selected?: boolean; campaignName?: string; listName?: string; enrollmentCount?: number }>()

const meta = computed(() => stepMeta(props.data.kind))
const title = computed(() => props.data.label || meta.value.label)
const summary = computed(() =>
  stepKind(props.data.kind)?.summary(props.data.config || {}, { campaignName: props.campaignName, listName: props.listName }) ?? '')
</script>

<template>
  <div class="step-card" :class="[data.kind, { selected }]">
    <span v-if="enrollmentCount" class="enroll-count" :title="`${enrollmentCount} enrollment${enrollmentCount === 1 ? '' : 's'} currently here`">{{ enrollmentCount }}</span>
    <Handle type="target" :position="Position.Top" />
    <div class="sc-head"><span class="material-symbols-outlined" :class="{ fill: meta.fill }">{{ meta.icon }}</span><span>{{ title }}</span></div>
    <div class="sc-sum" :title="summary">{{ summary }}</div>
    <template v-if="data.kind === 'branch'">
      <Handle type="source" :position="Position.Bottom" id="true" class="h-true" />
      <Handle type="source" :position="Position.Bottom" id="false" class="h-false" />
      <div class="sc-branch-labels"><span class="yes">Yes</span><span class="no">No</span></div>
    </template>
    <Handle v-else-if="data.kind !== 'exit'" type="source" :position="Position.Bottom" />
  </div>
</template>

<style scoped>
.step-card { width: 190px; border: 1.5px solid var(--border); border-radius: 10px; background: var(--panel); box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 10px 12px; cursor: pointer; }
.step-card:hover { border-color: var(--border-2); }
.step-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.step-card.exit { border-style: dashed; }
.sc-head { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--text-strong); margin-bottom: 4px; }
.sc-head .material-symbols-outlined { font-size: 12px; color: var(--accent); }
.sc-sum { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-branch-labels { position: absolute; left: 12px; right: 12px; bottom: -18px; display: flex; justify-content: space-between; font-size: 10px; font-weight: 700; pointer-events: none; }
.sc-branch-labels .yes { color: #16a34a; } .sc-branch-labels .no { color: #dc2626; }
.h-true { left: 30% !important; } .h-false { left: 70% !important; }
/* live count of enrollments currently sitting at this node — mirrors the
   Entry badge's own floating-pill positioning (top:-10px), flipped to the
   right so the two never collide on the entry node. */
.enroll-count { position: absolute; top: -10px; right: -6px; min-width: 18px; height: 18px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; background: var(--accent); border-radius: 999px; padding: 0 5px; pointer-events: none; }
</style>
