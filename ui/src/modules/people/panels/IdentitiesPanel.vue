<script setup lang="ts">
// This person's identities: the ones they have, and the form to add another.
//
// The two used to be apart — the list in the center pane, the "Link identity"
// form over here — which put the two halves of one job in different columns:
// you read a wrong email on the left and fixed it on the right. Now the panel
// is the whole subject, and adding is one option within it.
//
// The type field is core's strong vocabulary (server/src/passports.js's STRONG)
// plus free text, because weak and custom types are legitimate — core only
// privileges the strong four with global uniqueness, it doesn't forbid the rest.
import { ref, computed } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import AutoComplete from 'primevue/autocomplete'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { usePeopleStore } from '../stores/people'
import type { Person } from '../people'
import './panel.css'

const props = defineProps<{ person: Person | null; disabled?: boolean }>()
const store = usePeopleStore()
const confirm = useConfirm()

const identities = computed(() => props.person?.identities || [])
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—')

// Asks first: the row goes, and there's no undo button for it. What it does
// NOT destroy is the person's history, which is the part worth saying out loud
// — otherwise "remove" reads like a partial delete.
function confirmUnlink(identity: any) {
  confirm.require({
    header: 'Remove identity',
    message: `Detach ${identity.type} “${identity.value}” from this person? Their history stays; only this way of recognising them goes.`,
    icon: 'pi pi-link-slash',
    acceptProps: { label: 'Remove', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: () => store.unlinkIdentity(props.person!.id, identity.id).catch(() => {}),
  })
}

// ── add ─────────────────────────────────────────────────────────────────────

// ANY type is allowed — the field is free text and the server's schema takes
// any string. The list is a shortcut, not a menu: core's four strong types
// (which carry merge semantics) plus whatever types this person already has,
// so a custom one you used before comes back as a suggestion instead of being
// retyped.
const STRONG = ['email', 'phone', 'user', 'fingerprint']
const knownTypes = computed(() => [...new Set([...STRONG, ...identities.value.map(i => i.type)])])
const suggestions = ref<string[]>([])
const complete = (e: { query: string }) => {
  const s = e.query.trim().toLowerCase()
  suggestions.value = s ? knownTypes.value.filter(t => t.toLowerCase().includes(s)) : [...knownTypes.value]
}

const type = ref('email')
const value = ref('')
const saving = ref(false)
const error = ref('')

const dirty = computed(() => !!value.value.trim())
const canSubmit = computed(() =>
  !props.disabled && !!props.person && !!type.value.trim() && dirty.value && !saving.value)
// Nothing to revert TO — this form only ever adds — so Discard clears it back
// to blank, which is ADR rule 5's "never saved" case.
function discard() { type.value = 'email'; value.value = ''; error.value = '' }

// Strong types are globally unique on (type, value), so linking a value that
// already belongs to someone else doesn't fail — core MERGES the two passports.
// Saying so up front matters: it's a much bigger action than "add a row".
const isStrong = computed(() => STRONG.includes(type.value.trim()))

async function submit() {
  if (!canSubmit.value) return
  saving.value = true; error.value = ''
  try {
    await store.linkIdentity(props.person!.id, { type: type.value.trim(), value: value.value.trim() })
    value.value = ''
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <p v-if="!person" class="pane-tip">Open someone to see their identities.</p>
  <div v-else class="p-form">
    <ul class="plain-list closed">
      <!-- two lines rather than one: at 400px a badge, a full email, a
           timestamp and a button on one row would ellipsize the value, which
           is the only part you're actually reading -->
      <li v-for="i in identities" :key="i.id" class="ent-row">
        <div class="ent-top">
          <span class="id-badge">{{ i.type }}</span>
          <span class="id-value">{{ i.value }}</span>
          <Button v-if="!disabled" text rounded size="small" severity="secondary" aria-label="Remove identity"
            @click="confirmUnlink(i)">
            <template #icon><span class="material-symbols-outlined">close</span></template>
          </Button>
        </div>
        <span class="ent-sub">last seen {{ fmt(i.last_seen_at) }}</span>
      </li>
      <li v-if="!identities.length" class="rail-empty">Anonymous — nothing identifies this person yet.</li>
    </ul>

    <label class="fld"><span class="fld-l">Type</span>
      <AutoComplete v-model="type" :suggestions="suggestions" dropdown class="full ac"
        placeholder="any type — email, phone, loyalty_card…" :disabled="disabled" @complete="complete" />
    </label>
    <label class="fld"><span class="fld-l">Value</span>
      <InputText v-model="value" class="full" placeholder="someone@example.com" :disabled="disabled"
        @keyup.enter="submit" />
    </label>
    <p v-if="isStrong" class="fld-hint warn">
      <b>{{ type }}</b> is a strong identity — one value belongs to exactly one person. If it's already
      on someone else, the two are merged into one person.
    </p>
    <p v-else class="fld-hint">A custom type — anything is allowed. Stored against this person only, with no merge behaviour.</p>
    <p v-if="error" class="fld-hint danger">{{ error }}</p>
    <!-- "Link identity", not "Save": this doesn't commit an edit to the person,
         it attaches a new identity to them. Same reasoning as Lists' "Add new"
         — and with no section title above, the button is what names the action. -->
    <div class="b-actions">
      <span class="save-note" :class="{ 'save-note--hidden': !dirty }"><span class="material-symbols-outlined fill">circle</span> Unsaved changes</span>
      <Button label="Discard" text severity="secondary" size="small" :disabled="!dirty" @click="discard" />
      <Button label="Link identity" size="small" :loading="saving" :disabled="!canSubmit" @click="submit" />
    </div>
  </div>
</template>

<style scoped>
/* AutoComplete is a wrapper <span> around its own input — the input doesn't
   inherit the wrapper's width. Flex so it takes whatever the dropdown button
   leaves. */
.ac { display: flex; }
.ac :deep(.p-autocomplete-input) { flex: 1 1 auto; min-width: 0; }
</style>
