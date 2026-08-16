<script setup lang="ts">
// People module — the only place in the app you can look a person up rather
// than arrive at them as the result of something else.
//
// Same 3-pane shape as every other module: left = search + results, center =
// the person (identities, facts, history), right = the actions that change
// them. Unlike the other modules the left rail is a SERVER search, not a
// client-side filter over a loaded list — there are hundreds of thousands of
// passports in a real deployment and no list to filter.
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
// The dialog HOST stays here (one per module) even though nothing in this file
// calls confirm() any more — IdentitiesPanel does, for unlink — and
// useConfirm() only queues; something mounted has to render it.
import FilterMenu from '../../components/FilterMenu.vue'
import SidePaneToggle from '../../components/SidePaneToggle.vue'
import { useSidePaneCollapsed } from '../../components/useSidePaneCollapsed'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import RailPane from '../../components/RailPane.vue'
import Accordion from 'primevue/accordion'
import AccordionPanel from 'primevue/accordionpanel'
import AccordionHeader from 'primevue/accordionheader'
import AccordionContent from 'primevue/accordioncontent'
import { usePeopleStore } from './stores/people'
import { useAuthStore } from '../../shell/stores/auth'
import { fullContact, displayName, SEARCH_FIELDS, type SearchField, type PersonRow } from './people'
import IdentitiesPanel from './panels/IdentitiesPanel.vue'
import FactsPanel from './panels/FactsPanel.vue'
import SegmentsPanel from './panels/SegmentsPanel.vue'
import ActivityTimeline from './ActivityTimeline.vue'
import EraseDialog from './EraseDialog.vue'
import './panels/panel.css'

// Right pane collapsed — the module owns it (see SidePaneToggle), and it is
// remembered per module across reloads (see useSidePaneCollapsed).
const paneCollapsed = useSidePaneCollapsed('people')


const route = useRoute()
const router = useRouter()
const store = usePeopleStore()
const auth = useAuthStore()
const { results, total, loading, current, includeAnonymous, q, fields,
  selectionCount, selectionRows, hasSelection, allMatching } = storeToRefs(store)

const canWrite = computed(() => auth.hasPermission('people:write'))
const canErase = computed(() => auth.hasPermission('people:erase'))

// One filter control for the whole rail. The two halves are genuinely
// different questions — where to look for the term, versus which people are
// eligible to come back at all — so they're grouped rather than run together
// in a flat list of four.
const FILTER_GROUPS = [
  { label: 'Where to look', items: SEARCH_FIELDS },
  { label: 'Results', items: [
    { value: 'anonymous', label: 'Include anonymous', hint: 'passports with no identity at all' },
  ] },
]

// The picker is one array; the store keeps the two concerns apart. Merging
// happens only here, at the control, so nothing downstream has to know that
// 'anonymous' was ever a sibling of the field names.
const filterModel = computed(() => [
  ...fields.value, ...(includeAnonymous.value ? ['anonymous'] : []),
])
function setFilter(next: string[]) {
  includeAnonymous.value = next.includes('anonymous')
  store.setFields(next.filter(v => v !== 'anonymous') as SearchField[])
}

// Names the fields while they fit rather than counting them — "Facts" tells
// you what a surprising result set means, "1 of 3" makes you open the dropdown
// to find out.
const scopeLabel = computed(() => {
  const where = fields.value.length === SEARCH_FIELDS.length
    ? 'Everywhere'
    : SEARCH_FIELDS.filter(f => fields.value.includes(f.value))
        .map(f => (f.value === 'id' ? 'ID' : f.label)).join(' + ')
  return includeAnonymous.value ? `${where} · with anonymous` : where
})
// Whether anything is narrowed from the default. The button is icon-only, so
// this is the only thing that can say so — without it a narrowed list looks
// identical to a complete one.
const filterActive = computed(() =>
  fields.value.length < SEARCH_FIELDS.length || includeAnonymous.value)
// Greys out the last remaining FIELD — anonymous is never the one holding the
// search up, so it's always free to toggle. The store refuses an empty scope,
// and a checkbox that silently ignores the click is worse than one that looks
// unavailable. See setFields().
const lastOne = (o: { value: string }) =>
  o.value !== 'anonymous' && fields.value.length === 1 && fields.value[0] === o.value

