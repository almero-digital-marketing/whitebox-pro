// MCP tools for the composition surface (reports/widgets) — the backend for the
// three-pane analytics console. Separate from the top-level ../mcp.js, which
// covers the awareness-query tools (whitebox.ask, recall, …); this file mirrors
// composition/routes.js instead, reusing its exported runQuery/enrichPeople/
// composeReport/widgetSummary/compactForExplain so REST and MCP run the exact
// same logic.
//
// Each tool also carries the matching analytics:read/analytics:write scope —
// the endpoint-level mcp:use gate only answers "can this token use MCP at
// all"; these make sure a token without analytics:write can't persist a
// mutation just because it can reach the endpoint. Same split as routes.js.

import { z } from 'zod'
import * as store from './store.js'
import * as compose from './compose.js'
import { runQuery, enrichPeople, composeReport, widgetSummary, compactForExplain, KINDS } from './routes.js'
import { CONTACT_KEYS } from './mask.js'

export function registerMcp(ctx, { selector, awareness, passports, logger }) {
  if (!ctx.mcp) return
  const deps = { selector, awareness }
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (scope) => (name, description, inputSchema, handler) =>
    ctx.mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(args)) })
  const read = tool('analytics:read')
  const write = tool('analytics:write')

  // --- inspect ---
  read('analytics_list_reports', 'List all saved reports (newest first), each with its widget_count.', {}, () => store.listReports())
  read('analytics_get_report', 'Get one report with its widgets.', { id: z.string() }, async ({ id }) => {
    const report = await store.getReport(id)
    if (!report) { const e = new Error('report not found'); e.status = 404; throw e }
    return report
  })
  read('analytics_schema', 'The queryable vocabulary — fact keys (+ sample values), event actions, event attributes, campaigns, sources, channels. Ground a query in real keys before composing one.', { refresh: z.boolean().optional() }, ({ refresh }) => compose.discoverSchema({ refresh }))
  read('analytics_suggest_questions', 'Suggested starter/follow-up questions for a report (the compose box "Try one:" chips) — grounded in its existing widgets, its name, or just the data vocabulary if neither.', { report_id: z.string().optional() }, async ({ report_id }) => {
    let name = '', widgets = []
    if (report_id) {
      const report = await store.getReport(report_id)
      if (report) { name = report.name || ''; widgets = (report.widgets || []).map(w => ({ title: w.title, kind: w.kind })) }
    }
    return { suggestions: await compose.suggestQuestions({ name, widgets }) }
  })

  // --- author (AI-native) ---
  write('analytics_compose', 'The "just ask" loop: turn a plain-language question into 1-4 widgets, validate each by actually resolving it (a widget the selector rejects is dropped, never saved), and persist them into a report. Pass an existing report_id to add to it, or omit to create a new one. This PERSISTS — use analytics_resolve first to try a query without saving.', { question: z.string(), report_id: z.string().optional() }, ({ question, report_id }) => composeReport({ ...deps, passports, logger }, { question, report_id }))
  read('analytics_describe_query', 'The inverse of compose: a query def (JSON) → one plain-language question a marketer would ask. Never persists.', { query: z.any() }, ({ query }) => compose.describeQuery(query).then(summary => ({ summary })))
  read('analytics_widget_summary', 'The AI\'s plain-language reading of a saved widget\'s query. Generated lazily on first call and persisted — the AI runs once per query version, not on every view.', { id: z.string() }, ({ id }) => widgetSummary(logger, id))
  read('analytics_explain_widget', 'Resolve a saved widget and turn its result into a 1-2 sentence opportunity/insight (the co-pilot reading the Reports UI shows) — the cohort worth targeting, the leak to plug, which series leads, progress toward a target. Not cached (unlike the REST /explain endpoint, which the frontend uses for repeated identical requests).', { id: z.string() }, async ({ id }) => {
    const w = await store.getWidget(id)
    if (!w) { const e = new Error('widget not found'); e.status = 404; throw e }
    if (w.kind === 'answer') return { explanation: null }
    let data = await runQuery(deps, w.query)
    if (w.kind === 'table') { try { data = await enrichPeople(data, passports) } catch { /* keep raw */ } }
    const explanation = await compose.explainWidget({ title: w.title, kind: w.kind, data: compactForExplain(w.kind, data) })
    return { explanation }
  })
  read('analytics_person_insight', 'A 1-2 sentence profile of ONE customer (lifecycle status, lifetime value, recent engagement) — the insight shown when a client is selected in a list widget.', { passport_id: z.string(), context: z.string().optional() }, async ({ passport_id, context }) => {
    const [facts, activity] = await Promise.all([store.personFacts(passport_id), store.personActivity(passport_id)])
    const safeFacts = Object.fromEntries(Object.entries(facts).filter(([k]) => !CONTACT_KEYS.has(k)))   // PII boundary: never prompt a raw contact identifier
    const who = safeFacts.full_name || passport_id.slice(0, 8)
    return { explanation: await compose.explainPerson({ who, facts: safeFacts, activity, context }) }
  })

  // --- resolve (live preview / persisted widgets) ---
  const kindEnum = z.enum([...KINDS])
  read('analytics_resolve', 'Run an INLINE query def — a live preview, no persistence. Same query-def grammar as a widget (selector / group / funnel / distribution / scatter / cohort / breakdownFact / question / series / splitBy) — see analytics_schema for real keys.', { query: z.any(), kind: kindEnum.optional() }, async ({ query, kind }) => {
    let data = await runQuery(deps, query || {})
    if (kind === 'table') data = await enrichPeople(data, passports)
    return data
  })
  read('analytics_widget_resolve', 'Run a persisted widget\'s stored query and return fresh data.', { id: z.string() }, async ({ id }) => {
    const w = await store.getWidget(id)
    if (!w) { const e = new Error('widget not found'); e.status = 404; throw e }
    let data = await runQuery(deps, w.query)
    if (w.kind === 'table') data = await enrichPeople(data, passports)
    return data
  })

  // --- act (guarded — persists) ---
  write('analytics_create_report', 'Create an empty report.', { name: z.string(), layout: z.any().optional() }, ({ name, layout }) => store.createReport({ name, layout }))
  write('analytics_update_report', 'Rename a report or update its saved grid layout.', { id: z.string(), name: z.string().optional(), layout: z.any().optional() }, ({ id, ...patch }) => store.updateReport(id, patch).then(row => { if (!row) { const e = new Error('report not found'); e.status = 404; throw e } return row }))
  write('analytics_delete_report', 'Delete a report (cascades its widgets).', { id: z.string() }, ({ id }) => store.deleteReport(id).then(deleted => ({ deleted })))
  write('analytics_add_widget', `Add a widget to a report. kind must be one of: ${[...KINDS].join(', ')}. query is the query-def grammar (see analytics_schema/analytics_describe_query).`, { report_id: z.string(), kind: kindEnum, query: z.any(), title: z.string().optional(), presentation: z.any().optional(), position: z.any().optional() }, async ({ report_id, ...w }) => {
    const report = await store.getReport(report_id)
    if (!report) { const e = new Error('report not found'); e.status = 404; throw e }
    return store.addWidget(report_id, w)
  })
  write('analytics_update_widget', 'Partially update a saved widget. Changing `query` or `kind` clears the cached AI summary (it re-generates on next view) and triggers a live re-resolve for connected viewers.', { id: z.string(), title: z.string().optional(), kind: kindEnum.optional(), query: z.any().optional(), presentation: z.any().optional(), position: z.any().optional(), sort: z.number().optional() }, ({ id, ...patch }) => store.updateWidget(id, patch).then(row => { if (!row) { const e = new Error('widget not found'); e.status = 404; throw e } return row }))
  write('analytics_delete_widget', 'Delete a widget.', { id: z.string() }, ({ id }) => store.deleteWidget(id).then(deleted => ({ deleted })))
  write('analytics_reorder_widgets', 'Reorder a report\'s widgets to match the given id order.', { report_id: z.string(), order: z.array(z.string()) }, ({ report_id, order }) => store.reorderWidgets(report_id, order).then(() => ({ ok: true })))

  logger?.info?.('Analytics: composition MCP tools registered')
}
