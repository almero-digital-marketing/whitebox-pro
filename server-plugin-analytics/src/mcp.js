// MCP capability registrations for the analytics plugin.
//
// These are the most LLM-relevant tools in whitebox. An external agent
// (Claude desktop, agentic IDE, internal Claude SDK loop) connected over
// MCP can ask grounded questions about any customer using the same
// retrieval primitives the HTTP /analytics endpoints expose — but with
// the tool descriptions and JSON Schema tuned for LLM consumption.
//
// `whitebox.ask` delegates to the core awareness.ask primitive — the same call
// the HTTP /ask endpoint makes — so the synthesis behaviour stays in lockstep.
//
// Each tool also carries the matching analytics:read/analytics:write scope,
// same split as routes.js — the endpoint-level mcp:use gate only answers
// "can this token use MCP at all"; `whitebox.forget` additionally needs
// analytics:write since it's destructive, matching DELETE /passport/:id.

import { z } from 'zod'

export function registerMcp(ctx, { awareness, context }) {
  if (!ctx.mcp) return
  const tool = (name, description, inputSchema, scope, handler) =>
    ctx.mcp.tool({ name, description, inputSchema, scope, handler })

  tool('whitebox.ask',
    'Answer a natural-language question about a single customer. Returns a grounded synthesis built from semantic recall (mail / voip / web / crm content history) plus current structured context (CRM rows). Cites timestamps. The single most useful tool for understanding a customer.',
    {
      passport_id: z.string().uuid(),
      question:    z.string().min(1),
      limit:       z.number().int().positive().max(50).optional(),
    },
    'analytics:read',
    async (args) => {
      const result = await awareness.ask(args)
      return { content: [{ type: 'text', text: result.answer }] }
    },
  )

  tool('whitebox.ask_population',
    'Answer a natural-language question about the WHOLE customer base (or a semantic cohort within it) — not one customer, so no passport_id. Grounds the answer in content matching the question across all passports, weighted by how many distinct customers each piece reached, plus the cohort size. Use for "what are customers asking about?", "how many people heard about X?", "what is the most common objection?". For a single customer, use whitebox.ask instead.',
    {
      question:   z.string().min(1),
      similarity: z.number().min(0).max(1).optional(),
      limit:      z.number().int().positive().max(10000).optional(),
    },
    'analytics:read',
    async (args) => {
      const result = await awareness.askPopulation(args)
      return { content: [{ type: 'text', text: result.answer }] }
    },
  )

  tool('whitebox.recall',
    'Per-passport semantic search. Returns the top-K content chunks (mail bodies, web reads, call transcripts, CRM notes) most relevant to a query, ranked by vector similarity. Each hit includes channel, direction, timestamp, and UTM attribution when available.',
    {
      passport_id:    z.string().uuid(),
      query:          z.string().min(1),
      limit:          z.number().int().positive().max(100).optional(),
      min_similarity: z.number().min(0).max(1).optional(),
    },
    'analytics:read',
    async ({ passport_id, query, limit = 10, min_similarity = 0 }) => {
      const hits = await awareness.recall({ passport_id, query, limit, min_similarity })
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
    },
  )

  tool('whitebox.population',
    'Cohort awareness — how many distinct customers have content matching a concept, above a similarity threshold. Useful for "how many people have we told about X?" style questions. Pass min_engagement (0–1) to require genuine reading depth on web content (e.g. 0.15 excludes skimmed headings); non-web channels always qualify.',
    {
      query:          z.string().min(1),
      similarity:     z.number().min(0).max(1).optional(),
      limit:          z.number().int().positive().max(10000).optional(),
      min_engagement: z.number().min(0).max(1).optional(),
    },
    'analytics:read',
    async (args) => {
      const result = await awareness.population(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  tool('whitebox.timeline',
    'Flat content timeline for a single passport, newest first. Returns raw exposures (no embedding work). Filter by channel (mail / voip / web / crm), direction (exposure / expression / conversation / observation), and date range.',
    {
      passport_id: z.string().uuid(),
      from:        z.string().datetime().optional(),
      to:          z.string().datetime().optional(),
      channels:    z.array(z.string()).optional(),
      directions:  z.array(z.string()).optional(),
    },
    'analytics:read',
    async ({ passport_id, from, to, channels, directions }) => {
      const rows = await awareness.timeline({
        passport_id,
        from: from ? new Date(from) : null,
        to:   to   ? new Date(to)   : null,
        channels:   channels   ?? null,
        directions: directions ?? null,
      })
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    },
  )

  tool('whitebox.context',
    'Inspect the structured context registry for a passport — what every plugin (crm, billing, …) currently knows. This is what whitebox.ask sees before the LLM step; useful for debugging "why didn\'t the answer mention X?".',
    {
      passport_id: z.string().uuid(),
      providers:   z.array(z.string()).optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    'analytics:read',
    async ({ passport_id, providers, limit = 20 }) => {
      if (!context?.collect) {
        return { content: [{ type: 'text', text: JSON.stringify({ providers: [], context: {} }, null, 2) }] }
      }
      const collected = await context.collect(passport_id, { providers, limit })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            providers: providers ?? context.names?.() ?? Object.keys(collected),
            context:   collected,
          }, null, 2),
        }],
      }
    },
  )

  tool('whitebox.forget',
    'GDPR forget — deletes all awareness exposures + orphan chunks for a passport. Cascades through every channel. Irreversible. Use with caution from an LLM context; consider gating on a separate confirmation tool call in production.',
    {
      passport_id: z.string().uuid(),
    },
    'analytics:write',
    async ({ passport_id }) => {
      const deleted = await awareness.forget({ passport_id })
      return { content: [{ type: 'text', text: `Forgot passport ${passport_id} — ${deleted} exposure(s) deleted` }] }
    },
  )
}
