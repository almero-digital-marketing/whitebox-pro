// Thin client for the campaigns plugin. Calls go to /api/campaigns/* (the dev proxy strips
// /api → the server's /campaigns/* surface). Auth is the logged-in user's session token
// (see shell/apiClient.ts) — every module shares the same authenticated client.

import { createClient } from '../../shell/apiClient'

const req = createClient('/api/campaigns')

export const campaignsClient = {
  list: () => req(''),
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
  unlock: (id: string) => req(`/${id}/unlock`, { method: 'POST', body: '{}' }),
  setReport: (id: string, reportId: string) =>
    req(`/${id}/report`, { method: 'POST', body: JSON.stringify({ report_id: reportId }) }),
}
