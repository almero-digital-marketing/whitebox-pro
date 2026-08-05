// Users data store. Thin orchestration over the users HTTP client — same
// shape as the campaigns/audiences stores.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usersClient as client } from '../users'
import { useRailPage } from '../../../components/useRailPage'
import { notifyError } from '../../../shell/toast'

export const useUsersStore = defineStore('users', () => {
  // The full team, for anything that needs all of it at once. Capped — see the
  // campaigns store.
  const CATALOGUE_MAX = 500
  const users = ref<any[]>([])
  // The rail: a real server query with its own page.
  const rail = useRailPage<any>(o => client.list(o), { subject: 'users' })
  const catalog = ref<any[]>([])   // [{ module, items: [{key,label,description}], defaults }]
  const logins = ref<any[]>([])   // the currently-selected user's login history, newest first
  // The server's own MCP client config, or null when MCP isn't mounted. Deployment-wide, not
  // per-user, so it is loaded once rather than per selection.
  const mcpSetup = ref<{ type: string; url: string; oauth: { clientId: string } } | null>(null)
  const error = ref('')

  async function loadUsers() {
    try { users.value = (await client.list({ limit: CATALOGUE_MAX })).rows } catch (e: any) { error.value = e.message; notifyError(`Couldn't load users: ${e.message}`) }
  }

  async function loadCatalog() {
    try { catalog.value = await client.catalog() } catch (e: any) { error.value = e.message; notifyError(`Couldn't load the permissions catalog: ${e.message}`) }
  }

  // No notifyError, unlike every other loader here: a missing endpoint is the normal state
  // for a deployment without MCP, and the UI's response is to hide the block — not to tell
  // an operator something failed.
  async function loadMcpSetup() {
    try { mcpSetup.value = await client.mcpSetup() } catch { mcpSetup.value = null }
  }

  async function loadLogins(id: string) {
    logins.value = []   // clear the previous user's rows so a failure below can't leave them showing under this one
    try { logins.value = await client.logins(id) } catch (e: any) { error.value = e.message; notifyError(`Couldn't load login history: ${e.message}`) }
  }

  function upsertLocal(row: any) {
    if (!row?.id) return
    const i = users.value.findIndex((u) => u.id === row.id)
    if (i >= 0) users.value = users.value.map((u) => (u.id === row.id ? { ...u, ...row } : u))
    else users.value = [...users.value, row]
  }

  async function inviteUser(email: string) {
    const row = await client.invite(email)
    upsertLocal(row)
    return row
  }
  async function resendInvite(id: string) {
    const row = await client.resendInvite(id)
    upsertLocal(row)
    return row
  }
  async function removeUser(id: string) {
    await client.remove(id)
    users.value = users.value.filter((u) => u.id !== id)
  }
  async function setPermissions(id: string, permissions: string[]) {
    const row = await client.setPermissions(id, permissions)
    upsertLocal(row)
    return row
  }
  async function updateProfile(id: string, fields: Record<string, any>) {
    const row = await client.updateProfile(id, fields)
    upsertLocal(row)
    return row
  }
  // No row to upsert — password isn't part of a user's displayed profile.
  async function changePassword(id: string, currentPassword: string, newPassword: string) {
    await client.changePassword(id, currentPassword, newPassword)
  }

  return {
    rows: rail.rows, total: rail.total, page: rail.page, q: rail.q, railLoading: rail.loading,
    pageSize: rail.pageSize, searchUsers: rail.search, goToPage: rail.goToPage, refreshRail: rail.refresh,
    users, catalog, logins, mcpSetup, error,
    loadUsers, loadCatalog, loadLogins, loadMcpSetup, inviteUser, resendInvite, removeUser, setPermissions, updateProfile, changePassword,
  }
})
