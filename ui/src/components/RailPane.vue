<script setup lang="ts">
// The left rail, for every module.
//
// Search at the TOP with the module's own action inside it, the list, then a
// foot that says how many there are and which page you're on. Every module's
// rail is the same object now rather than five lookalikes — before this the
// four list-backed modules each had their own copy of a `pane-head` + list +
// bottom-pinned search, and People had drifted into a different (better) shape
// on its own.
//
// The search leads the pane because it IS how you get a list, not a filter over
// one you already have — which is also why the module's add button lives inside
// the bar rather than in a header above it: it belongs to the same job.
//
// PAGING IS ALWAYS THE SERVER'S. The module passes `total` + `page` and handles
// `update:page`; this component renders a position and reports clicks, and never
// holds or slices a list of its own.
//
// It briefly also had a client mode that took the whole list and sliced it, for
// the rails backed by tens of rows. That was a second source of truth for "how
// many are there" — the count under the rail counted what had been DOWNLOADED
// rather than what exists — and the two modes disagreed the moment a table grew.
// Every rail now goes through useRailPage(), so the mode is gone rather than
// merely unused.
import { computed } from 'vue'
import Paginator from 'primevue/paginator'
import RailSearch from './RailSearch.vue'

const props = withDefaults(defineProps<{
  q: string
  placeholder?: string
  total?: number
  page?: number
  pageSize?: number
  // what one row is called, for the count — "12 audiences", "1 journey"
  noun?: string
  nounPlural?: string
}>(), { pageSize: 25, noun: 'result' })

const emit = defineEmits<{
  (e: 'update:q', v: string): void
  (e: 'update:page', v: number): void
}>()

const page = computed(() => props.page || 0)
const total = computed(() => props.total || 0)
const plural = computed(() => props.nounPlural || `${props.noun}s`)
</script>

<template>
  <!-- RailSearch is built to pin to the BOTTOM of a rail (border-top, no
       border-bottom). Leading the pane, the border has to flip, or the divider
       sits above the search box instead of under it. -->
  <div class="rail-top">
    <RailSearch :modelValue="q" :placeholder="placeholder"
      @update:modelValue="emit('update:q', $event)">
      <template #trailing><slot name="action" /></template>
    </RailSearch>
  </div>

  <ul class="rail-list">
    <slot />
  </ul>

  <div class="rail-foot">
    <!-- for a control scoped to the whole result set rather than a row —
         People's select-all. Leads the bar because it acts on exactly the
         set the number beside it describes. -->
    <slot name="foot-lead" />
    <!-- How many the query found, opposite which page you're on: two different
         numbers, so they sit at opposite ends rather than reading as one
         run-on "1 of 2 of 49". -->
    <span class="count-pill">
      <!-- a live indicator, not decoration: grey when the query matched nobody,
           so an empty rail reads as "searched, found none" rather than
           "still loading" -->
      <i class="count-dot" :class="{ zero: !total }" />
      {{ total }} {{ q ? (total === 1 ? 'match' : 'matches') : (total === 1 ? noun : plural) }}
    </span>
    <!-- alwaysShow (the default) keeps it rendered and inert at one page: a
         pager that vanishes leaves you unsure whether the list is complete or
         silently truncated, and most searches fit one page. -->
    <Paginator :first="page * pageSize" :rows="pageSize" :totalRecords="total"
      @page="emit('update:page', $event.page)"
      template="PrevPageLink CurrentPageReport NextPageLink"
      currentPageReportTemplate="{currentPage} of {totalPages}" />
  </div>
</template>

<style scoped>
.rail-top :deep(.rail-search) { border-top: none; border-bottom: 1px solid var(--border); }

/* The list is this component's element now, so the flex/scroll rules that used
   to live in each module come with it — that's what stops one rail growing its
   parent while another scrolls. Row styling stays with the module: slot content
   is compiled in the PARENT, so a module's own `.rail-item` rules still reach
   the rows it passes in. */
.rail-list { list-style: none; margin: 0; padding: 8px 8px 16px; overflow: auto; flex: 1 1 auto; min-height: 0; }

/* 52px, matching the centre pane's bottom bar and every other pinned bar in
   the app — they sit side by side across a 1px divider, so a 4px difference
   reads as one of them being misaligned. */
.rail-foot { flex: none; height: 52px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-top: 1px solid var(--border); }
/* the flex child is PrimeVue's <nav> wrapper, not .p-paginator inside it —
   margin-left on the inner element pushes nothing */
.rail-foot > :last-child { margin-left: auto; }
/* `.count-dot` moved to style.css — two modules use it and a scoped copy meant the
   other one rendered an invisible <i>. */

/* The module's action, styled HERE rather than by each module: it's passed in
   through a slot, so five modules would otherwise each decide what "the add
   button in the search bar" looks like. A 30px square inside the 52px bar,
   bordered so it reads as its own control rather than a third glyph in the
   input — the same box People's filter button occupies. */
.rail-top :deep(.rail-action) { flex: none; width: 30px; height: 30px; min-width: 30px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: none; box-shadow: none; color: var(--muted); }
.rail-top :deep(.rail-action:not(:disabled):hover) { border-color: var(--accent); color: var(--accent); background: none; }
.rail-top :deep(.rail-action .material-symbols-outlined) { font-size: 16px; }
</style>
