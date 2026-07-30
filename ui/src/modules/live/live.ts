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
export interface StatusMetric { key: string; value: number; severity?: 'bad' }
export interface StatusGauge { label: string; used: number; total: number; exhausted?: boolean }
export interface PluginStatus {
  module: string
  label: string
  metrics: StatusMetric[]
  /** A bounded resource, where the ratio is the point (voip's number pool). */
  gauges: StatusGauge[]
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
