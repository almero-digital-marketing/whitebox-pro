// Thin client for the live plugin. Read-only: this module observes the system
// and never changes it, so there is nothing here but GETs.
import { createClient } from '../../shell/apiClient'

const req = createClient('/api/live')

export type Direction = 'in' | 'out' | 'internal' | 'unknown'
export type WindowKey = '5m' | '30m' | '1h' | '24h'

export interface FeedEvent {
  id: string | null
  type: string
  at: string
  direction: Direction
  channel: string
  // one-line "what was this about", built server-side (live/src/describe.js) so
  // the backfill and the stream can never word the same event differently
  detail: string | null
  passport_id: string | null
  // No raw payload: it was never rendered and was half the weight of every row.
  // See live/src/service.js toFeedRow.
}

/** One plugin describing its own health — see docs/10-plugin-status.md. */
export interface StatusMetric {
  key: string
  value: number
  severity?: 'bad'
  /**
   * This number is CURRENT STATE and ignores the window — "how many right now",
   * not "how many in the last 30m". Roughly half the card is like this
   * (`0 drafts`, `1 segments`, `0 enrolled`). Plugins that ignore `since` must say
   * so with this, and every one of them does, verified against its own SQL.
   *
   * NOT RENDERED. The Live board shows windowed and current-state figures
   * identically, on purpose: three attempts at a per-figure cue (a "now" chip,
   * accent colour, bold-vs-regular) each cost row clarity to answer a question
   * nobody opens this card to ask. Kept because it is true, cheap and tested — the
   * analysis behind it is the expensive part and shouldn't have to be redone.
   */
  live?: boolean
  /**
   * A denominator, when the ratio is the point and either number alone says
   * nothing — voip's "3 of 8 numbers held", audiences' "meta 1 of 5 delivering".
   *
   * This replaced a parallel `gauges` array. That array existed only because the
   * board once drew a track for bounded resources; with the track gone, a gauge
   * and a metric-with-a-denominator render identically, and one concept beats
   * two. `severity` covers what `exhausted` used to say — it always meant "the
   * plugin's own judgement that this is a problem".
   */
  of?: number
  /**
   * What this number counts, in a sentence, written by the plugin that owns it.
   *
   * Declared at the point the metric is built (server-side) because only the
   * plugin knows: `sent` means "handed to the provider" and `delivered` means "the
   * provider confirmed the mailbox took it", a distinction no surface could infer
   * from the keys. The status pane shows ~65 counters from 13 plugins together, so
   * without these a third of the keys are guesses.
   *
   * Optional in the type so an older plugin still renders; every plugin in this
   * repo sets it on every metric, and each has a test asserting so.
   */
  description?: string
}
export interface PluginStatus {
  module: string
  label: string
  metrics: StatusMetric[]
  note: string | null
}

export interface Summary {
  window: WindowKey
  window_seconds: number
  since: string
  total: number
  per_minute: number
  by_direction: Record<Direction, number>
  by_channel: Record<string, number>
  types: { type: string; count: number }[]
  active_passports: number
  // unwindowed — what makes an empty window legible as 'quiet' not 'broken'
  last_event_at: string | null
  // Whoever could describe themselves, in config order. A plugin that can't is
  // ABSENT — never present-with-zeros, which would read as healthy.
  status: PluginStatus[]
  /** Registered but threw — broken, not merely unmonitored. */
  status_failing: string[]
  /** Registered with no status() at all — unmonitored. */
  status_silent: string[]
}

export interface UtmRow { value: string; count: number }
export interface Utm {
  window: WindowKey
  sessions: number
  // sessions carrying no utm_source — named so a campaign list can't imply
  // that paid traffic is all of it
  direct: number
  source: UtmRow[]
  medium: UtmRow[]
  campaign: UtmRow[]
}

export interface Content { window: WindowKey; total: number; kinds: UtmRow[] }

export interface Series { window: WindowKey; bucket_seconds: number; buckets: { bucket: string; in: number; out: number; internal: number; unknown: number }[] }

export const liveClient = {
  summary: (w: WindowKey) => req(`/summary?window=${w}`) as Promise<Summary>,
  // `points` = how many bars the strip can draw at its current width. Omitted
  // before the plot has been measured; the server falls back to a sane default.
  timeseries: (w: WindowKey, points?: number) =>
    req(`/timeseries?window=${w}${points ? `&points=${points}` : ''}`) as Promise<Series>,
  utm: (w: WindowKey) => req(`/utm?window=${w}`) as Promise<Utm>,
  content: (w: WindowKey) => req(`/content?window=${w}`) as Promise<Content>,
  recent: (w: WindowKey, limit = 100) => req(`/recent?limit=${limit}&window=${w}`) as Promise<{ events: FeedEvent[] }>,
}

// The two series colours are VALIDATED, not chosen by eye — teal-600 / indigo-600
// clear the lightness, chroma, CVD-separation, normal-vision and contrast checks
// against both the light and dark surfaces. Changing either means re-running the
// validator, not just picking a nicer hue.
export const DIRECTION_COLOR: Record<string, string> = { in: '#0d9488', out: '#4f46e5' }
// Direction is encoded TWICE — glyph as well as colour — so it survives
// colourblindness, greyscale printing and forced-colors mode.
export const DIRECTION_GLYPH: Record<Direction, string> = { in: '↓', out: '↑', internal: '·', unknown: '?' }
