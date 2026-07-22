// Thin client for server-plugin-oauth's users:manage-gated management routes.
// Calls go to /api/oauth/* (the dev proxy strips /api → the server's
// /oauth/* surface). Auth is the logged-in user's session token, scoped by
// their granted permissions at login/refresh — see server-plugin-oauth's
// README on why that's safe to trust without a per-request DB re-check.
import { createClient } from '../../shell/apiClient'

const req = createClient('/api/oauth')

export const usersClient = {
  list: () => req('/users'),
  invite: (email: string) => req('/users/invite', { method: 'POST', body: JSON.stringify({ email }) }),
  resendInvite: (id: string) => req(`/users/${id}/resend-invite`, { method: 'POST' }),
  remove: (id: string) => req(`/users/${id}`, { method: 'DELETE' }),
  catalog: () => req('/permissions/catalog'),
  setPermissions: (id: string, permissions: string[]) =>
    req(`/users/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
  updateProfile: (id: string, fields: { first_name?: string; last_name?: string; phone?: string; email?: string }) =>
    req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  logins: (id: string) => req(`/users/${id}/logins`),
  // Self-service only — the server independently enforces id === the
  // caller's own subject regardless of what this UI shows.
  changePassword: (id: string, currentPassword: string, newPassword: string) =>
    req(`/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }),
}
