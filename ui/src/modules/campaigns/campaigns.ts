// Thin client for the campaigns plugin. Calls go to /api/campaigns/* (the dev proxy strips
// /api → the server's /campaigns/* surface). Auth is the logged-in user's session token
// (see shell/apiClient.ts) — every module shares the same authenticated client.

import { createClient } from '../../shell/apiClient'

const req = createClient('/campaigns')

// Every rail asks the same question — a page of rows matching a term — so the
// query string is built the same way everywhere. Empty values are dropped so a
// blank search doesn't become `?q=`.
const pageQs = (o: { q?: string; limit?: number; offset?: number } = {}) => {
  const s = new URLSearchParams()
  if (o.q?.trim()) s.set('q', o.q.trim())
  if (o.limit != null) s.set('limit', String(o.limit))
  if (o.offset) s.set('offset', String(o.offset))
  const out = s.toString()
  return out ? `?${out}` : ''
}
export type Paged<T> = { total: number; rows: T[] }

export const campaignsClient = {
  list: (o?: { q?: string; limit?: number; offset?: number }) =>
    req(pageQs(o)) as Promise<Paged<any>>,
  get: (id: string) => req(`/${id}`),
  create: (body: { name: string; channel: 'email' | 'sms'; message?: any }) =>
    req('', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: any) => req(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => req(`/${id}`, { method: 'DELETE' }),
  attachAudience: (id: string, audienceId: string) =>
    req(`/${id}/audiences`, { method: 'POST', body: JSON.stringify({ audience_id: audienceId }) }),
  detachAudience: (id: string, audienceId: string) =>
    req(`/${id}/audiences/${audienceId}`, { method: 'DELETE' }),
  previewDelivery: (id: string) => req(`/${id}/delivery/preview`, { method: 'POST', body: '{}' }),
  schedule: (id: string, counts?: any) => req(`/${id}/schedule`, { method: 'POST', body: JSON.stringify({ counts }) }),
  sendManual: (id: string, counts?: any) => req(`/${id}/send`, { method: 'POST', body: JSON.stringify({ counts }) }),
  // what actually happened: pre-flight reach + the per-channel delivery funnel
  results: (id: string) => req(`/${id}/results`),
  unlock: (id: string) => req(`/${id}/unlock`, { method: 'POST', body: '{}' }),
  setReport: (id: string, reportId: string) =>
    req(`/${id}/report`, { method: 'POST', body: JSON.stringify({ report_id: reportId }) }),
  activateForPassport: (id: string, passportId: string, idempotencyKey?: string) =>
    req(`/${id}/activate`, { method: 'POST', body: JSON.stringify({ passport_id: passportId, idempotency_key: idempotencyKey }) }),
}
