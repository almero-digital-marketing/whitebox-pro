// Users data store. Thin orchestration over the users HTTP client — same
// shape as the campaigns/audiences stores.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usersClient as client } from '../users'
import { notifyError } from '../../../shell/toast'

export const useUsersStore = defineStore('users', () => {
  const users = ref<any[]>([])
  const catalog = ref<any[]>([])   // [{ module, items: [{key,label,description}], defaults }]
  const logins = ref<any[]>([])   // the currently-selected user's login history, newest first
  const error = ref('')

  async function loadUsers() {
    try { users.value = await client.list() } catch (e: any) { error.value = e.message; notifyError(`Couldn't load users: ${e.message}`) }
  }

  async function loadCatalog() {
    try { catalog.value = await client.catalog() } catch (e: any) { error.value = e.message; notifyError(`Couldn't load the permissions catalog: ${e.message}`) }
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
    users, catalog, logins, error,
    loadUsers, loadCatalog, loadLogins, inviteUser, resendInvite, removeUser, setPermissions, updateProfile, changePassword,
  }
})