// Debounced so typing an email doesn't fire a query per keystroke — this hits
// the DB across two tables, unlike the other modules' in-memory filters.
// The scope is in here too: unchecking a box re-runs the same term against a
// narrower search, which is the whole point of the control.
let searchTimer: any
watch([q, includeAnonymous, fields], () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => store.search(), 250)
}, { deep: true })

// ── bulk selection ──────────────────────────────────────────────────────────
// The selection is a SUBJECT, not a widget: while one exists it takes over the
// centre pane and the right pane acts on all of it. That's what puts bulk
// actions in the same three-pane grammar as everything else, instead of a form
// wedged into the navigation rail.
const isPicked = (id: string) => allMatching.value || store.selected.has(id)

// A row click therefore has to mean something different while a selection is
// up: the centre is already showing the cohort, so opening someone would
// change nothing you can see. The whole rail becomes a picker instead, and the
// checkbox stops being the only 13px target on the row.
function rowClick(p: PersonRow) {
  // …except under "all matching", where the selection is a QUERY, not a set of
  // rows. There is nothing to pick off one at a time, and toggling would
  // silently collapse "all 43" into "1".
  if (allMatching.value) return
  if (hasSelection.value) return store.toggleSelected(p)
  openPerson(p.id)
}

// What the centre pane is looking at. The two scopes read differently on
// purpose — one is a set you assembled, the other is a promise about a query
// whose members the client has never seen.
const selectionTitle = computed(() => {
  if (allMatching.value) {
    return q.value
      ? `All ${total.value} people matching “${q.value}”`
      : `All ${total.value} people`
  }
  const n = selectionCount.value
  return `${n} ${n === 1 ? 'person' : 'people'} selected`
})
// Under "all matching" only the loaded page can be listed — the rest exist
// solely as a query. Shown as a sample, and said so.
const selectionList = computed<PersonRow[]>(() => (allMatching.value ? results.value : selectionRows.value))

const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
async function openPerson(id: string) {
  await store.open(id)
  if (paramStr(route.params.personId) !== id) router.replace({ name: 'people', params: { personId: id } })
}
onActivated(async () => {
  await store.search()
  store.loadLists()          // the pickable lists — short, slow-changing, fetched once
  store.loadFactKeys()       // …and the fact-key vocabulary, on the same terms
  const id = paramStr(route.params.personId)
  if (id && current.value?.id !== id) store.open(id)
})

// right-pane accordion — resets to the first panel whenever a different
// person is opened, same convention as every other module's activePanel
const activePanel = ref<'identities' | 'facts' | 'segments'>('identities')
watch(current, (p, prev) => { if (p?.id !== prev?.id) activePanel.value = 'identities' })
// The bulk accordion keeps its own open panel — same first-panel-by-default
// convention, but it starts from Facts because Identities isn't there. Sharing
// `activePanel` would have meant landing on a panel this accordion doesn't have.
const bulkPanel = ref<'facts' | 'segments'>('facts')
// Building a new cohort is a new question; reopening at whichever panel the
// last one ended on would be a leftover, the same reason `current` resets one.
watch(hasSelection, (on) => { if (on) bulkPanel.value = 'facts' })
// Deliberately NOT closing the erase dialog when the selection changes. It
// looks like the safe thing, but a successful bulk erase is itself what empties
// the selection — so closing on that transition threw away the receipt in the
// same frame it appeared, which is the one thing that must survive. The dialog
// guards itself instead: its confirmation phrase is derived from the subject,
// so a subject that changes invalidates whatever was typed. (The modal also
// blocks the rail, so the selection can't change under an open dialog by hand.)
const eraseOpen = ref(false)

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—')
// split for the rail's stacked timestamp column
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—')
const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '')
// only for the header count now — the list itself moved into FactsPanel
const factEntries = computed(() => Object.entries(current.value?.facts || {}))
</script>

