<script setup lang="ts">
// Right to be forgotten. The only irreversible action in the app, so it looks
// and behaves differently from everything else:
//   · its own permission (people:erase), not people:write
//   · a typed confirmation, not just a dialog — a click can be reflexive,
//     typing the person's name can't
//   · it reports exactly which tables lost rows, so an erasure can be
//     evidenced rather than assumed
//
// It lives in a modal off the centre pane's bottom bar rather than in the
// right-pane accordion: the accordion is for the things you routinely change
// about a person, and putting "delete them forever" one click away in the same
// list of routine edits invites the reflex this whole flow exists to prevent.
import { ref, computed, watch } from 'vue'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { usePeopleStore } from './stores/people'
import { displayName, type Person } from './people'

const props = defineProps<{ visible: boolean; person?: Person | null; disabled?: boolean; bulk?: boolean }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const store = usePeopleStore()
const typed = ref('')
const erasing = ref(false)
const error = ref('')
const removed = ref<Record<string, number> | null>(null)
const erasedCount = ref<number | null>(null)
const truncated = ref(false)

const count = computed(() => store.selectionCount)
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
// `bulk` goes false the instant the erase succeeds — clearing the selection is
// part of the operation — so the title has to remember which erase this was.
// Without it a cohort receipt sits under the heading "Erase this person".
const bulkView = computed(() => props.bulk || erasedCount.value != null)

// Confirm against what the operator can actually see on screen. For one person
// that's the label the rail shows them by — for an anonymous passport
// `Anonymous · <short id>`, since "Anonymous" alone would be the same phrase
// for everybody and typing it would confirm nothing.
//
// A selection has no such label, so the phrase is the COUNT: it's specific to
// this action, it changes the moment the selection does, and it can't be typed
// without reading how many people are about to be destroyed — which is the one
// number that matters here.
const phrase = computed(() =>
  props.bulk ? `erase ${people(count.value)}` : props.person ? displayName(props.person) : '')
const matches = computed(() => typed.value.trim() === phrase.value)
const hasTarget = computed(() => (props.bulk ? count.value > 0 : !!props.person))
const canErase = computed(() => !props.disabled && hasTarget.value && matches.value && !erasing.value)
const totalRows = computed(() => Object.values(removed.value || {}).reduce((a, b) => a + b, 0))

// Reopening must never inherit a half-typed phrase or a previous receipt.
watch(() => props.visible, (open) => {
  if (open) { typed.value = ''; error.value = ''; removed.value = null; erasedCount.value = null; truncated.value = false }
})
// …and a phrase typed against "3 people" must not still validate once the
// selection is 40. The phrase is the guard; it has to be re-earned.
watch(phrase, () => { typed.value = '' })

const close = () => emit('update:visible', false)

async function erase() {
  if (!canErase.value) return
  erasing.value = true; error.value = ''
  try {
    // keep the dialog open on success — the receipt IS the outcome, and the
    // people it describes are gone from every other pane by the time it renders
    if (props.bulk) {
      const res = await store.eraseSelection()
      removed.value = res.removed
      erasedCount.value = res.erased
      truncated.value = !!res.truncated
    } else {
      removed.value = (await store.erase(props.person!.id)).removed
    }
    typed.value = ''
  } catch (e: any) {
    error.value = e.message
  } finally {
    erasing.value = false
  }
}
</script>

<template>
  <Dialog :visible="visible" modal :header="bulkView ? 'Erase these people' : 'Erase this person'"
    :style="{ width: '440px' }" @update:visible="emit('update:visible', $event)">
    <!-- the receipt outlives its subject: `person` is null and the selection is
         empty after a successful erase, so this has to render before the
         nothing-to-erase guard -->
    <template v-if="removed">
      <p class="tip">
        <template v-if="erasedCount != null">Erased <b>{{ people(erasedCount) }}</b>. </template>
        <template v-else>Erased. </template>
        <b>{{ totalRows }}</b> row{{ totalRows === 1 ? '' : 's' }} removed across
        {{ Object.keys(removed).length }} table{{ Object.keys(removed).length === 1 ? '' : 's' }}.
      </p>
      <!-- Never silent: a right-to-be-forgotten that stopped early and reported
           success would be a compliance claim that isn't true. -->
      <p v-if="truncated" class="tip warn">
        Stopped at the per-request limit — each erasure is its own transaction across every table.
        The rest are still there; select them again and run it once more.
      </p>
      <ul class="rm-list">
        <li v-for="(n, table) in removed" :key="table" class="rm-row">
          <span class="rm-table">{{ table }}</span><span class="rm-n">{{ n }}</span>
        </li>
      </ul>
    </template>

    <p v-else-if="disabled" class="tip">
      Erasing a person needs the <code>people:erase</code> permission, which is granted separately
      from editing.
    </p>

    <template v-else>
      <p class="tip">
        Removes <b>{{ bulk ? `all ${people(count)} selected` : phrase }}</b> and every row
        referencing them — identities, facts, awareness, sends, enrollments, ad signals — across
        every plugin. There is no undo. To combine duplicates, use <b>Merge</b> instead; that
        keeps the data.
      </p>
      <label class="fld"><span class="fld-l">Type <b>{{ phrase }}</b> to confirm</span>
        <InputText v-model="typed" class="full" spellcheck="false" autofocus :placeholder="phrase"
          @keyup.enter="erase" />
      </label>
      <p v-if="error" class="err">{{ error }}</p>
    </template>

    <template #footer>
      <Button :label="removed ? 'Done' : 'Cancel'" text severity="secondary" size="small" @click="close" />
      <Button v-if="!removed && !disabled" label="Erase permanently" severity="danger" size="small"
        :loading="erasing" :disabled="!canErase" @click="erase" />
    </template>
  </Dialog>
</template>

<style scoped>
.tip { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.tip.warn { color: #d97706; }
.err { margin: 8px 0 0; font-size: 12.5px; color: #dc2626; }
.rm-list { list-style: none; margin: 0; padding: 0; }
.rm-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11.5px; }
.rm-row:last-child { border-bottom: none; }
.rm-table { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.rm-n { flex: none; font-weight: 700; color: var(--text-strong); }
code { font-family: ui-monospace, monospace; font-size: 11px; }
</style>
