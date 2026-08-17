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
import { renderChart } from './chart-render.js'

export function registerMcp(ctx, { selector, awareness, passports, facts, logger }) {
  if (!ctx.mcp) return
  const deps = { selector, awareness, facts }
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })

  // Structured arguments arrive as JSON STRINGS from some MCP clients.
  //
  // `query`, `layout`, `presentation` and `position` are all declared z.any(),
  // and a client that serialises them hands us '{"selector":{...}}' rather than
  // the object. Nothing then throws: runQuery reads `q.selector` off a string,
  // gets undefined, and falls through to an unfiltered resolve — so
  // analytics_resolve answered every question with the ENTIRE population, and
  // add_widget persisted the string, saving a widget that would do the same on
  // every view forever after. A chart confidently reporting 153,000 people is
  // worse than one that errors.
  //
  // Parsed here, once, rather than in eight handlers. A string that is not JSON
  // is passed through untouched — `question` is legitimately a string, and so is
  // anything a future tool takes.
  const parsed = (v) => {
    if (typeof v !== 'string') return v
    const s = v.trim()
    if (!s.startsWith('{') && !s.startsWith('[')) return v
    try { return JSON.parse(s) } catch { return v }
  }
  const STRUCTURED = ['query', 'layout', 'presentation', 'position', 'scope']
  const coerce = (args = {}) => {
    const out = { ...args }
    for (const k of STRUCTURED) if (k in out) out[k] = parsed(out[k])
    return out
  }

  const tool = (scope) => (name, description, inputSchema, handler) =>
    ctx.mcp.tool({ name, description, inputSchema, scope, handler: async (args) => ok(await handler(coerce(args))) })
  const read = tool('analytics:read')
  const write = tool('analytics:write')

  // The chart tools answer with TWO content blocks, so they cannot go through
  // `tool` above — its ok() wraps whatever the handler returns in a single text
  // block. This one lets a handler build the content array itself.
  const readBlocks = (name, description, inputSchema, handler) =>
    ctx.mcp.tool({ name, description, inputSchema, scope: 'analytics:read', handler: async (args) => handler(coerce(args)) })

  // Figures first, picture second — and the order is the point.
  //
  // A client that cannot render the image still receives the numbers, so the
  // tool degrades to analytics_resolve rather than to nothing. That falls out
  // of MCP's content model instead of needing a fallback path.
  //
  // A chart is an ADDITION to the data, never a replacement: a kind with no
  // chart (stat, table) and a query that resolved empty both return the text
  // block alone.
  //
  // PNG, not the SVG this is rasterised from. An SVG image block was tried
  // against a real client and stored as a FILE rather than drawn — which is the
  // one outcome the image block exists to avoid. Mail clients are worse. So the
  // format that renders everywhere wins, and the SVG stays an internal step.
  const chartBlocks = (data, chart) => ({
    content: [
      { type: 'text', text: JSON.stringify(data, null, 2) },
      ...(chart?.png ? [{ type: 'image', data: chart.png.toString('base64'), mimeType: 'image/png' }] : []),
    ],
  })

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
    let data = await runQuery(deps, w.query, w.kind)
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
    let data = await runQuery(deps, query || {}, kind)
    if (kind === 'table') data = await enrichPeople(data, passports)
    return data
  })
  read('analytics_widget_resolve', 'Run a persisted widget\'s stored query and return fresh data.', { id: z.string() }, async ({ id }) => {
    const w = await store.getWidget(id)
    if (!w) { const e = new Error('widget not found'); e.status = 404; throw e }
    let data = await runQuery(deps, w.query, w.kind)
    if (w.kind === 'table') data = await enrichPeople(data, passports)
    return data
  })

  // --- draw (the same two resolves, plus a picture) ---
  //
  // Deliberately separate tools rather than a flag on the resolves. A caller
  // that wants numbers should not pay for a render, and a caller that wants to
  // LOOK at twelve months of anything should not have to read them as JSON —
  // which is the case these exist for. A timeseries, a cohort grid or a funnel
  // is close to unreadable as text and immediate as a shape.
  //
  // The image is SVG. Whether a given client renders an SVG image block is not
  // something to guess at, and it is the only open question left in this
  // pipeline: the figures always arrive either way, and PNG (via a rasterizer)
  // is the answer if the answer turns out to be no.
  const chartSize = { width: z.number().optional(), height: z.number().optional() }
  readBlocks('analytics_chart', 'Run an INLINE query def and return its figures AND a rendered chart image. Same grammar and kinds as analytics_resolve — use that one when you only need the numbers. Kinds with no chart (stat, table, pivot, answer) return the figures alone.', { query: z.any(), kind: kindEnum.optional(), ...chartSize }, async ({ query, kind, width, height }) => {
    const q = query || {}
    const data = await runQuery(deps, q, kind)
    return chartBlocks(data, renderChart(kind, data, { width, height, stack: q.stack, png: true }))
  })
  readBlocks('analytics_widget_chart', 'Run a persisted widget\'s stored query and return its figures AND a rendered chart image, drawn the way the app draws it.', { id: z.string(), ...chartSize }, async ({ id, width, height }) => {
    const w = await store.getWidget(id)
    if (!w) { const e = new Error('widget not found'); e.status = 404; throw e }
    const data = await runQuery(deps, w.query, w.kind)
    return chartBlocks(data, renderChart(w.kind, data, { width, height, stack: w.query?.stack, png: true }))
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