<template>
  <div class="ppl-console">
    <!-- left: server-side search over identities + any fact value. Search sits
         at the TOP here, unlike the other modules' bottom-pinned rail filter —
         those filter a list you already have, this one IS how you get a list. -->
    <aside class="ppl-left">
      <!-- The same RailPane every module uses, in its SERVER-paged mode: this
           rail searches the passport table, hundreds of thousands of rows that
           have never been in the client, so `total` + `page` come from the
           store instead of handing over a list to slice. -->
      <RailPane :q="q" @update:q="q = $event" placeholder="Email, phone, any fact value, or an id"
        :total="total" :page="store.page" :page-size="store.pageSize" @update:page="store.goToPage($event)"
        noun="person" noun-plural="people">
        <template #action>
          <!-- Inside the box it modifies: the filter isn't a filter on the
               results, it's part of the query — the same term against a
               different scope is a different search.
               Icon-only, so the dot is the whole state readout: with no label
               there is otherwise nothing to say the list is narrowed. The full
               wording stays in the title, and in the panel itself. -->
          <FilterMenu mode="multi" :groups="FILTER_GROUPS"
            :modelValue="filterModel" @update:modelValue="setFilter"
            :disabled="lastOne" :active="filterActive"
            :title="scopeLabel" aria-label="Search filters" />
        </template>

        <!-- server-paged, so the rows are the store's page, not a slot slice -->
        <template #default>
          <li v-for="p in results" :key="p.id" class="rail-item two-line"
            :class="{ on: !hasSelection && current?.id === p.id, locked: allMatching }" @click="rowClick(p)">
            <!-- .stop so the row's own handler doesn't toggle it a second time.
                 Disabled under "all matching": every box is checked because the
                 QUERY includes them, not because they were picked, and unchecking
                 one can't express "everyone except this person". -->
            <input type="checkbox" class="ri-pick" :checked="isPicked(p.id)" :disabled="allMatching"
              :aria-label="`Select ${displayName(p)}`" @click.stop @change="store.toggleSelected(p)" />
            <!-- ONE identifier: the email, or the phone when there's no email.
                 An anonymous row carries its short id in the same label rather
                 than a separate style — the word "Anonymous" is the distinction,
                 and the id is what tells two of them apart. -->
            <span class="ri-name">{{ displayName(p) }}</span>
            <!-- Line two is when we last saw them, left-aligned under the
                 identifier. Always rendered — last seen exists for everyone, so
                 there's no empty-second-line case. -->
            <span class="ri-sub">
              <span class="rw-seen">{{ fmtDate(p.last_seen_at) }} <span class="rw-time">{{ fmtTime(p.last_seen_at) }}</span></span>
            </span>
          </li>
          <li v-if="!results.length && !loading" class="rail-empty">
            {{ q ? 'Nobody matches that.' : 'No identified people yet — switch on \u201Cinclude anonymous\u201D to see everyone.' }}
          </li>
        </template>

        <template #foot-lead>
          <!-- Selects the whole RESULT SET, not the page: the rail shows 25 of
               43, so a select-all reaching only the visible rows would be a
               different and much weaker promise. Indeterminate whenever a
               hand-picked subset exists, so the three states are distinguishable
               at a glance: none / some / all. -->
          <input type="checkbox" class="foot-pick" :checked="allMatching"
            :indeterminate.prop="selectionCount > 0 && !allMatching"
            :aria-label="`Select all ${total} matching`" :title="`Select all ${total} matching`"
            @change="($event.target as HTMLInputElement).checked ? store.selectAllMatching() : store.clearSelection()" />
        </template>
      </RailPane>
    </aside>

    <!-- center: everything held about this person. Structure copied from
         Campaigns' center pane — placeholder / .builder > .b-scroll > .b-head
         then .blk-head blocks. No title bar and no close button: you leave a
         person by opening another one, same as every other module. -->
    <section class="ppl-center">
      <!-- A selection outranks the open person. Two subjects can't share one
           pane, and while a cohort exists it is what the right pane is aimed
           at — showing an individual beside bulk actions would misstate what
           the buttons are about to do. `current` is untouched, so clearing the
           selection puts you back on whoever you had open. -->
      <div v-if="hasSelection" class="builder">
        <div class="b-scroll">
          <div class="b-head">
            <span class="b-name-static">{{ selectionTitle }}</span>
          </div>

          <!-- Titles and ids only. This view answers "who is in the cohort",
               not "who is this person" — identities, facts and history all
               belong to one passport and would make the list unreadable at 43
               rows without answering the question being asked.
               No block heading: the pane title two lines up already says
               "2 people selected", and this is the only block here. -->
          <div class="ppl-block">
            <p v-if="allMatching" class="pane-tip sel-scope">
              Everyone this search returns — the action re-runs the query on the server, so it
              covers people on pages you haven't opened.
              <template v-if="total > results.length">Showing the first {{ results.length }}.</template>
            </p>
            <!-- .ent-row, the same two-line row the right pane's identity and
                 fact lists use, for the same reason: the centre pane is 478px
                 and a full 36-char passport id is 238px of it, so on one line
                 the NAME is what gets ellipsized — the half you're reading. -->
            <ul class="plain-list">
              <!-- The two text lines are their own column so the × can be the
                   ROW's sibling rather than line one's. Inside .ent-top it
                   centred on the title alone and sat high against a two-line
                   row; out here it centres on the whole person. -->
              <li v-for="p in selectionList" :key="p.id" class="ent-row sel-person">
                <div class="sp-lines">
                  <!-- fullContact, not rowTitle: email AND phone, the same
                       helper the centre pane titles one person with. The rail
                       splits them across two lines because it's 350px wide;
                       here there's room for both, and a cohort you're about to
                       act on shouldn't hide half of how each member is
                       reachable. -->
                  <span class="sp-title">{{ fullContact(p) }}</span>
                  <!-- How much history each one has. A cohort you're about to
                       message reads very differently when half of it has never
                       done anything, and that's invisible from an address.
                       Undefined (not 0) means awareness isn't running at all —
                       then there's no number to state. -->
                  <span class="ent-sub">
                    <span class="sp-id">{{ p.id }}</span>
                    <span v-if="p.event_count != null" class="sp-events">
                      · {{ p.event_count }} {{ p.event_count === 1 ? 'event' : 'events' }}
                    </span>
                  </span>
                </div>
                <!-- The only place a hand-picked cohort can be pruned: its
                     members may be spread across pages the rail isn't
                     showing. Absent under "all matching" — see rowClick(). -->
                <Button v-if="!allMatching" text rounded size="small" severity="secondary"
                  :aria-label="`Remove ${fullContact(p)} from the selection`" @click="store.toggleSelected(p)">
                  <template #icon><span class="material-symbols-outlined">close</span></template>
                </Button>
              </li>
            </ul>
          </div>
        </div>
        <!-- The same bar, in the same place, as the person view's — erase is
             the one action that doesn't belong in the right pane at either
             size. Hard left, danger text, ADR rule 11.
             Clear sits at the far end rather than beside it: they're the two
             ways out of a selection, and the one that destroys data must not
             share an edge with the one that just puts it down. -->
        <div class="b-actions ppl-foot">
          <Button :label="`Erase ${selectionCount}`" text severity="danger" size="small" :disabled="!canErase"
            :title="canErase ? undefined : 'Needs the people:erase permission'"
            @click="eraseOpen = true" />
          <Button label="Clear" text severity="secondary" size="small" class="foot-clear"
            @click="store.clearSelection()" />
        </div>
      </div>

      <div v-else-if="!current" class="placeholder muted">
        <div>
          <h2>WhiteBox People</h2>
          <p>Search for someone on the left to see everything held about them.</p>
        </div>
      </div>

      <div v-else class="builder">
        <div class="b-scroll">
          <div class="b-head">
            <span class="b-name-static">{{ fullContact(current) }}</span>
            <span v-if="current.suppressed" class="badge failed">suppressed</span>
          </div>

          <!-- Identities and facts are NOT here: they live in the right pane
               alongside the forms that change them, because reading a wrong
               email and fixing it is one job, and it was split across two
               columns. What stays in the center is what you can only read —
               history this UI doesn't edit. -->
          <div class="ppl-block">
            <div class="blk-head">Passport</div>
            <p class="pane-tip">
              <code>{{ current.id }}</code> · first seen {{ fmt(current.created_at) }} · last seen {{ fmt(current.last_seen_at) }}
              <!-- How many times they came BACK. `last_seen_at` says they were here;
                   this says whether it was their first visit or their ninth, which
                   nothing else on this record answered. `!= null` rather than a
                   truthy test: 0 sessions is a real state (a passport minted by an
                   identify with no visit yet), and null means core can't answer. -->
              <template v-if="current.sessions != null">
                · {{ current.sessions }} {{ current.sessions === 1 ? 'session' : 'sessions' }}
              </template>
            </p>
          </div>

          <!-- A block only exists when it has rows. `enrollments` is null when
               the journeys plugin isn't registered and [] when it is but this
               person has none — both render nothing, so one length check covers
               the two without needing to tell them apart. -->
          <div v-if="current.enrollments?.length" class="ppl-block">
            <div class="blk-head">Journeys</div>
            <ul class="plain-list">
              <li v-for="e in current.enrollments" :key="e.id" class="enr-row">
                <span class="enr-name">{{ e.journey_name || e.journey_id }}</span>
                <span class="badge sm" :class="e.status">{{ e.status }}</span>
                <span class="enr-when">{{ fmt(e.enrolled_at) }}</span>
              </li>
            </ul>
          </div>

          <!-- the timeline owns its own block: it has a filter row in the head
               and paging at the foot, both of which drive the store -->
          <ActivityTimeline v-if="store.activity.length || store.activityDirections.length" />
        </div>
        <!-- Erase lives here, not in the right-pane accordion: that accordion is
             the list of things you routinely change about a person, and
             "delete them forever" sitting in it invites exactly the reflex the
             typed confirmation exists to prevent. ADR rule 11 — the negative
             action goes hard left in a centre bottom bar. -->
        <div class="b-actions ppl-foot">
          <Button label="Erase" text severity="danger" size="small" :disabled="!canErase"
            :title="canErase ? undefined : 'Needs the people:erase permission'"
            @click="eraseOpen = true" />
        </div>
      </div>
    </section>

    <!-- right: the things you can change about whatever the centre is showing —
         one person, or the whole selection -->
    <aside class="ppl-side side-pane" :class="{ 'is-collapsed': paneCollapsed }">
      <SidePaneToggle v-model="paneCollapsed" />
      <!-- The SAME panels, in the same order, with `bulk` swapping their target
           from one person to the whole selection. Not lookalikes: adding to a
           list and recording a fact are the same acts at either size, and two
           implementations of each would be two places to drift.
           Identities is the one that's absent, and not for room: an identity
           belongs to exactly one person by definition, so linking one to 43
           people is a contradiction rather than a slower convenience. -->
      <Accordion v-if="hasSelection" v-model:value="bulkPanel" class="ppl-accordion pane-accordion is-content-sized">
        <AccordionPanel value="facts">
          <AccordionHeader><span class="acc-title">Facts <span class="count-pill sm">{{ selectionCount }}</span></span></AccordionHeader>
          <AccordionContent>
            <FactsPanel bulk :disabled="!canWrite" />
          </AccordionContent>
        </AccordionPanel>
        <AccordionPanel value="segments">
          <AccordionHeader><span class="acc-title">Lists <span class="count-pill sm">{{ selectionCount }}</span></span></AccordionHeader>
          <AccordionContent>
            <SegmentsPanel bulk :disabled="!canWrite" />
          </AccordionContent>
        </AccordionPanel>
      </Accordion>

      <Accordion v-else v-model:value="activePanel" class="ppl-accordion pane-accordion is-content-sized">
        <!-- Named for the SUBJECT, not the verb: each panel is everything
             about one kind of data, with adding as one option inside it. The
             count is on the header so a collapsed panel still tells you
             whether there's anything in there. -->
        <AccordionPanel value="identities">
          <AccordionHeader><span class="acc-title">Identities <span class="count-pill sm">{{ current?.identities.length ?? 0 }}</span></span></AccordionHeader>
          <AccordionContent>
            <IdentitiesPanel :person="current" :disabled="!canWrite" />
          </AccordionContent>
        </AccordionPanel>
        <AccordionPanel value="facts">
          <AccordionHeader><span class="acc-title">Facts <span class="count-pill sm">{{ factEntries.length }}</span></span></AccordionHeader>
          <AccordionContent>
            <FactsPanel :person="current" :disabled="!canWrite" />
          </AccordionContent>
        </AccordionPanel>
        <AccordionPanel value="segments">
          <AccordionHeader><span class="acc-title">Lists <span class="count-pill sm">{{ current?.segments?.length ?? 0 }}</span></span></AccordionHeader>
          <AccordionContent>
            <SegmentsPanel :person="current" :disabled="!canWrite" />
          </AccordionContent>
        </AccordionPanel>
      </Accordion>
    </aside>
    <ConfirmDialog />
    <EraseDialog v-model:visible="eraseOpen" :person="current" :bulk="hasSelection" :disabled="!canErase" />
  </div>
