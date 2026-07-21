// Users data store. Thin orchestration over the users HTTP client — same
// shape as the campaigns/audiences stores.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usersClient as client } from '../users'

export const useUsersStore = defineStore('users', () => {
  const users = ref<any[]>([])
  const catalog = ref<any[]>([])   // [{ module, items: [{key,label,description}], defaults }]
  const logins = ref<any[]>([])   // the currently-selected user's login history, newest first
  const error = ref('')

  async function loadUsers() {
    try { users.value = await client.list() } catch (e: any) { error.value = e.message }
  }

  async function loadCatalog() {
    try { catalog.value = await client.catalog() } catch (e: any) { error.value = e.message }
  }

  async function loadLogins(id: string) {
    try { logins.value = await client.logins(id) } catch (e: any) { error.value = e.message }
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

  return { users, catalog, logins, error, loadUsers, loadCatalog, loadLogins, inviteUser, resendInvite, removeUser, setPermissions, updateProfile }
})
