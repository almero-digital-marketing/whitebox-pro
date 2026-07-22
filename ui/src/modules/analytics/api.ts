// Thin client for the analytics plugin's composition surface. Calls go to
// /api/analytics/* — the dev proxy strips /api and forwards to the server's
// /analytics/* surface. The /api prefix keeps the API off the client routes
// (/analytics is now a page, not the API). Auth is the logged-in user's session
// token (see shell/apiClient.ts) — every module shares the same authenticated client.

import { createClient } from '../../shell/apiClient'

const req = createClient('/api/analytics')

export const api = {
  listReports: () => req('/reports'),
  getReport: (id: string) => req(`/reports/${id}`),
  createReport: (name: string) => req('/reports', { method: 'POST', body: JSON.stringify({ name }) }),
  updateReport: (id: string, patch: any) => req(`/reports/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteReport: (id: string) => req(`/reports/${id}`, { method: 'DELETE' }),
  resolveWidget: (id: string) => req(`/widgets/${id}/resolve`, { method: 'POST', body: '{}' }),
  addWidget: (reportId: string, w: any) => req(`/reports/${reportId}/widgets`, { method: 'POST', body: JSON.stringify(w) }),
  updateWidget: (id: string, patch: any) => req(`/widgets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWidget: (id: string) => req(`/widgets/${id}`, { method: 'DELETE' }),
  reorderWidgets: (reportId: string, order: string[]) =>
    req(`/reports/${reportId}/reorder`, { method: 'PATCH', body: JSON.stringify({ order }) }),
  resolve: (query: any) => req('/resolve', { method: 'POST', body: JSON.stringify(query) }),
  describe: (query: any) => req('/describe', { method: 'POST', body: JSON.stringify({ query }) }),
  explain: (payload: { id?: string; title: string; kind: string; data: any }) => req('/explain', { method: 'POST', body: JSON.stringify(payload) }),
  personInsight: (id: string, body: { label?: string; context?: string }) =>
    req(`/people/${id}/insight`, { method: 'POST', body: JSON.stringify(body || {}) }),
  widgetSummary: (id: string) => req(`/widgets/${id}/summary`, { method: 'POST', body: '{}' }),
  suggestions: (reportId?: string) => req(`/suggestions${reportId ? `?report_id=${encodeURIComponent(reportId)}` : ''}`),
  schema: () => req('/schema'),
  compose: (question: string, reportId?: string) =>
    req('/compose', { method: 'POST', body: JSON.stringify({ question, report_id: reportId }) }),
}
