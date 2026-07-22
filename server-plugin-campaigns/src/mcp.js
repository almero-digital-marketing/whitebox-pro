// MCP transport — thin tools over the service, registered on the shared MCP
// server (behind config.mcp.auth.secret). Mirrors the REST surface (rest.js).
// The Mikser upsert route (PUT /upsert, by external_id) is deliberately NOT
// exposed here — it's a specific external-system integration path, not a
// general campaign-management action.
//
// Each tool also carries the matching campaigns:read/campaigns:write scope —
// the endpoint-level mcp:use gate only answers "can this token use MCP at
// all"; these make sure a token without campaigns:write can't schedule/send/
// delete just because it can reach the endpoint. Same split as rest.js.

import { z } from 'zod'

export function register(mcp, { service, logger }) {
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (scope) => (name, description, inputSchema, handler) =>
    mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(args)) })
  const read = tool('campaigns:read')
  const write = tool('campaigns:write')

  // --- inspect ---
  read('campaigns_list', 'List all campaigns.', {}, () => service.listCampaigns())
  read('campaigns_get', 'Get one campaign, with its attached audiences (id, name, live size) and resolved analytics_prompt.', { id: z.string() }, ({ id }) => service.getCampaign(id))
  read('campaigns_delivery_preview', 'Of the campaign\'s attached audiences (consent-gated union), how many are actually reachable.', { id: z.string() }, ({ id }) => service.previewDelivery(id))

  // --- author (draft campaigns only — locked once scheduled/sent) ---
  write('campaigns_create', 'Create a draft campaign.', { name: z.string(), channel: z.enum(['email', 'sms']), subject: z.string().optional(), scheduled_at: z.string().optional(), message: z.any().optional(), analytics_prompt: z.string().optional() }, (input) => service.saveCampaign(input))
  write('campaigns_update', 'Update a draft campaign\'s fields. Fails if the campaign is locked (scheduled or sent) — unlock it first.', { id: z.string(), name: z.string().optional(), channel: z.enum(['email', 'sms']).optional(), subject: z.string().optional(), scheduled_at: z.string().optional(), message: z.any().optional(), analytics_prompt: z.string().optional(), objective: z.any().optional(), report_id: z.string().optional() }, ({ id, ...input }) => service.patchCampaign(id, input))
  write('campaigns_attach_audience', 'Attach an audience to a draft campaign (many-to-many). Fails if locked.', { id: z.string(), audience_id: z.string() }, ({ id, audience_id }) => service.attachAudience(id, audience_id))
  write('campaigns_detach_audience', 'Detach an audience from a draft campaign. Fails if locked.', { id: z.string(), audience_id: z.string() }, ({ id, audience_id }) => service.detachAudience(id, audience_id))

  // --- act (guarded) ---
  write('campaigns_schedule', 'Commit the campaign for delivery at its scheduled_at and LOCK it for further edits. If scheduled_at has already passed, delivery fires IMMEDIATELY. Actual sending obeys the server\'s configured dryRun switch (default ON, records the projected reach without sending) — there is no per-call override.', { id: z.string() }, ({ id }) => service.schedule(id))
  write('campaigns_unlock', 'Unlock a SCHEDULED (not yet sent) campaign back to an editable draft. A delivered (sent) campaign is final and cannot be unlocked.', { id: z.string() }, ({ id }) => service.unlockCampaign(id))
  write('campaigns_set_report', 'Link an Analytics report to a campaign (typically the performance report built after it sends).', { id: z.string(), report_id: z.string() }, ({ id, report_id }) => service.setReport(id, report_id))
  write('campaigns_delete', 'Delete a campaign.', { id: z.string() }, ({ id }) => service.deleteCampaign(id).then(deleted => ({ deleted })))

  logger?.info?.('Campaigns: MCP tools registered')
}
