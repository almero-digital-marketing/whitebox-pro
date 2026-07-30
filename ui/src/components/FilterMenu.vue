<script setup lang="ts">
// THE filter control. One button, one panel, one set of styles — used by every
// module that narrows a list.
//
// It exists because there were two: People styled a PrimeVue MultiSelect down to
// a 30px square with its own overlay classes, and Live built an icon button plus
// a Popover with its own row markup. Same job, same intended look, two
// implementations — so they drifted on every axis nothing enforced (icon size,
// row padding, group heading tier, where "active" is expressed), and every fix
// had to be made twice or, more often, once.
//
// TWO MODES, because the two real requirements genuinely differ and a component
// that only did the simpler one would leave the other building its own again:
//
//   mode="multi"  Binary. `modelValue` is the array of selected values — the same
//                 shape MultiSelect used, so adopting this is a swap, not a
//                 rewrite. `disabled` supports "you can't uncheck the last one":
//                 a checkbox that silently ignores a click is worse than one that
//                 looks unavailable.
//
//   mode="tri"    neutral → only → exclude → neutral. Needed wherever a list has
//                 one chatty member: "everything except adnetwork" can't be
//                 expressed by including the other five, and that breaks the
//                 moment a sixth appears. Emits `toggle` and lets the host own
//                 the cycling, because the host also owns what the states MEAN.
//
// Icon-only in both modes on purpose: the panel can be long, and a label that
// grew with the selection would shove everything beside it around. The dot says
// "narrowed"; `title` says how, in words.
import { ref } from 'vue'
import Popover from 'primevue/popover'

export interface FilterItem {
  value: string
  label: string
  hint?: string
  /** Right-aligned. Omit where a count would be meaningless. */
  count?: number
}
export interface FilterGroup {
  label: string
  items: FilterItem[]
}

const props = withDefaults(defineProps<{
  groups: FilterGroup[]
  mode?: 'multi' | 'tri'
  /** mode="multi": the selected values. */
  modelValue?: string[]
  /** mode="tri": value → state. A plain object rather than a Map, so Vue's prop
   *  diffing sees a change when the host replaces it. */
  modes?: Record<string, 'include' | 'exclude'>
  /** Whether anything is narrowed from the default — drives the dot. */
  active?: boolean
  /** Human summary of the current filter, for the button's tooltip. */
  title?: string
  /** mode="multi": grey out an item that must not be unchecked. */
  disabled?: (item: FilterItem) => boolean
  /** Show a clear action at the foot of the panel. */
  clearable?: boolean
  /** One line explaining the interaction, shown above the groups. */
  hint?: string
  ariaLabel?: string
}>(), {
  mode: 'multi',
  modelValue: () => [],
  modes: () => ({}),
  active: false,
  title: 'Filter',
  clearable: false,
  ariaLabel: 'Filter',
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: string[]): void
  (e: 'toggle', value: string): void
  (e: 'clear'): void
}>()

const panel = ref<any>(null)

const stateOf = (value: string) => props.modes?.[value]
const isOn = (value: string) =>
  props.mode === 'tri' ? stateOf(value) === 'include' : props.modelValue.includes(value)
const isOff = (value: string) => props.mode === 'tri' && stateOf(value) === 'exclude'

// The mark carries the state as well as colour does — three states can't be told
// apart by shading alone, and colour on its own is never the only signal.
const markOf = (value: string) => (isOn(value) ? '✓' : isOff(value) ? '−' : '')

function rowTitle(item: FilterItem) {
  if (props.mode !== 'tri') return item.hint || item.label
  const s = stateOf(item.value)
  return s === 'include' ? `Only ${item.label} — click to exclude it`
    : s === 'exclude' ? `Excluding ${item.label} — click to clear`
    : `Click to show only ${item.label}`
}

function click(item: FilterItem) {
  if (props.disabled?.(item)) return
  if (props.mode === 'tri') { emit('toggle', item.value); return }
  const next = props.modelValue.includes(item.value)
    ? props.modelValue.filter(v => v !== item.value)
    : [...props.modelValue, item.value]
  emit('update:modelValue', next)
}
</script>

