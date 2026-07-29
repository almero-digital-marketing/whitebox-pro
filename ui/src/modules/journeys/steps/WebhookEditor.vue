<script setup lang="ts">
// Webhook step — deliver this enrollment's event to an external URL.
//
// Modelled on n8n's HTTP Request node (method picker, toggle-revealed Headers
// and Body sections) but NOT a copy of it: n8n's node is a general-purpose
// HTTP client, this one is a journey notification with a fixed envelope. Two
// places that shows:
//   · there is no "Send Body" toggle — the executor ALWAYS sends the journey
//     event, and config.payload is merged on top of it. A toggle would imply
//     you can turn the body off, which you can't.
//   · the body section disables itself for GET/HEAD instead of letting you
//     type a payload that the sender would drop on the floor.
import { computed, ref, watch } from 'vue'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import './step-editor.css'
import type { StepEditorProps } from './index'

const props = defineProps<StepEditorProps>()

// Mirrors the journeys plugin's webhook schema enum, which in turn mirrors what
// core's sender can deliver — keep the three in step.
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => ({ label: m, value: m }))
// same rule as server/src/webhooks.js's BODYLESS
const BODYLESS = ['GET', 'HEAD']
const sendsBody = computed(() => !BODYLESS.includes(props.config.method || 'POST'))

// The keys the executor always puts in the body (runWebhook) — worth showing,
// since `payload` merges ON TOP of them and can therefore override one.
const ENVELOPE = 'type, journey_id, journey_name, enrollment_id, passport_id, step_id, reached_at, context'

// ── headers: an object on the wire, rows in the UI ──────────────────────────
// config.headers is a plain {name: value} record. Editing it as rows rather
// than raw JSON means a half-typed header name can't make the whole object
// unparseable, so the draft is always valid and Save is never blocked by a
// transient keystroke.
const headerRows = ref<{ k: string; v: string }[]>(
  Object.entries(props.config.headers || {}).map(([k, v]) => ({ k, v: String(v) })),
)
const showHeaders = ref(headerRows.value.length > 0)
// Rows → object on every edit. Nameless rows are dropped rather than written
// as "": a row you're still typing shouldn't appear on the wire.
watch(headerRows, (rows) => {
  const obj: Record<string, string> = {}
  for (const r of rows) if (r.k.trim()) obj[r.k.trim()] = r.v
  if (Object.keys(obj).length) props.config.headers = obj
  else delete props.config.headers
}, { deep: true })
watch(showHeaders, (on) => { if (!on) { headerRows.value = []; delete props.config.headers } })
const addHeader = () => headerRows.value.push({ k: '', v: '' })
const removeHeader = (i: number) => headerRows.value.splice(i, 1)

// ── extra body fields: JSON text ────────────────────────────────────────────
// Held as text, not as the parsed object, so invalid JSON mid-typing stays on
// screen to be fixed instead of being thrown away. Only a successful parse
// writes through to the config, and `payloadError` reports the rest.
const payloadText = ref(props.config.payload ? JSON.stringify(props.config.payload, null, 2) : '')
const showPayload = ref(!!props.config.payload)
const payloadError = ref('')
watch(payloadText, (txt) => {
  const t = txt.trim()
  if (!t) { payloadError.value = ''; delete props.config.payload; return }
  try {
    const parsed = JSON.parse(t)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      payloadError.value = 'Must be a JSON object — its fields merge into the event.'
      return
    }
    payloadError.value = ''
    props.config.payload = parsed
  } catch (e: any) {
    payloadError.value = e.message
  }
})
watch(showPayload, (on) => { if (!on) { payloadText.value = ''; payloadError.value = '' } })
</script>

<template>
  <label class="fld"><span class="fld-l">URL</span>
    <InputText v-model="config.url" class="full" placeholder="https://…" :disabled="disabled" />
    <p class="fld-hint">A query string here is sent as-is — <code>?token=abc</code> works.</p>
  </label>

  <label class="fld"><span class="fld-l">Method</span>
    <Select v-model="config.method" :options="METHODS" optionLabel="label" optionValue="value" class="full" :disabled="disabled" />
  </label>

  <div class="wh-section">
    <div class="wh-head">
      <span class="fld-l">Headers</span>
      <button type="button" class="sw" :class="{ on: showHeaders }" :disabled="disabled"
        aria-label="Send custom headers" @click="showHeaders = !showHeaders"><i /></button>
    </div>
    <template v-if="showHeaders">
      <div v-for="(h, i) in headerRows" :key="i" class="wh-row">
        <InputText v-model="h.k" class="wh-k" placeholder="X-My-Header" :disabled="disabled" />
        <InputText v-model="h.v" class="wh-v" placeholder="value" :disabled="disabled" />
        <Button text rounded size="small" severity="secondary" :disabled="disabled" @click="removeHeader(i)">
          <template #icon><span class="material-symbols-outlined">close</span></template>
        </Button>
      </div>
      <Button label="Add header" size="small" class="wh-add" :disabled="disabled" @click="addHeader">
        <template #icon><span class="material-symbols-outlined">add</span></template>
      </Button>
      <p class="fld-hint">Content-Type is set automatically. A signing secret adds its own headers.</p>
    </template>
  </div>

  <div class="wh-section">
    <div class="wh-head">
      <span class="fld-l">Extra body fields</span>
      <button type="button" class="sw" :class="{ on: showPayload }" :disabled="disabled || !sendsBody"
        aria-label="Add extra body fields" @click="showPayload = !showPayload"><i /></button>
    </div>
    <p v-if="!sendsBody" class="fld-hint">{{ config.method }} is sent without a body, so there's nothing to add to.</p>
    <template v-else-if="showPayload">
      <Textarea v-model="payloadText" rows="5" autoResize class="full wh-json" spellcheck="false"
        placeholder='{ "source": "loyalty-flow" }' :disabled="disabled" />
      <p v-if="payloadError" class="fld-hint wh-err">{{ payloadError }}</p>
      <p v-else class="fld-hint">Merged into the event, which already carries <code>{{ ENVELOPE }}</code>. Reusing one of those names overrides it.</p>
    </template>
    <p v-else class="fld-hint">Sends the journey event on its own: <code>{{ ENVELOPE }}</code>.</p>
  </div>

  <label class="fld"><span class="fld-l">Secret override (optional)</span>
    <InputText v-model="config.secret" class="full" type="password" :disabled="disabled" />
    <p class="fld-hint">HMAC-signs the body so the receiver can verify it. Falls back to the configured default.</p>
  </label>
</template>

<style scoped>
/* a toggle-revealed group, matching the Dedupe panel's row rhythm */
.wh-section { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.wh-head { display: flex; align-items: center; gap: 10px; }
.wh-head .fld-l { flex: 1 1 auto; }
/* key + value + a fixed remove button: the two inputs share the slack, the
   button never shrinks (ADR 0001 rule 9) */
.wh-row { display: flex; align-items: center; gap: 6px; }
.wh-k { flex: 1 1 40%; min-width: 0; }
.wh-v { flex: 1 1 60%; min-width: 0; }
.wh-row > .p-button { flex: none; }
/* .wh-section is a COLUMN flex container, so the default align-items: stretch
   would blow a lone button out to the full pane width — it sizes to its own
   label instead. */
.wh-add { align-self: flex-start; }
.wh-json { font-family: ui-monospace, monospace; font-size: 12px; }
.wh-err { color: #dc2626; }
code { font-family: ui-monospace, monospace; font-size: 10.5px; }
</style>
