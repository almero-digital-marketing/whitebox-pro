// Thin client for server-plugin-oauth's admin-gated user-management routes.
// Calls go to /api/oauth/* (the dev proxy strips /api → the server's
// /oauth/* surface). Auth is the logged-in user's session token — the
// server re-checks is_admin on every request regardless of what this client
// sends, so there's nothing role-shaped to configure here.
import { createClient } from '../../shell/apiClient'

const req = createClient('/api/oauth')

export const usersClient = {
  list: () => req('/users'),
  invite: (email: string) => req('/users/invite', { method: 'POST', body: JSON.stringify({ email }) }),
  resendInvite: (id: string) => req(`/users/${id}/resend-invite`, { method: 'POST' }),
  remove: (id: string) => req(`/users/${id}`, { method: 'DELETE' }),
}
