// Service layer — the single implementation REST and MCP both call. No transport
// concerns here. See docs/09-api.md.

import { randomUUID } from 'node:crypto'
import { validateSource, predicateKey, fromRow as segFromRow, isList } from './segments.js'
import { validateAudience, slugify, fromRow as audFromRow } from './audiences.js'

// `passports` is here only so list membership can be stored against the id a
// merged person actually resolves to — a row pointing at a tombstone would
// never come back from any resolve.
let store, evaluator, adapters, identity, consent, passports, logger

export function init(deps) {
  ({ store, evaluator, adapters, identity, consent, passports, logger } = deps)
}

// --- segments (chart-derived dynamic sub-queries) ---
export const listSegments = async () => (await store.listSegments()).map(segFromRow)
export const getSegment = async id => segFromRow(await store.getSegment(id))

// Size + cost of an UNSAVED source (the chip's "~N people" before Save). Reuses the
// engine's preview — cheap, never fires, samples the judge when there is one.
// The single place a segment source becomes a set of people. `select` and
// `funnel` are predicates the evaluator runs; a `list` is stored membership.
// Both the audience resolver and resolveSegment() call through here, so a list
// composes into an audience exactly like a query-backed segment — which is the
// whole point of making it a segment rather than a fourth concept.
async function cohortOf(source) {
  if (isList(source)) return (await store.listMemberIds(source.list)).map(id => ({ id }))
  return evaluator.resolveSource(source)
}

export async function previewSegment(input) {
  const source = validateSource(input)
  if (isList(source)) {
    // Same shape the evaluator returns, not a list-specific one — the palette
    // and every other consumer read `est_matches`, and a list that answered
    // with its own key would silently render blank next to the query segments.
    // For a list the number is exact rather than estimated, but it's the same
    // question: how many people is this segment worth?
    const n = await store.memberCount(source.list)
    return { candidate_pool: n, est_matches: n }
  }
  return evaluator.previewSource(source)
}

// AI label for an unsaved source — what the chip shows before Save.
export async function nameSegment(input, context) {
  return { name: await evaluator.nameSegment({ source: validateSource(input), context }) }
}

// Persist a segment. Dedups on the source predicate (the same slice → one segment);
// names it with the AI if no name was supplied.
export async function saveSegment({ source: input, name, origin, context } = {}) {
  const source = validateSource(input)
  const key = predicateKey(source)
  const existing = await store.getSegmentByKey(key)
  if (existing) return segFromRow(existing)
  const finalName = (name && name.trim()) || await evaluator.nameSegment({ source, context })
  const row = await store.insertSegment({
    id: randomUUID(), name: finalName, source: JSON.stringify(source),
    predicate_key: key, origin: origin ? JSON.stringify(origin) : null,
  })
  return segFromRow(row)
}

export const deleteSegment = id => store.deleteSegment(id)

// --- static lists -----------------------------------------------------------

// A list's source is its own id, so the id has to exist before the source does
// — hence generating it here rather than letting saveSegment() do it. No AI
// naming either: a hand-built list is named by the person building it.
export async function createList({ name } = {}) {
  const clean = (name || '').trim()
  if (!clean) { const e = new Error('a name is required'); e.status = 400; throw e }
  const id = randomUUID()
  const source = validateSource({ list: id })
  const row = await store.insertSegment({
    id, name: clean, source: JSON.stringify(source),
    predicate_key: predicateKey(source), origin: JSON.stringify({ kind: 'list' }),
  })
  return segFromRow(row)
}

// Only list segments — the ones a person can actually be added to. A query
// segment is offered nowhere as a target, because putting someone "in" it would
// be a no-op the next time it resolves.
export async function listLists() {
  const segs = (await store.listSegments()).map(segFromRow).filter(s => isList(s.source))
  return Promise.all(segs.map(async s => ({ ...s, count: await store.memberCount(s.id) })))
}

async function requireList(segmentId) {
  const seg = await getSegment(segmentId)
  if (!seg) { const e = new Error('segment not found'); e.status = 404; throw e }
  if (!isList(seg.source)) {
    const e = new Error('that segment is a query, not a list — its membership is computed, not assigned')
    e.status = 400; throw e
  }
  return seg
}

