// The step-kind registry — one entry per kind of node a journey can contain.
//
// Everything the app needs to know about a step kind lives here: how it looks
// on the canvas (icon/label/summary), what a fresh one contains
// (defaultConfig), and which component edits it. Before this, the same six
// kinds were enumerated in four separate places — Journeys.vue's KIND_META,
// its DEFAULT_CONFIG, its v-else-if chain of inline editor markup, and
// StepCard.vue's own second copy of the icon/label map, which had already
// drifted ("Campaign" vs "Trigger Campaign"). Adding a seventh kind is now one
// component file plus one entry below, and nothing can be half-added.
//
// The backend's own list is server-plugin-journeys/src/journeys.js's StepConfig
// schema; these keys must match its node kinds.
import type { Component } from 'vue'
import TriggerCampaignEditor from './TriggerCampaignEditor.vue'
import WaitEditor from './WaitEditor.vue'
import BranchEditor from './BranchEditor.vue'
import SetFactEditor from './SetFactEditor.vue'
import AddToListEditor from './AddToListEditor.vue'
import WebhookEditor from './WebhookEditor.vue'
import ExitEditor from './ExitEditor.vue'

// The vocabulary the inspector pane hands every editor — the lists a step may
// need to reference but doesn't own. Passed as one object so all editors share
// a single prop signature and the pane can render them via <component :is>.
export interface StepVocab {
  audiences: any[]
  // static-list segments only — the Add to List step's targets. Query segments
  // recompute their membership, so they can't be added to (see the editor).
  lists: any[]
  campaigns: any[]
  // is the audiences plugin deployed AND readable by this user? Both answers
  // want the same UI, so they collapse into one flag (see Journeys.vue).
  canAudiences: boolean
  // factKeyOptions() rows: label/value for the pickers, plus the schema's
  // discovered stats (type/values/bounds/counts) so Branch and Set Fact can
  // describe the same fact identically — one shape, no second raw copy.
  factKeys: any[]
  eventOpts: { label: string; value: string }[]
  campaignOpts: { label: string; value: string }[]
}

// Every editor takes the same three props. `config` is the live step draft's
// config object and is mutated IN PLACE — that object is what the pane's
// dirty-check compares against the saved node, so writing through it is what
// makes Save light up.
export interface StepEditorProps {
  config: any
  vocab: StepVocab
  disabled?: boolean
}

export interface StepKind {
  icon: string
  label: string
  description: string
  fill?: boolean                              // a filled rather than outlined icon
  defaultConfig: () => any                    // a factory — every new node needs its own object
  summary: (config: any, ctx: { campaignName?: string; listName?: string }) => string
  editor: Component
}

// duration_ms is one combined total (journeys.js's wait schema) — split back
// into whichever of days/hours/minutes are non-zero, so a 90-minute wait reads
// "1 hour 30 minutes" rather than a raw number.
function durationLabel(ms: number): string {
  if (!ms) return ''
  let rem = ms
  const days = Math.floor(rem / 86_400_000); rem -= days * 86_400_000
  const hours = Math.floor(rem / 3_600_000); rem -= hours * 3_600_000
  const minutes = Math.floor(rem / 60_000)
  const parts: string[] = []
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  return parts.join(' ')
}

export const STEP_KINDS: Record<string, StepKind> = {
  trigger_campaign: {
    icon: 'send',
    label: 'Campaign',
    description: "Sends the selected campaign's message to this enrollment's passport when reached.",
    defaultConfig: () => ({ campaign_id: '' }),
    // the name isn't in the config (only the id is), so the canvas resolves it
    // and passes it in — an id that no longer resolves is worth surfacing.
    summary: (c, { campaignName }) => campaignName || (c.campaign_id ? '(unknown campaign)' : '(no campaign selected)'),
    editor: TriggerCampaignEditor,
  },
  wait: {
    icon: 'schedule',
    label: 'Wait',
    description: 'Pauses the enrollment for a fixed duration before continuing to the next step.',
    defaultConfig: () => ({ duration_ms: 5 * 60_000 }),
    summary: (c) => (c.until ? `until ${new Date(c.until).toLocaleString()}` : durationLabel(c.duration_ms) || 'no duration set'),
    editor: WaitEditor,
  },
  branch: {
    icon: 'alt_route',
    label: 'Branch',
    description: 'Splits the flow into Yes/No paths based on an audience match or a filter condition.',
    defaultConfig: () => ({ condition: { audience_id: '' } }),
    summary: (c) => (c.condition?.audience_id ? 'by audience' : c.condition?.filter ? 'by filter' : 'no condition set'),
    editor: BranchEditor,
  },
  set_fact: {
    icon: 'sell',
    label: 'Set Fact',
    description: "Stores a key/value fact on this enrollment's passport for later steps or reporting.",
    defaultConfig: () => ({ key: '', value: '' }),
    summary: (c) => (c.key ? `${c.key} = ${JSON.stringify(c.value)}` : '(no key)'),
    editor: SetFactEditor,
  },
  add_to_list: {
    icon: 'checklist',
    label: 'Add to List',
    description: "Puts this enrollment's passport on a static list, which composes into audiences like any other segment.",
    defaultConfig: () => ({ segment_id: '' }),
    summary: (c, ctx) => ctx.listName || (c.segment_id ? '(unknown list)' : '(no list)'),
    editor: AddToListEditor,
  },
  webhook: {
    icon: 'bolt',
    label: 'Webhook',
    description: "Calls an external URL with this enrollment's data as the request body.",
    defaultConfig: () => ({ url: '', method: 'POST' }),
    summary: (c) => c.url || '(no url)',
    editor: WebhookEditor,
  },
  exit: {
    icon: 'flag',
    label: 'Exit',
    description: 'Ends the enrollment immediately, optionally recording a reason.',
    fill: true,
    defaultConfig: () => ({ reason: '' }),
    summary: (c) => c.reason || 'ends the journey',
    editor: ExitEditor,
  },
}

// A node whose kind isn't registered still has to render rather than crash the
// canvas — an older journey can hold a kind this build no longer ships.
export const UNKNOWN_KIND: Pick<StepKind, 'icon' | 'label' | 'description' | 'fill'> =
  { icon: 'circle', label: 'Unknown step', description: 'This step kind is not supported by this version of the app.' }

export const stepKind = (kind: string) => STEP_KINDS[kind]
export const stepMeta = (kind: string) => STEP_KINDS[kind] || { ...UNKNOWN_KIND, label: kind }
export const PALETTE = Object.entries(STEP_KINDS).map(([kind, meta]) => ({ kind, ...meta }))
