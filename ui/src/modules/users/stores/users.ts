// Users data store. Thin orchestration over the users HTTP client — same
// shape as the campaigns/audiences stores.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usersClient as client } from '../users'

export const useUsersStore = defineStore('users', () => {
  const users = ref<any[]>([])
  const error = ref('')

  async function loadUsers() {
    try { users.value = await client.list() } catch (e: any) { error.value = e.message }
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

  return { users, error, loadUsers, inviteUser, resendInvite, removeUser }
})