export async function addToList(segmentId, passportId, addedBy) {
  await requireList(segmentId)
  // resolve first: adding a merged-away id would create a row pointing at a
  // tombstone that no resolve would ever return
  const id = await passports.resolve(passportId)
  if (!id) { const e = new Error('person not found'); e.status = 404; throw e }
  await store.addMember(segmentId, id, addedBy)
  return { segment_id: segmentId, passport_id: id, count: await store.memberCount(segmentId) }
}

// Bulk cherry-pick. Returns what actually changed, not what was asked for:
// "added 187 of 240" is the honest answer when the rest were already on it,
// and it's the number the operator needs to trust the result.
export async function addManyToList(segmentId, passportIds, addedBy) {
  await requireList(segmentId)
  // resolve every id through merges first — a selection can easily contain an
  // absorbed id (search results are resolved, but a caller may pass anything),
  // and a row pointing at a tombstone is invisible to every later read
  const resolved = [...new Set((await Promise.all((passportIds || []).map(id => passports.resolve(id)))).filter(Boolean))]
  const added = await store.addMembers(segmentId, resolved, addedBy)
  return { segment_id: segmentId, requested: passportIds?.length || 0, added, count: await store.memberCount(segmentId) }
}

export async function removeFromList(segmentId, passportId) {
  await requireList(segmentId)
  const id = await passports.resolve(passportId)
  await store.removeMember(segmentId, id || passportId)
  return { segment_id: segmentId, passport_id: id || passportId, count: await store.memberCount(segmentId) }
}

// Which lists is this person on? The read the People browser's right pane uses.
export const passportLists = async passportId =>
  store.segmentsForPassport(await passports.resolve(passportId) || passportId)

// Rename a saved segment. Dedup keys on the source predicate, not the name, so a rename is safe.
export async function renameSegment(id, name) {
  const clean = (name || '').trim()
  if (!clean) { const e = new Error('a name is required'); e.status = 400; throw e }
  const row = await store.updateSegment(id, { name: clean })
  if (!row) { const e = new Error('segment not found'); e.status = 404; throw e }
  return segFromRow(row)
}

// Seed the built-in "Everyone" segment — an empty selector (no filter ⇒ the whole base),
// the universal building block for audiences (e.g. Everyone AND NOT reached). Idempotent
// via the predicate key. Marked system in origin so the UI can treat it as a default.
export async function ensureDefaultSegments() {
  const source = { select: { filter: { all: [] } } }     // an `all` with no conditions ⇒ the whole base
  const predicate_key = predicateKey(source)
  if (await store.getSegmentByKey(predicate_key)) return
  await store.insertSegment({
    id: randomUUID(), name: 'Everyone', source: JSON.stringify(source),
    predicate_key, origin: JSON.stringify({ system: true }),
  })
}

// --- audiences (boolean compositions of segments) ---
export const listAudiences = async () => (await store.listAudiences()).map(audFromRow)
// What GET /audiences serves. `{ total, rows }` — the total is what makes the
// rail's pager honest about a result set the client has never fully seen.
export async function searchAudiences(opts = {}) {
  const { total, rows } = await store.searchAudiences(opts)
  return { total, rows: rows.map(audFromRow) }
}
export const getAudience = async id => audFromRow(await store.getAudience(id))

// resolveSegment(id) → Set of passport ids, memoised within one audience resolution so
// a segment referenced twice (or a positive that's also subtracted) resolves only once.
function segmentResolver() {
  const cache = new Map()
  return (segmentId) => {
    if (!cache.has(segmentId)) cache.set(segmentId, (async () => {
      const seg = await store.getSegment(segmentId)
      if (!seg) return new Set()                           // a deleted segment contributes nobody
      const source = typeof seg.source === 'string' ? JSON.parse(seg.source) : seg.source
      const cohort = await cohortOf(source)
      return new Set(cohort.map(m => m.id))
    })())
    return cache.get(segmentId)
  }
}