<template>
  <button type="button" class="fm-btn" :class="{ on: active }"
    :title="title" :aria-label="ariaLabel" @click="panel?.toggle($event)">
    <span class="material-symbols-outlined">filter_alt</span>
    <i v-if="active" class="fm-dot" />
  </button>

  <Popover ref="panel" appendTo="body">
    <div class="fm">
      <p v-if="hint" class="fm-hint">{{ hint }}</p>

      <template v-for="g in groups" :key="g.label">
        <div class="fm-group">{{ g.label }}</div>
        <button v-for="item in g.items" :key="item.value" type="button" class="fm-row"
          :class="{ on: isOn(item.value), off: isOff(item.value), disabled: disabled?.(item) }"
          :aria-pressed="isOn(item.value)" :disabled="disabled?.(item)"
          :title="rowTitle(item)" @click="click(item)">
          <span class="fm-mark">{{ markOf(item.value) }}</span>
          <span class="fm-k">
            <b>{{ item.label }}</b>
            <small v-if="item.hint">{{ item.hint }}</small>
          </span>
          <span v-if="item.count !== undefined" class="fm-n">{{ item.count }}</span>
        </button>
      </template>

      <button v-if="clearable && active" type="button" class="fm-clear" @click="emit('clear')">
        <slot name="clear">Clear filters</slot>
      </button>
    </div>
  </Popover>
</template>

<style scoped>
/* The button: the app's shared 30px square (same geometry as .icon-btn in
   style.css and People's old .filter-btn), declared here so it can't drift from
   the panel it opens. 15px glyph — the value People settled on; .icon-btn's
   global 16px is for standalone actions like pause, not for this. */
.fm-btn {
  flex: none; width: 30px; height: 30px; min-width: 30px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; position: relative;
  border: 1px solid var(--border); border-radius: 8px; background: none; box-shadow: none;
  color: var(--muted); cursor: pointer; font: inherit;
}
.fm-btn:hover { border-color: var(--accent); color: var(--accent); }
.fm-btn.on { border-color: var(--accent); color: var(--accent); }
.fm-btn .material-symbols-outlined { font-size: 15px; }
/* "There is something behind this button" — the whole state readout on an
   icon-only control. */
.fm-dot { position: absolute; top: -1px; right: -3px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

.fm { min-width: 224px; }
.fm-hint { margin: 0 0 8px; font-size: 10.5px; line-height: 1.45; color: var(--muted); }
.fm-hint b { font-weight: 600; color: var(--text); }

/* Group headings use the app's secondary tier (People's .sub-title): 11px/700,
   .04em, uppercase, --text-strong. */
.fm-group { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--text-strong); margin: 10px 0 4px; }
.fm-group:first-of-type { margin-top: 0; }

/* Rows follow the board's control typography (11.5px, --muted at rest, 600 when
   selected) — the convention set by .lv-win and shared with every switch. */
.fm-row { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: start; gap: 7px;
  width: 100%; border: none; background: none; padding: 5px 6px; margin: 0; border-radius: 6px;
  font: inherit; font-size: 11.5px; color: var(--muted); cursor: pointer; text-align: left; }
.fm-row:hover:not(.disabled) { background: var(--panel-2); }
.fm-row.on { color: var(--accent); }
.fm-row.on .fm-k b { font-weight: 600; }
.fm-row.off .fm-k b { text-decoration: line-through; }
.fm-row.disabled { opacity: .45; cursor: default; }

.fm-mark { font-weight: 700; text-align: center; line-height: 1.5; }
.fm-k { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.fm-k b { font-weight: 400; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-k small { font-size: 10.5px; color: var(--muted); line-height: 1.35; }
.fm-n { color: var(--muted); font-variant-numeric: tabular-nums; opacity: .7; line-height: 1.5; }

.fm-clear { display: block; width: 100%; margin-top: 10px; padding-top: 8px;
  border: none; border-top: 1px solid var(--border); background: none;
  font: inherit; font-size: 11.5px; color: var(--accent); cursor: pointer; text-align: left; }
</style>
