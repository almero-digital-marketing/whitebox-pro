// Thin client for the journeys plugin. Calls go to /api/journeys/* (the dev proxy strips
// /api → the server's /journeys/* surface). Auth is the logged-in user's session token
// (see shell/apiClient.ts) — every module shares the same authenticated client.

import { createClient } from '../../shell/apiClient'

const req = createClient('/api/journeys')
// The event registry is core-mounted (not under /journeys) — a rolling,
// retention-pruned list of recently-observed event `type` strings across
// the whole app, not just journeys. See server/src/event-registry.
const eventsReq = createClient('/api/events')

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

export const journeysClient = {
  list: (o?: { q?: string; limit?: number; offset?: number }) =>
    req(pageQs(o)) as Promise<Paged<any>>,
  get: (id: string) => req(`/${id}`),
  create: (body: { name: string; trigger: any; steps: any; dedupe?: any }) =>
    req('', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: any) => req(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => req(`/${id}`, { method: 'DELETE' }),
  activate: (id: string) => req(`/${id}/activate`, { method: 'POST', body: '{}' }),
  pause: (id: string) => req(`/${id}/pause`, { method: 'POST', body: '{}' }),
  enroll: (id: string, passportId: string) =>
    req(`/${id}/enroll`, { method: 'POST', body: JSON.stringify({ passport_id: passportId }) }),
  listEnrollments: (id: string, status?: string) =>
    req(`/${id}/enrollments${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  stepCounts: (id: string) => req(`/${id}/step-counts`),
  // did it work — enrollment funnel + goal conversion + what the channels did
  results: (id: string) => req(`/${id}/results`),
  getEnrollment: (enrollmentId: string) => req(`/enrollments/${enrollmentId}`),
  exitEnrollment: (enrollmentId: string, reason?: string) =>
    req(`/enrollments/${enrollmentId}/exit`, { method: 'POST', body: JSON.stringify({ reason }) }),
  eventsRegistry: () => eventsReq('/registry'),
}