// size of an UNSAVED rule (the builder's live "~N people"), composed from its segments
export async function previewAudience(input) {
  const { rule } = validateAudience({ rule: input?.rule ?? input })
  return evaluator.previewAudience(rule, segmentResolver())
}

// AI label for an UNSAVED rule — what the builder shows until the user names it.
// Names from the composition's segment NAMES (resolved here; the evaluator only
// knows ids), split by include vs exclude, plus the match mode.
export async function nameAudience(input) {
  const { rule } = validateAudience({ rule: input?.rule ?? input })
  const named = await Promise.all(rule.members.map(async m => ({
    name: segFromRow(await store.getSegment(m.segment))?.name || 'Segment', negate: m.negate,
  })))
  const included = named.filter(s => !s.negate).map(s => s.name)
  const excluded = named.filter(s => s.negate).map(s => s.name)
  return { name: await evaluator.nameAudience({ op: rule.op, included, excluded }) }
}

export const getAudienceByActivationId = async activationId => audFromRow(await store.getAudienceByActivationId(activationId))

export async function saveAudience(input) {
  const a = validateAudience(input)
  const name = (a.name && a.name.trim()) || 'Untitled audience'
  const id = a.id || randomUUID()
  // activation id: user value or default from name, made unique (skip self on update)
  const base = (a.activation_id && a.activation_id.trim() && slugify(a.activation_id)) || slugify(name)
  let activation_id = base
  for (let n = 2; ; n++) {
    const clash = await store.getAudienceByActivationId(activation_id)
    if (!clash || clash.id === id) break
    activation_id = `${base}-${n}`
  }
  // Only write the columns the caller actually supplied. The UI saves name/rule (no
  // delivery, no channel flags), so omitting those keys lets onConflict.merge leave the
  // stored values untouched — otherwise a rule edit would wipe CAPI delivery + flags.
  const fields = { id, name, activation_id, rule: JSON.stringify(a.rule) }
  if (a.delivery !== undefined) fields.delivery = JSON.stringify(a.delivery)
  if (a.client_side !== undefined) fields.client_side = a.client_side
  if (a.campaigns !== undefined) fields.campaigns = a.campaigns
  const row = await store.upsertAudience(fields)
  return audFromRow(row)
}

// Expose / hide an audience on the client side (the on-site membership lookup below).
// Immediate + safe: it only flips a flag — nothing is sent to a third party (the client
// SDK is first-party), unlike CAPI delivery which is gated by an explicit confirm.
export async function setClientSide(id, enabled) {
  const row = await store.updateAudience(id, { client_side: !!enabled })
  if (!row) { const e = new Error('audience not found'); e.status = 404; throw e }
  return audFromRow(row)
}

// Make an audience available to the Campaigns module (email & SMS) — or not. Same shape
// as client-side: a first-party flag, immediate, no third-party send. The Campaigns module
// lists campaign-enabled audiences as its send targets.
export async function setCampaigns(id, enabled) {
  const row = await store.updateAudience(id, { campaigns: !!enabled })
  if (!row) { const e = new Error('audience not found'); e.status = 404; throw e }
  return audFromRow(row)
}

// Membership lookup — which saved audiences does THIS passport belong to? (Reported to
// the client side by activation_id.) Only audiences explicitly exposed client-side are
// considered — the rest are server/CAPI-only and never leak to the browser. Resolves each
// distinct segment once (memoised), then checks the passport against each composition in
// memory. v1 is compute-on-read; keep-warm could later cache passport → audiences.
export async function passportAudiences(passportId) {
  const auds = (await store.listAudiences()).map(audFromRow).filter(a => a.client_side)
  const resolve = segmentResolver()
  const out = []
  for (const aud of auds) {
    const ids = await evaluator.resolveAudience(aud.rule, resolve)
    if (ids.includes(passportId)) out.push({ id: aud.id, activation_id: aud.activation_id, name: aud.name })
  }
  return { passport_id: passportId, audiences: out }
}

export const deleteAudience = id => store.deleteAudience(id)

