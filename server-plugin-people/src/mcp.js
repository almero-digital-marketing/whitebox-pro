// MCP transport — thin tools over the service, mirroring rest.js and using the
// same tool(scope) currying pattern as journeys/campaigns. Scopes matter here
// beyond the endpoint's mcp:use gate: an agent that can reach MCP must still
// not be able to erase a person unless the token actually carries people:erase.

import { z } from 'zod'

export function register(mcp, { service, logger }) {
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (scope) => (name, description, inputSchema, handler) =>
    mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(args)) })
  const read = tool('people:read')
  const write = tool('people:write')
  const erase = tool('people:erase')

  // --- find ---
  read('people_search',
    'Find people by email, phone, any fact value, or a passport id. Returns each match with all of their identities. Anonymous passports (no identity at all) are excluded unless include_anonymous is set.',
    {
      q: z.string().optional(),
      // An enum rather than free strings so the tool description carries the
      // whole vocabulary — an agent shouldn't have to guess the field names,
      // and a typo would silently widen the search back to everything.
      fields: z.array(z.enum(['identities', 'facts', 'id'])).optional()
        .describe('Where to look for `q`. Omit to search all three.'),
      include_anonymous: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
    ({ q, fields, include_anonymous, limit, offset }) =>
      service.list({ q, fields, includeAnonymous: include_anonymous, limit, offset }))

  read('people_get',
    'Everything held about one person — identities, facts (whatever keys exist), recent awareness, journey enrollments, and suppression status.',
    { id: z.string() },
    ({ id }) => service.get(id))

  read('people_activity',
    "One page of a person's awareness timeline — what they were shown, what they did, calls, and conversions. Each row carries the readable `text` plus channel/direction/source, the emitting plugin, utm attribution and any plugin-specific `meta`.",
    {
      id: z.string(),
      directions: z.array(z.enum(['exposure', 'expression', 'conversation', 'conversion'])).optional()
        .describe('Narrow to certain kinds of activity. Omit for all.'),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    ({ id, directions, limit, offset }) => service.activity(id, { directions, limit, offset }))

  // --- correct ---
  write('people_link_identity',
    'Attach an identity (email/phone/user/fingerprint or a custom type) to a person. If the value already belongs to another passport, core merges the two.',
    { id: z.string(), type: z.string(), value: z.string(), name: z.string().optional() },
    ({ id, ...claim }) => service.linkIdentity(id, claim))

  write('people_unlink_identity',
    'Detach one identity from a person — for undoing a wrong match.',
    { id: z.string(), identity_id: z.union([z.string(), z.number()]) },
    ({ id, identity_id }) => service.unlinkIdentity(id, identity_id))

  write('people_record_fact',
    'Record a fact against a person. The key is free-form — facts have no fixed vocabulary.',
    { id: z.string(), key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) },
    ({ id, key, value }) => service.recordFact(id, { key, value }))

  write('people_merge',
    'Merge two passports that are the same person. Non-destructive: the absorbed id survives as a tombstone that resolves forward to the survivor.',
    { id: z.string().describe('the survivor — the person who continues to exist'), absorbed_id: z.string() },
    ({ id, absorbed_id }) => service.merge(id, absorbed_id))

  // --- forget ---
  erase('people_erase',
    'PERMANENTLY delete a person and every row referencing them, across all plugins (right to be forgotten). Irreversible — prefer people_merge for duplicates.',
    { id: z.string() },
    ({ id }) => service.erase(id))

  logger?.info?.('People: MCP tools registered')
}
