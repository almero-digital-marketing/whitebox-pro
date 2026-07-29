// Thin client for the people plugin. Calls go to /api/people/* (the dev proxy
// strips /api → the server's /people/* surface). Auth is the logged-in user's
// session token (see shell/apiClient.ts).
import { createClient } from '../../shell/apiClient'

const req = createClient('/api/people')

export interface Identity {
  id: number | string
  type: string          // email | phone | user | fingerprint | <custom>
  name: string
  value: string
  created_at?: string
  last_seen_at?: string
}

export interface PersonRow {
  id: string
  created_at?: string
  last_seen_at?: string
  identities: Identity[]
  // How many awareness rows this person has. Undefined when the deployment
  // isn't running awareness at all — distinct from 0, which means "counted,
  // and there's nothing". Same null-vs-empty distinction as `segments`.
  event_count?: number
}

// `enrollments` / `suppressed` are null when the journeys / audiences plugin
// isn't registered — distinct from [] / false, which mean "wired, and there
// are none". The detail view uses that to omit a section rather than show an
// empty one that looks like a data problem.
// One awareness row. The server returns the exposure joined to its session, so
// a row carries the readable `text`, how it happened (channel/direction/source),
// which plugin recorded it, the utm attribution of the session it belonged to,
// and whatever plugin-specific `meta` was stamped on it.
export interface Activity {
  id: number
  ts: string
  channel: string
  direction: string
  source?: string | null
  plugin?: string | null
  text: string
  dwell_ms?: number | null
  meta?: Record<string, any> | null
  content_url?: string | null
  referrer?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
}

// A static-list segment. Query segments never appear here — their membership is
// recomputed from a predicate, so a person can't be put "in" one.
export interface ListSeg {
  id: string
  name: string
  count?: number
  added_at?: string
  added_by?: string | null
}

export interface Person extends PersonRow {
  facts: Record<string, any>
  recent: any[]
  // null when the audiences plugin isn't registered, [] when it is and this
  // person is on no lists
  segments: ListSeg[] | null
  enrollments: any[] | null
  suppressed: boolean | null
}