// Resolve a saved audience to its LIVE cohort (ids) — recomputed every call.
export async function resolveAudience(id, { limit = 5000 } = {}) {
  const aud = await getAudience(id)
  if (!aud) { const e = new Error('audience not found'); e.status = 404; throw e }
  const ids = (await evaluator.resolveAudience(aud.rule, segmentResolver())).slice(0, limit)
  return { count: ids.length, ids }
}

// --- audience delivery (CAPI activation) ---
// Delivery preview — of the resolved cohort, how many can actually be SENT after the
// suppression + consent gates. Drives the confirm-before-send dialog so the user sees
// exactly what leaves to the ad network before any data is shared.
export async function previewDelivery(id) {
  const aud = await getAudience(id)
  if (!aud) { const e = new Error('audience not found'); e.status = 404; throw e }
  const ids = await evaluator.resolveAudience(aud.rule, segmentResolver())
  return previewCohort(ids)
}

// Consent-gate an ARBITRARY cohort of passport ids → {resolved, deliverable, suppressed,
// no_consent}. Factored out of previewDelivery so the Campaigns plugin can gate the de-duped
// UNION of several audiences (a campaign targets many) with the same suppression+consent rules.
export async function previewCohort(ids) {
  const { deliverable, suppressed, no_consent } = await consent.allowedCohort(ids)
  return { resolved: ids.length, suppressed, no_consent, deliverable: deliverable.length }
}

// The consent-gated DELIVERABLE passport ids of a cohort — same gate as previewCohort, but the
// ids (not just counts), for an actual send. Used by the Campaigns plugin's live delivery.
export async function deliverableCohort(ids) {
  const { deliverable } = await consent.allowedCohort(ids)
  return deliverable
}

// Turn delivery to one network on/off. enabled → resolve, gate, (real send when an
// adapter is configured; dry-run otherwise) and stamp last_synced + the deliverable
// count; disabled → just mark it off. The standing on/off is the user's intent; the
// actual send is gated by an explicit confirm in the UI (this only runs on accept).
export async function setDelivery(id, { network, enabled }) {
  const aud = await getAudience(id)
  if (!aud) { const e = new Error('audience not found'); e.status = 404; throw e }
  const delivery = { ...(aud.delivery || {}) }
  if (!enabled) {
    delivery[network] = { ...(delivery[network] || {}), enabled: false }
  } else {
    const ids = await evaluator.resolveAudience(aud.rule, segmentResolver())
    const { deliverable } = await consent.allowedCohort(ids)
    const adapter = adapters?.find(a => a.name === network)
    const dry_run = !adapter?.eligible                  // no live adapter wired → dry-run
    // What's reported to CAPI: for each deliverable passport we fire a custom event named
    // by the audience's activation_id (+ the hashed identity), so the platform groups them
    // into the custom audience keyed by that id. The activation_id IS the CAPI audience key.
    // (When `adapter` is configured, fire here via delivery/identity; dry-run otherwise.)
    delivery[network] = { enabled: true, last_synced_at: new Date().toISOString(), last_count: deliverable.length, event: aud.activation_id, dry_run }
  }
  const row = await store.upsertAudience({
    id: aud.id, name: aud.name, rule: JSON.stringify(aud.rule), delivery: JSON.stringify(delivery),
  })
  return audFromRow(row)
}

