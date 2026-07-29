// Thin client for the audiences plugin. Calls go to /api/audiences/* (the dev proxy
// strips /api → the server's /audiences/* surface). Auth is the logged-in user's
// session token (see shell/apiClient.ts) — every module shares the same authenticated client.

import { createClient } from '../../shell/apiClient'

const req = createClient('/api/audiences')

// A segment `source` is the rule-shaped predicate: { select } | { funnel, slot, status }.
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

export const audiences = {
  // size of an unsaved source (the chip's "~N people"), reusing the engine preview
  previewSegment: (source: any) => req('/segments/preview', { method: 'POST', body: JSON.stringify({ source }) }),
  // persist (dedups on the source predicate; names with the AI if no name given). The
  // chip names itself deterministically ("<title>: <label>"); the server /segments/name
  // AI endpoint stays as the no-name-supplied fallback inside saveSegment.
  saveSegment: (body: { source: any; name?: string; origin?: any; context?: any }) =>
    req('/segments', { method: 'POST', body: JSON.stringify(body) }),
  listSegments: () => req('/segments'),
  getSegment: (id: string) => req(`/segments/${id}`),
  renameSegment: (id: string, name: string) => req(`/segments/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteSegment: (id: string) => req(`/segments/${id}`, { method: 'DELETE' }),
  segmentMembers: (id: string) => req(`/segments/${id}/members`),

  // audiences — boolean compositions of segments. rule = { op:'all'|'any', members:[{segment,negate?}] }
  // paged: `{ total, rows }`. Pass a big limit for the picker catalogues in
  // Campaigns and Journeys, which need every option rather than a page.
  listAudiences: (o?: { q?: string; limit?: number; offset?: number }) =>
    req(`/audiences${pageQs(o)}`) as Promise<Paged<any>>,
  // CAPI adapters the server actually has configured (name + eligible). Drives whether a
  // network shows a live delivery toggle or a "Connect" prompt — no silent dry-run.
  listNetworks: () => req('/networks'),
  previewAudience: (rule: any) => req('/audiences/preview', { method: 'POST', body: JSON.stringify({ rule }) }),
  // AI name for an unsaved rule — used to auto-name until the user types their own.
  nameAudience: (rule: any) => req('/audiences/name', { method: 'POST', body: JSON.stringify({ rule }) }),
  saveAudience: (body: { id?: string; name?: string; rule: any; delivery?: any }) =>
    req('/audiences', { method: 'POST', body: JSON.stringify(body) }),
  getAudience: (id: string) => req(`/audiences/${id}`),
  deleteAudience: (id: string) => req(`/audiences/${id}`, { method: 'DELETE' }),
  audienceMembers: (id: string) => req(`/audiences/${id}/members`),

  // delivery: preview the deliverable cohort (after suppression + consent), then turn a
  // network on/off. The send only runs on enable, after the UI's explicit confirm.
  previewDelivery: (id: string) => req(`/audiences/${id}/delivery/preview`, { method: 'POST', body: '{}' }),
  setDelivery: (id: string, network: string, enabled: boolean) =>
    req(`/audiences/${id}/delivery`, { method: 'POST', body: JSON.stringify({ network, enabled }) }),
  // expose / hide an audience to the client side (on-site membership lookup) — immediate, no send
  setClientSide: (id: string, enabled: boolean) =>
    req(`/audiences/${id}/client-side`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // make an audience available to the Campaigns module (email & SMS) — immediate, no send
  setCampaigns: (id: string, enabled: boolean) =>
    req(`/audiences/${id}/campaigns`, { method: 'POST', body: JSON.stringify({ enabled }) }),
}
