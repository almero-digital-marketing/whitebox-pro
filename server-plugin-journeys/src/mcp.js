// MCP transport — thin tools over the service, mirrors the REST surface
// (rest.js) and campaigns' mcp.js tool(scope) currying pattern exactly.
// Each tool carries journeys:read/journeys:write — the endpoint-level
// mcp:use gate only answers "can this token use MCP at all"; these make
// sure a token without journeys:write can't activate/enroll/delete just
// because it can reach the endpoint.

import { z } from 'zod'
import { Trigger, StepsGraph, Dedupe } from './journeys.js'

export function register(mcp, { service, logger }) {
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (scope) => (name, description, inputSchema, handler) =>
    mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(args)) })
  const read = tool('journeys:read')
  const write = tool('journeys:write')

  // --- inspect ---
  read('journeys_list', 'List all journeys with status, trigger, and entry step.', {}, () => service.listJourneys())
  read('journeys_get', 'Get one journey — trigger, full step graph, dedupe policy.', { id: z.string() }, ({ id }) => service.getJourney(id))
  read('journeys_list_enrollments', 'List a journey\'s enrollments, optionally filtered by status.', { id: z.string(), status: z.enum(['active', 'waiting', 'completed', 'exited', 'failed']).optional() }, ({ id, status }) => service.listEnrollments(id, { status }))
  read('journeys_enrollment_status', 'Get one enrollment plus its full ordered step-run audit trail — the per-passport "what actually happened" view.', { enrollment_id: z.string() }, ({ enrollment_id }) => service.getEnrollment(enrollment_id))

  // --- author (draft/paused only — matches campaigns' "draft campaigns only" precedent) ---
  write('journeys_create', 'Create a draft journey (trigger + step graph + dedupe policy).', { name: z.string(), trigger: Trigger, steps: StepsGraph, dedupe: Dedupe.optional() }, (input) => service.createJourney(input))
  write('journeys_update', 'Update a journey\'s name/trigger/steps/dedupe. Fails if not draft/paused — pause an active journey first.', { id: z.string(), name: z.string().optional(), trigger: Trigger.optional(), steps: StepsGraph.optional(), dedupe: Dedupe.optional() }, ({ id, ...input }) => service.patchJourney(id, input))

  // --- act (guarded) ---
  write('journeys_activate', 'Activate a draft/paused journey — starts evaluating its trigger and accepting enrollments.', { id: z.string() }, ({ id }) => service.activateJourney(id))
  write('journeys_pause', 'Pause an active journey. New enrollments stop; already-scheduled wait steps still fire but no-op against a non-active journey (frozen in place, not cancelled).', { id: z.string() }, ({ id }) => service.pauseJourney(id))
  write('journeys_delete', 'Delete a journey (cascades enrollments and step-run history).', { id: z.string() }, ({ id }) => service.deleteJourney(id).then(deleted => ({ deleted })))
  write('journeys_enroll', 'Manually enroll one passport into an active journey, bypassing its normal trigger.', { id: z.string(), passport_id: z.string() }, ({ id, passport_id }) => service.enroll(id, passport_id, { source: 'manual' }))
  write('journeys_exit_enrollment', 'Manually exit one enrollment — actively cancels its pending wait job if any.', { enrollment_id: z.string(), reason: z.string().optional() }, ({ enrollment_id, reason }) => service.exitEnrollment(enrollment_id, reason))

  logger?.info?.('Journeys: MCP tools registered')
}