// Self-describing health, for any monitoring surface (see
// docs/10-plugin-status.md). The board holds no audiences knowledge: this names
// its own numbers and says which one is bad news.
//
// `since` is destructured and DELIBERATELY IGNORED — kept in the signature so
// this reads as the same contract every other status() implements, and so that
// ignoring the window is visibly a decision rather than an omission. The
// contract's windowing note is the reason: every number here is CURRENT STATE.
// An audience is a standing rule, not an event — it has no history table, and
// this plugin records no per-send delivery log to window (migration 011 dropped
// the one that existed). Reporting these as windowed counts would claim a
// `since` they were never measured against.
//
// The metric that justifies the card is `not delivering`: an audience with a
// network switched on whose delivery is stamped dry_run, i.e. no eligible
// adapter is wired, so it looks activated and reaches nobody. That is a silent
// failure — nothing logs it, nothing retries it, and the UI shows delivery as on.
//
// Never throws: the two reads are independent, so one failing DB call costs only
// its own metrics and says so in the note. A failed read reports nothing rather
// than zeros — zero means "there are none", which is a different claim.
export async function status({ since } = {}) {
  const [counts, byNetwork] = await Promise.all([
    store.healthCounts()
      .catch(err => { logger?.warn?.({ err }, 'audiences: status counts failed'); return null }),
    store.deliveryByNetwork()
      .catch(err => { logger?.warn?.({ err }, 'audiences: status delivery counts failed'); return null }),
  ])

  const metrics = []
  if (counts) {
    // Every number here is `live`: audiences has no history to window (its
    // per-event delivery log went with the rule system in migration 011), so
    // `since` is ignored and the card must say so rather than imply otherwise.
    metrics.push({ key: 'audiences', value: counts.audiences, live: true })
    metrics.push({ key: 'segments', value: counts.segments, live: true })
  }
  let live = 0, dark = 0
  if (byNetwork) {
    for (const n of byNetwork) { live += n.enabled - n.dry_run; dark += n.dry_run }
    metrics.push({ key: 'delivering', value: live, live: true })
    // Switched on, reaching nobody. Non-zero here means someone activated an
    // audience and the ad network never heard about it.
    metrics.push({ key: 'not delivering', value: dark, severity: 'bad', live: true })
    // Per-network breakdown of the two totals above, carrying `of` because "meta 1
    // of 5" is the whole story where either number alone is meaningless. These were
    // `gauges` — a separate array for bounded resources — but nothing here is
    // consumed and there is no ceiling to hit: it's a proportion that works, not a
    // resource. Once the board stopped drawing a track for gauges there was no
    // reason for them to be a second shape, so they are metrics with a denominator.
    //
    // Deliberately NOT marked `bad`, even when every audience on a network is dark.
    // `severity: 'bad'` means "non-zero is a problem", and this metric's problem
    // state is `value === 0` — it would never fire. `not delivering` above is the
    // number that goes non-zero in exactly that case, so the signal is already
    // there and these rows stay as the detail telling you WHICH network.
    for (const n of byNetwork) {
      metrics.push({ key: n.network, value: n.enabled - n.dry_run, of: n.enabled, live: true })
    }
  }

  return {
    label: 'audiences',
    metrics,
    note: !counts || !byNetwork
      ? 'some audience counts could not be read — see the server log'
      : dark
        ? `${dark} activated audience${dark === 1 ? '' : 's'} ${dark === 1 ? 'has' : 'have'} no eligible ad-network adapter — delivery reads as on and nothing is sent`
        : null,
  }
}

// Resolve a saved segment to its LIVE cohort (ids). Dynamic — recomputed every call.
export async function resolveSegment(id, { limit = 5000 } = {}) {
  const seg = await getSegment(id)
  if (!seg) { const e = new Error('segment not found'); e.status = 404; throw e }
  const cohort = (await cohortOf(seg.source)).slice(0, limit)
  return { count: cohort.length, ids: cohort.map(m => m.id) }
}

// --- networks / identity / facts ---
export const networks = () => adapters.map(a => ({ name: a.name, modes: a.modes, eligible: a.eligible, transport: a.transport || 'http' }))
export const manifest = () => identity.manifest(adapters)
export const availableFacts = () => evaluator.availableFacts()
export const saveSignals = (passportId, signals) => identity.saveSignals(passportId, signals)

// --- deliveries / suppression ---
export const suppress = (passportId, reason) => store.suppress(passportId, reason)
export const unsuppress = passportId => store.unsuppress(passportId)
// Is this one person on the do-not-target list? The store has had this since
// suppression existed; it was never exposed on the service because nothing
// asked per-person until the People module wanted to show it on a profile.
export const isSuppressed = passportId => store.isSuppressed(passportId)
export const listSuppression = () => store.listSuppression()
