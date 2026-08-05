// Thin client for server-plugin-oauth's users:manage-gated management routes.
// Calls go to /api/oauth/* (the dev proxy strips /api → the server's
// /oauth/* surface). Auth is the logged-in user's session token, scoped by
// their granted permissions at login/refresh — see server-plugin-oauth's
// README on why that's safe to trust without a per-request DB re-check.
import { createClient } from '../../shell/apiClient'

const req = createClient('/oauth')

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

export const usersClient = {
  list: (o?: { q?: string; limit?: number; offset?: number }) =>
    req(`/users${pageQs(o)}`) as Promise<Paged<any>>,
  invite: (email: string) => req('/users/invite', { method: 'POST', body: JSON.stringify({ email }) }),
  resendInvite: (id: string) => req(`/users/${id}/resend-invite`, { method: 'POST' }),
  remove: (id: string) => req(`/users/${id}`, { method: 'DELETE' }),
  catalog: () => req('/permissions/catalog'),
  setPermissions: (id: string, permissions: string[]) =>
    req(`/users/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
  updateProfile: (id: string, fields: { first_name?: string; last_name?: string; phone?: string; email?: string }) =>
    req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  logins: (id: string) => req(`/users/${id}/logins`),
  // Which agents this user has connected, and cutting one off. The (user, client) PAIR is the
  // unit: revoking a client outright would sign out every other user of it — including everyone
  // sharing the CLI client — and revoking a user outright would take their console session too.
  agents: (id: string) => req(`/users/${id}/agents`) as Promise<any[]>,
  revokeAgent: (id: string, clientId: string) =>
    req(`/users/${id}/agents/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  // The server's own MCP client config — the same bytes a user can curl straight into
  // `claude mcp add-json`. Fetched rather than assembled here so the console cannot disagree
  // with the server about its own URL or client id. 404s when MCP isn't mounted, which is
  // exactly the signal to hide the block.
  mcpSetup: () => req('/mcp-setup.json') as Promise<{ type: string; url: string; oauth: { clientId: string } }>,
  // Self-service only — the server independently enforces id === the
  // caller's own subject regardless of what this UI shows.
  changePassword: (id: string, currentPassword: string, newPassword: string) =>
    req(`/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }),
}
