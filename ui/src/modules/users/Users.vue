<script setup lang="ts">
// Users module — admin-only (see shell/modules.ts's adminOnly + App.vue's filter;
// the server independently re-checks is_admin on every request regardless).
// No role to assign here by design (see server-plugin-oauth's README) — just
// invite, resend, and remove. Same rail + detail-pane shape as Campaigns/Audiences.
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import RailSearch from '../../components/RailSearch.vue'
import { useUsersStore } from './stores/users'
import { useAuthStore } from '../../shell/stores/auth'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useUsersStore()
const authStore = useAuthStore()
const { users } = storeToRefs(store)

const q = ref('')
const filteredUsers = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? users.value.filter((u: any) => u.email.toLowerCase().includes(s)) : users.value
})

const working = ref<any>(null)      // the selected user row, or null
const inviting = ref(false)         // + New draft mode
const inviteEmail = ref('')
const saving = ref(false)
const error = ref('')
const justInvited = ref<any>(null)  // the just-created/resent invite response — the inviteUrl is
                                     // shown once so an admin can share it manually if the email didn't land

onActivated(async () => {
  await store.loadUsers()
  applyRoute()
})

function applyRoute() {
  if (route.name !== 'users') return
  const id = paramStr(route.params.userId)
  if (!id) { working.value = null; return }
  inviting.value = false
  working.value = users.value.find((u: any) => u.id === id) || null
}
watch([() => route.params.userId, users], applyRoute, { immediate: true })
function goUser(id: string) { router.push({ name: 'users', params: { userId: id } }) }

function startInvite() {
  inviting.value = true
  inviteEmail.value = ''
  error.value = ''
  router.push({ name: 'users', params: {} })
}

async function submitInvite() {
  const email = inviteEmail.value.trim()
  if (!email || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const row = await store.inviteUser(email)
    justInvited.value = row
    inviting.value = false
    goUser(row.id)
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function resend(u: any) {
  saving.value = true
  try { justInvited.value = await store.resendInvite(u.id) }
  finally { saving.value = false }
}

function remove(u: any) {
  confirm.require({
    header: 'Remove user', message: `Remove ${u.email}? They will lose access immediately.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Remove', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      const open = working.value?.id === u.id
      await store.removeUser(u.id)
      if (open) { working.value = null; router.replace({ name: 'users', params: {} }) }
    },
  })
}

function fmtDate(iso?: string) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}
</script>

<template>
  <div class="usr-console">
    <aside class="usr-left">
      <div class="pane-head">Users <Button icon="pi pi-plus" text rounded size="small" aria-label="Invite user" @click="startInvite" /></div>
      <ul class="rail-list">
        <li v-for="u in filteredUsers" :key="u.id" class="rail-item" :class="{ on: u.id === working?.id }" @click="goUser(u.id)">
          <div class="ri-main">
            <span class="ri-name">{{ u.email }}</span>
            <span class="ri-sub">
              <span v-if="u.is_admin" class="badge admin">Admin</span>
              <span class="badge" :class="u.active ? 'active' : 'pending'">{{ u.active ? 'Active' : 'Pending' }}</span>
            </span>
          </div>
        </li>
        <li v-if="!filteredUsers.length" class="rail-empty">{{ q ? 'No matches.' : 'No users yet — invite one with +' }}</li>
      </ul>
      <RailSearch v-model="q" placeholder="Search users" />
    </aside>

    <section class="usr-center">
      <div v-if="inviting" class="panel">
        <div class="panel-head">Invite a teammate</div>
        <p class="tip">They'll get an email with a link to set their password. There's no role to assign — every signed-in user has the same access, except admins, who can also manage the team.</p>
        <InputText v-model="inviteEmail" class="email-input" placeholder="email@example.com" @keyup.enter="submitInvite" />
        <p v-if="error" class="err">{{ error }}</p>
        <div class="actions">
          <Button label="Cancel" text severity="secondary" size="small" @click="inviting = false" />
          <Button label="Send invite" icon="pi pi-send" size="small" :loading="saving" @click="submitInvite" />
        </div>
      </div>

      <div v-else-if="working" class="panel">
        <div class="panel-head">{{ working.email }} <span v-if="working.is_admin" class="badge admin">Admin</span></div>
        <dl class="meta">
          <div><dt>Status</dt><dd>{{ working.active ? 'Active' : 'Invite pending' }}</dd></div>
          <div><dt>Invited</dt><dd>{{ fmtDate(working.invited_at) }}</dd></div>
          <div><dt>Joined</dt><dd>{{ fmtDate(working.created_at) }}</dd></div>
        </dl>

        <div v-if="justInvited?.id === working.id && justInvited.inviteUrl" class="invite-link">
          <p class="tip">Share this link if the invite email didn't arrive:</p>
          <code class="link-box">{{ justInvited.inviteUrl }}</code>
        </div>

        <div class="actions">
          <Button v-if="!working.active" label="Resend invite" icon="pi pi-refresh" text size="small" :loading="saving" @click="resend(working)" />
          <Button v-if="working.id !== authStore.user?.id" label="Remove" icon="pi pi-trash" text severity="danger" size="small" @click="remove(working)" />
        </div>
      </div>

      <div v-else class="usr-empty">Pick a user on the left, or invite one with +.</div>
    </section>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.usr-console { display: flex; height: 100%; min-height: 0; }
.usr-left { flex: none; width: 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.usr-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; padding: 22px 26px; overflow: auto; background: var(--bg); }
.usr-empty { margin: auto; color: var(--muted); font-size: 14px; }

.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.rail-list { list-style: none; margin: 0; padding: 8px 8px 16px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.rail-empty { padding: 14px 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; }

.badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; border-radius: 999px; padding: 1px 8px; }
.badge.admin { color: var(--accent); background: var(--accent-soft); }
.badge.active { color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 14%, white); }
.badge.pending { color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); }

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; width: 100%; max-width: 480px; }
.panel-head { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 650; color: var(--text-strong); margin-bottom: 14px; }
.tip { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.email-input { width: 100%; }
.err { color: var(--danger); font-size: 12.5px; margin: 8px 0 0; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.meta { display: flex; flex-direction: column; gap: 8px; margin: 0 0 14px; }
.meta > div { display: flex; justify-content: space-between; font-size: 13px; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; color: var(--text-strong); font-weight: 550; }
.invite-link { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 4px; }
.link-box { display: block; width: 100%; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; word-break: break-all; }
</style>
