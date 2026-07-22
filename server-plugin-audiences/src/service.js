// Service layer — the single implementation REST and MCP both call. No transport
// concerns here. See docs/09-api.md.

import { randomUUID } from 'node:crypto'
import { validateSource, predicateKey, fromRow as segFromRow } from './segments.js'
import { validateAudience, slugify, fromRow as audFromRow } from './audiences.js'

let store, evaluator, adapters, identity, consent, logger

export function init(deps) {
  ({ store, evaluator, adapters, identity, consent, logger } = deps)
}

// --- segments (chart-derived dynamic sub-queries) ---
export const listSegments = async () => (await store.listSegments()).map(segFromRow)
export const getSegment = async id => segFromRow(await store.getSegment(id))

// Size + cost of an UNSAVED source (the chip's "~N people" before Save). Reuses the
// engine's preview — cheap, never fires, samples the judge when there is one.
export async function previewSegment(input) {
  return evaluator.previewSource(validateSource(input))
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
      const cohort = await evaluator.resolveSource(source)
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

// Resolve a saved segment to its LIVE cohort (ids). Dynamic — recomputed every call.
export async function resolveSegment(id, { limit = 5000 } = {}) {
  const seg = await getSegment(id)
  if (!seg) { const e = new Error('segment not found'); e.status = 404; throw e }
  const cohort = (await evaluator.resolveSource(seg.source)).slice(0, limit)
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
export const listSuppression = () => store.listSuppression()