</template>

<style scoped>
.ppl-console { display: flex; height: 100%; min-height: 0; }
.ppl-left { flex: none; width: 350px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.ppl-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.ppl-side { flex: none; width: 400px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); }
/* Center-pane chrome — copied from Campaigns.vue (.placeholder / .builder /
   .b-head / .b-name-static / .blk-head), so this module's detail view is the
   same object as every other module's rather than a lookalike. */
.placeholder { display: grid; place-items: center; height: 100%; text-align: center; }
.placeholder h2 { margin: 0 0 6px; color: var(--text); }
.builder { width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.b-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
/* Campaigns' title is an <input> (.b-name) — 16px in a 6px/10px padded box
   with a transparent border, pulled back by -10px so the text still starts on
   the pane's left edge. A person can't be renamed, so this is static text,
   but it copies that box exactly — including single-line-with-ellipsis, since
   an input never wraps: a long email on a narrow centre pane would otherwise
   make this header 52px where every other module's is 33px. */
.b-name-static { flex: 1 1 auto; min-width: 0; box-sizing: border-box; margin: 0 0 0 -10px; padding: 6px 10px; border: 1px solid transparent; font-size: 20px; line-height: 24px; font-weight: 650; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* `.b-actions` in this module is the right-pane variant (border-top + 16/14
   margins). A centre bottom bar is a fixed 52px strip instead — the same values
   Campaigns and Journeys use — so this pulls those three properties back. */
.ppl-foot { flex: none; height: 52px; box-sizing: border-box; margin-top: 0; padding: 0 16px; }
/* Pushed to the far edge by its own rule, not `:last-child` — the person view's
   bar holds Erase alone, and a last-child rule would shove THAT to the right. */
.foot-clear { margin-left: auto; }

/* the house center-pane scroll container — same rule as Users/Campaigns/
   Audiences, including the min-height:0 that lets a flex child actually
   scroll instead of growing its parent */
.b-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 9px 16px 22px; display: flex; flex-direction: column; }

.ph-count { font-size: 11px; font-weight: 600; letter-spacing: 0; color: var(--muted); }

/* the grid itself is `.two-line` in style.css, shared with Journeys'
   enrollments; this keeps only the chrome that's this rail's own */
/* A real first column, so the shared .two-line areas (name 1/1, sub 2/1) shift
   one to the right. Overriding here rather than in .two-line itself: that grid
   is shared with Journeys' enrollments, which has no checkbox.
   Always visible, never hover-revealed — a bulk control that only appears once
   you happen to point at a row is one nobody discovers.
   justify-self, or the grid stretches it: a native checkbox is a replaced
   element and will happily fill its column. */
.rail-item.two-line { grid-template-columns: auto 1fr; }
.ri-pick { grid-area: 1 / 1 / span 2 / span 1; align-self: center; justify-self: start; margin: 0 2px 0 0; accent-color: var(--accent); cursor: pointer; }
/* "all matching" is a query, not a set of rows — there's nothing here to
   toggle, and the pointer shouldn't promise otherwise. See rowClick(). */
.rail-item.locked, .ri-pick:disabled { cursor: default; }
.rail-item.locked:hover { background: none; }
.rail-item .ri-name { grid-area: 1 / 2; }
.rail-item .ri-sub { grid-area: 2 / 2; }
/* No background for a bulk-picked row: the accent fill means "this is the one
   open in the centre pane" (.on), and giving selection the same fill made two
   different states indistinguishable. The checked box is the selection marker. */

/* The select-all and the count read as one unit — the box acts on exactly the
   set the number describes — so they sit together at the left and the pager is
   pushed to the far edge, rather than space-between stranding the count in the
   middle of the bar. */
.foot-pick { margin: 0 2px 0 0; accent-color: var(--accent); cursor: pointer; flex: none; }

/* No `margin-left: auto` any more. It pushed the timestamp to the right edge
   when it shared line two with the other contact; alone on the line, that left
   it floating away from the identifier it belongs to. */
.rw-seen { flex: none; font-variant-numeric: tabular-nums; }
.rw-seen .rw-time { opacity: .75; }

/* ── the selection as a centre-pane subject ──────────────────────────────
   Rows are the shared .ent-row; only the two spans inside it are this view's
   own. The × sits on line one, so the title is what flexes. */
.sel-scope { margin-bottom: 10px; }
/* .ent-row is a COLUMN (title over sub); this variant turns the row itself
   back into a centred flex row, with the two text lines stacked inside
   .sp-lines. That's what lets the × centre against both lines instead of
   against the title alone. */
.sel-person { flex-direction: row; align-items: center; gap: 10px; }
.sp-lines { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sel-person > .p-button { flex: none; }
.sp-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-strong); }
/* monospace, like every other place this app prints a raw id */
.sp-id { font-family: ui-monospace, monospace; }
.sp-events { white-space: nowrap; }

