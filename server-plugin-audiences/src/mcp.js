// MCP transport — thin tools over the service, registered on the shared MCP
// server (behind config.mcp.auth.secret). Mirrors the REST surface (rest.js) —
// segments (the atom) and audiences (boolean compositions of segments, the
// deliverable layer). Full reference: docs/09-api.md.
//
// Each tool also carries the matching audiences:read/audiences:write scope —
// the endpoint-level mcp:use gate only answers "can this token use MCP at
// all"; these make sure a token without audiences:write can't mutate data
// just because it can reach the endpoint. Same split as rest.js's read/write.

import { z } from 'zod'
import { SegmentSource } from './segments.js'
import { AudienceRule } from './audiences.js'

export function register(mcp, { service, logger }) {
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (scope) => (name, description, inputSchema, handler) =>
    mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(args)) })
  const read = tool('audiences:read')
  const write = tool('audiences:write')

  // --- inspect ---
  read('audiences_list_segments', 'List all saved segments.', {}, () => service.listSegments())
  read('audiences_get_segment', 'Get one segment.', { id: z.string() }, ({ id }) => service.getSegment(id))
  read('audiences_segment_members', 'Resolve a segment to its live cohort (ids).', { id: z.string(), limit: z.number().optional() }, ({ id, limit }) => service.resolveSegment(id, { limit }))
  read('audiences_list_audiences', 'List all saved audiences.', {}, () => service.listAudiences())
  read('audiences_get_audience', 'Get one audience.', { id: z.string() }, ({ id }) => service.getAudience(id))
  read('audiences_audience_members', 'Resolve an audience to its live cohort (ids) — combines its segments per the audience\'s op (all/any) and any negated members.', { id: z.string(), limit: z.number().optional() }, ({ id, limit }) => service.resolveAudience(id, { limit }))
  read('audiences_passport_audiences', 'Which client-side-exposed audiences a passport belongs to.', { passport_id: z.string() }, ({ passport_id }) => service.passportAudiences(passport_id))
  read('audiences_delivery_preview', 'Of an audience\'s resolved cohort, how many are actually deliverable after suppression + consent gates.', { id: z.string() }, ({ id }) => service.previewDelivery(id))
  read('audiences_network_status', 'Networks: eligibility, modes, identity coverage.', {}, () => service.networks())
  read('audiences_list_facts', 'CRM fact keys available for segment/audience authoring.', {}, () => service.availableFacts())
  read('audiences_list_suppression', 'The do-not-target list.', {}, () => service.listSuppression())

  // --- author (AI-native) --- previews/name-suggestions never persist, so they're read-gated
  read('audiences_preview_segment', 'Size of an UNSAVED segment source. Never persists.', { source: SegmentSource }, ({ source }) => service.previewSegment(source))
  read('audiences_name_segment', 'AI-suggested name for an UNSAVED segment source.', { source: SegmentSource, context: z.any().optional() }, ({ source, context }) => service.nameSegment(source, context))
  write('audiences_create_segment', 'Create a segment (commit). Dedups on the source predicate — the same slice saved twice returns the existing segment.', { source: SegmentSource, name: z.string().optional(), origin: z.any().optional(), context: z.any().optional() }, ({ source, name, origin, context }) => service.saveSegment({ source, name, origin, context }))
  write('audiences_rename_segment', 'Rename a saved segment.', { id: z.string(), name: z.string() }, ({ id, name }) => service.renameSegment(id, name))
  read('audiences_preview_audience', 'Size of an UNSAVED audience composition (segments + op). Never persists.', { rule: AudienceRule }, ({ rule }) => service.previewAudience(rule))
  read('audiences_name_audience', 'AI-suggested name for an UNSAVED audience composition.', { rule: AudienceRule }, ({ rule }) => service.nameAudience(rule))
  write('audiences_create_audience', 'Create/update an audience (commit). Pass an existing id to update it.', { id: z.string().optional(), name: z.string().optional(), activation_id: z.string().optional(), rule: AudienceRule }, (input) => service.saveAudience(input))

  // --- act (guarded) ---
  write('audiences_delete_segment', 'Delete a saved segment.', { id: z.string() }, ({ id }) => service.deleteSegment(id).then(deleted => ({ deleted })))
  write('audiences_delete_audience', 'Delete a saved audience.', { id: z.string() }, ({ id }) => service.deleteAudience(id).then(deleted => ({ deleted })))
  write('audiences_set_delivery', 'Turn an audience\'s delivery to one ad network on/off. Firing (when enabled) is a real send unless no adapter is configured for that network, in which case it dry-runs automatically.', { id: z.string(), network: z.string(), enabled: z.boolean() }, ({ id, network, enabled }) => service.setDelivery(id, { network, enabled }))
  write('audiences_set_client_side', 'Expose/hide an audience on the client side (on-site membership lookup). Immediate, first-party only — never sent to a third party.', { id: z.string(), enabled: z.boolean() }, ({ id, enabled }) => service.setClientSide(id, enabled))
  write('audiences_set_campaigns', 'Make an audience available to the Campaigns module (email & SMS) or not.', { id: z.string(), enabled: z.boolean() }, ({ id, enabled }) => service.setCampaigns(id, enabled))
  write('audiences_suppress', 'Add a passport to the do-not-target list.', { passport_id: z.string(), reason: z.string().optional() }, ({ passport_id, reason }) => service.suppress(passport_id, reason).then(() => ({ ok: true })))
  write('audiences_unsuppress', 'Remove a passport from the do-not-target list.', { passport_id: z.string() }, ({ passport_id }) => service.unsuppress(passport_id).then(() => ({ ok: true })))

  logger?.info?.('Audiences: MCP tools registered')
}