const qs = (params: Record<string, any>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

// Where a search term is looked for — core's SEARCH_FIELDS, mirrored here
// because the rail renders them as checkboxes. Sending all three is the same
// as sending none, so the client doesn't special-case "everything".
export type SearchField = 'identities' | 'facts' | 'id'
export const SEARCH_FIELDS: { value: SearchField; label: string; hint: string }[] = [
  { value: 'identities', label: 'Identities', hint: 'email, phone, and any custom type' },
  { value: 'facts', label: 'Facts', hint: 'any recorded value, whatever the key' },
  { value: 'id', label: 'Passport ID', hint: 'the whole id, or the short one on a row' },
]

export const peopleClient = {
  search: (opts: { q?: string; fields?: SearchField[]; includeAnonymous?: boolean; limit?: number; offset?: number } = {}) =>
    req(qs({
      q: opts.q,
      // CSV, matching the route. Omitted when all three are on — the server
      // reads "no scope" as "everywhere", so the default query stays clean.
      fields: opts.fields && opts.fields.length < SEARCH_FIELDS.length ? opts.fields.join(',') : undefined,
      include_anonymous: opts.includeAnonymous, limit: opts.limit, offset: opts.offset,
    })) as Promise<{ total: number; people: PersonRow[] }>,
  get: (id: string) => req(`/${id}`) as Promise<Person>,
  lists: () => req('/lists') as Promise<ListSeg[]>,
  createList: (name: string) =>
    req('/lists', { method: 'POST', body: JSON.stringify({ name }) }) as Promise<ListSeg>,
  addToList: (id: string, segmentId: string) =>
    req(`/${id}/lists`, { method: 'POST', body: JSON.stringify({ segment_id: segmentId }) }) as Promise<Person>,
  // bulk: either an explicit set of ids, or a QUERY the server re-runs. The
  // second is the point — the client has only ever seen one page of it.
  addManyToList: (segmentId: string, body: { passport_ids?: string[]; query?: any }) =>
    req(`/lists/${segmentId}/members`, { method: 'POST', body: JSON.stringify(body) }) as
      Promise<{ added: number; requested: number; count: number | null; truncated?: boolean }>,
  removeFromList: (id: string, segmentId: string) =>
    req(`/${id}/lists/${segmentId}`, { method: 'DELETE' }) as Promise<Person>,
  activity: (id: string, opts: { limit?: number; offset?: number; directions?: string[] } = {}) =>
    req(`/${id}/activity${qs({
      limit: opts.limit, offset: opts.offset,
      directions: opts.directions?.length ? opts.directions.join(',') : undefined,
    })}`) as Promise<{ rows: Activity[]; hasMore: boolean }>,
  linkIdentity: (id: string, claim: { type: string; value: string; name?: string }) =>
    req(`/${id}/identities`, { method: 'POST', body: JSON.stringify(claim) }) as Promise<Person>,
  unlinkIdentity: (id: string, identityId: number | string) =>
    req(`/${id}/identities/${identityId}`, { method: 'DELETE' }) as Promise<Person>,
  recordFact: (id: string, fact: { key: string; value: string | number | boolean }) =>
    req(`/${id}/facts`, { method: 'POST', body: JSON.stringify(fact) }) as Promise<Person>,
  // Same `{passport_ids | query}` envelope as addManyToList — one bulk shape
  // for every verb, so the store doesn't need a different call per action.
  recordFactForMany: (body: { key: string; value: string; passport_ids?: string[]; query?: any }) =>
    req('/facts', { method: 'POST', body: JSON.stringify(body) }) as
      Promise<{ recorded: number; requested: number; truncated?: boolean }>,
  // Every key in use across the deployment. Facts have no fixed vocabulary, so
  // this is the only thing standing between `client_status` and `clientStatus`.
  factKeys: () => req('/fact-keys') as Promise<string[]>,
  merge: (survivorId: string, absorbedId: string) =>
    req(`/${survivorId}/merge`, { method: 'POST', body: JSON.stringify({ absorbed_id: absorbedId }) }) as Promise<Person>,
  erase: (id: string) =>
    req(`/${id}`, { method: 'DELETE' }) as Promise<{ id: string; removed: Record<string, number> }>,
  // POST, not DELETE: same bulk envelope as the other verbs, and a DELETE body
  // isn't reliably forwarded. `erased` can trail `requested` — a merged
  // passport in the set is already gone when its turn comes.
  eraseMany: (body: { passport_ids?: string[]; query?: any }) =>
    req('/erase', { method: 'POST', body: JSON.stringify(body) }) as
      Promise<{ erased: number; requested: number; removed: Record<string, number>; truncated?: boolean }>,
}

// ── presentation helpers ────────────────────────────────────────────────────
// The server deliberately returns no display name: facts are optional and
// their keys are arbitrary, so only the UI can decide how to label a person.
//
// A result row shows EMAIL and PHONE only. The other two strong types are real
// identities and appear in full on the detail view, but they're not how a
// person is recognised in a list: `fingerprint` is a browser hash nobody can
// read, and `user` is an internal account id. Showing them in a scan-list adds
// noise without adding recognition.
const CONTACT_TYPES = ['email', 'phone']

export const shortId = (id: string) => id.slice(0, 8)

const contacts = (p: { identities?: Identity[] }) =>
  (p.identities || []).filter(i => CONTACT_TYPES.includes(i.type))
const firstOf = (p: { identities?: Identity[] }, type: string) =>
  contacts(p).find(i => i.type === type) || null

// The one a person is named by. Email leads when there is one, phone otherwise
// — not a ranking of importance, just the more distinctive of the two to scan
// for. There's no `secondaryContact` any more: the rail row shows this one over
// a timestamp, and the centre pane has the width for fullContact() to name both
// at once, so nothing needed "the other kind" on its own.
export const primaryContact = (p: { identities?: Identity[] }): Identity | null =>
  firstOf(p, 'email') || firstOf(p, 'phone')

// An anonymous passport gets a real label rather than a blank — most passports
// ARE anonymous (226 of 277 in the dev DB), so a wall of empty rows would read
// as broken rather than as "we don't know who these people are yet".
//
// The one-line form, and the rail's row label: the email, or the phone when
// there's no email. One identifier, because the rail's second line carries
// when we last saw them, not the other contact — 350px can't hold both without
// ellipsizing the identifier, which is the half you're reading.
// The id stays IN the anonymous case, and that's load-bearing twice over:
// "Anonymous" alone would be the same label for every anonymous row (226 of
// 277 in the dev DB), and the same phrase for every ErasePanel confirmation,
// so typing it would confirm nothing.
export const displayName = (p: { id: string; identities?: Identity[] }) => {
  const best = primaryContact(p)
  return best ? best.value : `Anonymous · ${shortId(p.id)}`
}

// The centre pane's title. Unlike a rail row — 350px, so it shows one contact
// and puts the timestamp underneath — the header has the width to name a
// person by BOTH the things they're recognised by at once. Whichever
// exists is shown; with only one there's no separator to leave dangling, and
// with neither it falls back to the same anonymous label as the rail so the two
// panes never disagree about who is open.
export const fullContact = (p: { id: string; identities?: Identity[] }) => {
  const both = [firstOf(p, 'email'), firstOf(p, 'phone')].filter(Boolean) as Identity[]
  return both.length ? both.map(i => i.value).join(' · ') : displayName(p)
}

// No "+N more" counter any more. The rail row is one identifier over one
// timestamp; a chip counting the contacts it isn't showing put a number on the
// row that you couldn't act on without opening the person anyway — and
// Identities in the right pane already answers it exactly.

// ── activity presentation ───────────────────────────────────────────────────
// `direction` is core's vocabulary and the real spine of a person's history:
// whether WE reached out, THEY acted, the two sides talked, or money changed
// hands. Ordered by how much each one tells you about intent, which is also the
// order the filter chips read in.
export const DIRECTIONS: { value: string; label: string; icon: string }[] = [
  { value: 'conversion', label: 'Converted', icon: 'paid' },
  { value: 'expression', label: 'They acted', icon: 'ads_click' },
  { value: 'conversation', label: 'Talked', icon: 'forum' },
  { value: 'exposure', label: 'We reached', icon: 'campaign' },
]
const DIR_ICON = Object.fromEntries(DIRECTIONS.map(d => [d.value, d.icon]))
export const directionIcon = (d?: string | null) => DIR_ICON[d || ''] || 'circle'

// `meta.event` restates what direction/source already say, so it's dropped
// rather than rendered as a chip that repeats the line above it. A value plus
// its currency is one fact, not two, so they're joined.
export const metaChips = (meta?: Record<string, any> | null) => {
  if (!meta) return [] as { k: string; v: string }[]
  const { event, value, currency, ...rest } = meta
  const out: { k: string; v: string }[] = []
  if (value != null && value !== '') out.push({ k: 'amount', v: `${value}${currency ? ` ${currency}` : ''}` })
  for (const [k, v] of Object.entries(rest)) {
    if (v == null || v === '') continue
    out.push({ k, v: typeof v === 'object' ? JSON.stringify(v) : String(v) })
  }
  return out
}

// The session's attribution, when the row came from one. Rendered as a single
// crumb — the three parts are only meaningful together.
export const utmOf = (r: Activity) =>
  [r.utm_source, r.utm_medium, r.utm_campaign].filter(Boolean).join(' / ')

// Only 4 of 20 rows carry dwell in the dev data, so this is rendered only when
// present rather than as an always-there "—".
export const dwellOf = (ms?: number | null) => {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}