.rail-item { position: relative; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
/* Both columns are pinned to the same two-line grid — 16px then 14px. Left is
   13.5px/11px text and right is 11px/11px, so with `normal` leading their line
   boxes differed and the two halves of a row sat at different heights. */
/* nothing on line two: the name centres across both rows instead of sitting
   above an empty one */



/* 32px to the pixel, matching .p-paginator in style.css — the two sit side by
   side in the rail foot, so any difference reads as one of them being wrong. */
/* the accordion-header variant is NOT 32px — it sits beside a 12px eyebrow
   label, where a full-height pill would tower over the word it counts */

/* real pages, not append-on-scroll: the result set is the whole passport
   table, and "load more" gives no sense of position or a way back */
/* The filter button lives in components/FilterMenu.vue now — the app's one
   filter control, shared with Live's feed. The MultiSelect-stripped-to-a-square
   styles that used to be here are gone with it; keeping a local copy is how the
   two controls drifted apart. */


.enr-row, .act-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.enr-when, .act-when { flex: none; font-size: 11px; color: var(--muted); }
.enr-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act-chan { flex: none; font-weight: 600; }
.act-src { flex: 1 1 auto; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* same accordion treatment as Journeys' right pane */
/* `0 1 auto`, not `1 1 auto`: an open panel sizes to its content and may
   SHRINK (scrolling inside itself) when it's taller than the pane — but it no
   longer GROWS to fill it. Lists with one pill was leaving ~480px of empty
   panel below the last row. The slack now falls at the foot of the pane,
   under the collapsed headers, where it reads as pane, not as panel. */
/* ONE scroller, not two. `.p-accordioncontent-wrapper` and
   `.p-accordioncontent-content` both had `overflow: auto`, so each drew its own
   scrollbar and the inner one's width came off the padded box — leaving the
   panel's rows inset 19px on the left and 33px on the right.
   The wrapper is the scroller (it has no padding of its own) and
   `scrollbar-gutter: stable both-edges` keeps the two sides equal: on a classic
   scrollbar it reserves the same strip on each edge, and on an overlay
   scrollbar it reserves nothing, so both platforms stay symmetric. */
/* The open panel scrolls INSIDE itself — copied from .jrn-accordion, which
   already solved this. Without it a person with several identities pushes the
   form's Discard/Save straight through the MERGE header below. */
/* No scrollbar-gutter here. Reserving a gutter squares up the two sides but
   pushes the content inset from 18px to ~34px, which no other module's
   accordion does — conformity with them matters more than the few px of
   asymmetry a classic scrollbar adds, and on overlay scrollbars (the usual
   case) there is no asymmetry to fix. */
/* Grows to fill a short panel, but NEVER shrinks: it's the flex child of the
   scroller above, so `flex-shrink: 1` + `min-height: 0` let its box collapse to
   the visible height while its rows overflowed past the bottom edge. The box's
   own padding is drawn at that collapsed edge, so scrolling to the end put the
   last button flush against the panel bottom with the 16px stranded mid-list. */
</style>
