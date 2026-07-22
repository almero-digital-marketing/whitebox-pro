<script setup lang="ts">
// Users module — visible only with the users:manage permission (see
// shell/modules.ts's requiresAnyPermission + App.vue's filter; the server
// independently requires that same scope on every request regardless).
// Per-module permission grants (no named roles — see server-plugin-oauth's
// README): invite, resend, remove, edit profile fields, and check/uncheck
// each module's declared permissions for a user.
//
// Three-pane shape matching Campaigns/Audiences: left = rail, center = the
// selected user's own identity (editable, buffered in `draft` and committed
// with Save — same pattern as Campaigns' composed content), right = that
// user's permissions (a separate concern from their identity, kept in its
// own pane rather than mixed into the profile).
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import RailSearch from '../../components/RailSearch.vue'
import { useUsersStore } from './stores/users'
import { useAuthStore } from '../../shell/stores/auth'
import { notifyError } from '../../shell/toast'

const LOGIN_PAGE_ROWS = 10   // matches analytics' WidgetCard table — rows per page, not an inner scrollbar

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useUsersStore()
const authStore = useAuthStore()
const { users, catalog, logins } = storeToRefs(store)
const allPermissionKeys = computed(() => catalog.value.flatMap((m: any) => m.items.map((i: any) => i.key)))

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
  await Promise.all([store.loadUsers(), store.loadCatalog()])
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

// ── identity (first/last name, email, phone) — buffered in `draft`, committed with Save ──
const draft = ref<any>(null)
const savingProfile = ref(false)
const profileError = ref('')
function resetDraft() {
  const u = working.value
  draft.value = u ? { first_name: u.first_name || '', last_name: u.last_name || '', email: u.email || '', phone: u.phone || '' } : null
  profileError.value = ''
}
const profileDirty = computed(() => {
  const u = working.value, d = draft.value
  if (!u || !d) return false
  return d.first_name !== (u.first_name || '') || d.last_name !== (u.last_name || '')
    || d.email !== (u.email || '') || d.phone !== (u.phone || '')
})
async function saveProfile() {
  if (!working.value || !profileDirty.value || savingProfile.value) return
  savingProfile.value = true
  profileError.value = ''
  try {
    working.value = { ...working.value, ...(await store.updateProfile(working.value.id, { ...draft.value })) }
    resetDraft()
  } catch (e: any) {
    profileError.value = e.message
  } finally {
    savingProfile.value = false
  }
}

// A local draft so multiple checkbox toggles batch into one Save — the
// wildcard '*' (bootstrap-only, never itself selectable) expands to every
// current key so it renders as "everything checked" until edited, at which
// point Save always submits a concrete list (there's no way to re-submit
// '*' through this UI — see the PUT route's validation).
const permDraft = ref<string[]>([])
const savingPerms = ref(false)
function loadPermDraft() {
  const u = working.value
  permDraft.value = u ? (u.permissions?.includes('*') ? [...allPermissionKeys.value] : [...(u.permissions || [])]) : []
}
// Keyed on the id, not on `working` itself — `working` gets a brand-new object
// reference from `applyRoute` every time ANY user row changes in the store
// (invite/resend/save-permissions/save-profile all reassign `users.value`),
// which would otherwise wipe this admin's in-progress draft/permDraft edits
// just because someone (possibly a different admin, possibly for a
// different user entirely) saved something elsewhere. Resetting only when
// the SELECTED user actually changes means concurrent edits elsewhere no
// longer clobber local unsaved state — the two save paths that DO need a
// resync after success already call resetDraft()/loadPermDraft() explicitly.
watch(() => working.value?.id, () => {
  resetDraft()
  loadPermDraft()
  resetPasswordFields()
  if (working.value) store.loadLogins(working.value.id)
})

// ── change MY OWN password — self-service only, shown just when viewing your
// own account (see isSelf) — never someone else's, and never a case of an
// admin having to know a teammate's password. New password + confirm live
// inline, same draft/dirty shape as the profile fields above; only the
// CURRENT password (proof this is really you, not just an active session)
// moves into a popup, asked at the moment you actually submit — the server
// independently enforces this can only ever change your own account
// regardless of what this UI shows.
const isSelf = computed(() => !!working.value && working.value.id === authStore.user?.id)
const newPassword = ref('')
const confirmNewPassword = ref('')
const newPasswordDirty = computed(() => !!newPassword.value || !!confirmNewPassword.value)
const passwordsMatch = computed(() => newPassword.value === confirmNewPassword.value)
const passwordError = ref('')

const showCurrentPasswordDialog = ref(false)
const currentPassword = ref('')
const currentPasswordError = ref('')
const savingPassword = ref(false)

function resetPasswordFields() {
  newPassword.value = ''
  confirmNewPassword.value = ''
  passwordError.value = ''
  currentPassword.value = ''
  currentPasswordError.value = ''
  showCurrentPasswordDialog.value = false
}
// Match is enforced by the button's :disabled state (see template) — only the length
// check is left to validate here, since it's the one precondition that button doesn't gate.
function startPasswordChange() {
  passwordError.value = ''
  if (newPassword.value.length < 12) { passwordError.value = 'New password must be at least 12 characters.'; return }
  currentPassword.value = ''
  currentPasswordError.value = ''
  showCurrentPasswordDialog.value = true
}
async function confirmPasswordChange() {
  currentPasswordError.value = ''
  savingPassword.value = true
  try {
    await store.changePassword(working.value.id, currentPassword.value, newPassword.value)
    resetPasswordFields()   // closing the popup + clearing the fields IS the confirmation — no toast system in this app
  } catch (e: any) {
    currentPasswordError.value = e.message   // wrong current password — keep the popup open, don't lose the new password already typed
  } finally {
    savingPassword.value = false
  }
}
function togglePerm(key: string) {
  if (key === 'users:manage' && isLastManager.value && permDraft.value.includes(key)) return
  const i = permDraft.value.indexOf(key)
  if (i >= 0) permDraft.value.splice(i, 1)
  else permDraft.value.push(key)
}
const permsDirty = computed(() => {
  if (!working.value) return false
  const current = working.value.permissions?.includes('*') ? [...allPermissionKeys.value] : (working.value.permissions || [])
  return current.length !== permDraft.value.length || !current.every((k: string) => permDraft.value.includes(k))
})
// Whether working is the only ACTIVE user holding users:manage — if so,
// unchecking it would lock everyone out of ever managing users/permissions
// again (see server-plugin-oauth's hasOtherActiveManager), so the checkbox
// is disabled rather than letting a Save hit that 400.
const isLastManager = computed(() => {
  if (!working.value) return false
  const holdsManage = (u: any) => u.active && (u.permissions?.includes('*') || u.permissions?.includes('users:manage'))
  if (!holdsManage(working.value)) return false
  return !users.value.some((u: any) => u.id !== working.value.id && holdsManage(u))
})
const permsError = ref('')
// Whether the lifecycle-actions bar (Resend/Remove) has anything in it —
// its separator only makes sense when it does (e.g. an active admin viewing
// their own account gets neither button, so the bar would otherwise render
// as an empty divider with nothing below it).
const hasLifecycleActions = computed(() => !!working.value && (!working.value.active || working.value.id !== authStore.user?.id))
async function savePermissions() {
  if (!working.value) return
  savingPerms.value = true
  permsError.value = ''
  try {
    working.value = { ...working.value, ...(await store.setPermissions(working.value.id, permDraft.value)) }
    loadPermDraft()
  } catch (e: any) {
    permsError.value = e.message
  } finally {
    savingPerms.value = false
  }
}
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
  catch (e: any) { notifyError(`Couldn't resend the invite: ${e.message}`) }
  finally { saving.value = false }
}

function remove(u: any) {
  confirm.require({
    header: 'Remove user', message: `Remove ${u.email}? They will lose access immediately.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Remove', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => {
      const open = working.value?.id === u.id
      try {
        await store.removeUser(u.id)
        if (open) { working.value = null; router.replace({ name: 'users', params: {} }) }
      } catch (e: any) {
        notifyError(`Couldn't remove ${u.email}: ${e.message}`)
      }
    },
  })
}

function fmtDate(iso?: string) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}

function fmtDateTime(iso?: string) {
  return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'
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
            <span class="ri-sub">{{ u.active ? 'Active' : 'Pending' }}<template v-if="u.permissions?.includes('*')"> · Full access</template></span>
          </div>
        </li>
        <li v-if="!filteredUsers.length" class="rail-empty">{{ q ? 'No matches.' : 'No users yet — invite one with +' }}</li>
      </ul>
      <RailSearch v-model="q" placeholder="Search users" />
    </aside>

    <section class="usr-center">
      <div v-if="inviting" class="panel">
        <div class="panel-head">Invite a teammate</div>
        <p class="tip">They'll get an email with a link to set their password. There's no role to assign — they'll start with each module's default permissions, and you can grant or revoke individual ones afterward from their permissions pane.</p>
        <InputText v-model="inviteEmail" class="email-input" placeholder="email@example.com" @keyup.enter="submitInvite" />
        <p v-if="error" class="err">{{ error }}</p>
        <div class="actions">
          <Button label="Cancel" text severity="secondary" size="small" @click="inviting = false" />
          <Button label="Send invite" icon="pi pi-send" size="small" :loading="saving" @click="submitInvite" />
        </div>
      </div>

      <div v-else-if="working" class="panel">
        <div class="panel-head">{{ working.email }} <span v-if="working.permissions?.includes('*')" class="badge admin">Full access</span></div>

        <div class="row">
          <label class="fld"><span class="fld-l">First name</span><InputText v-model="draft.first_name" placeholder="—" /></label>
          <label class="fld"><span class="fld-l">Last name</span><InputText v-model="draft.last_name" placeholder="—" /></label>
        </div>
        <div class="row">
          <label class="fld grow"><span class="fld-l">Email</span><InputText v-model="draft.email" /></label>
          <label class="fld grow"><span class="fld-l">Phone</span><InputText v-model="draft.phone" placeholder="—" /></label>
        </div>
        <p v-if="profileError" class="err">{{ profileError }}</p>
        <div class="save-bar">
          <span class="save-note" :class="{ 'save-note--hidden': !profileDirty }"><i class="pi pi-circle-fill" /> Unsaved changes</span>
          <Button label="Discard" text severity="secondary" size="small" :disabled="!profileDirty" @click="resetDraft" />
          <Button label="Save" icon="pi pi-check" size="small" :disabled="!profileDirty" :loading="savingProfile" @click="saveProfile" />
        </div>

        <template v-if="isSelf">
          <div class="password-block">
            <div class="password-head">Change password</div>
            <div class="row">
              <label class="fld grow"><span class="fld-l">New password</span><InputText v-model="newPassword" type="password" autocomplete="new-password" placeholder="Min. 12 characters" /></label>
              <label class="fld grow"><span class="fld-l">Confirm new password</span><InputText v-model="confirmNewPassword" type="password" autocomplete="new-password" /></label>
            </div>
            <p v-if="passwordError" class="err">{{ passwordError }}</p>
            <div class="save-bar">
              <span class="save-note" :class="{ 'save-note--hidden': !newPasswordDirty }"><i class="pi pi-circle-fill" /> Unsaved changes</span>
              <Button label="Discard" text severity="secondary" size="small" :disabled="!newPasswordDirty" @click="resetPasswordFields" />
              <Button label="Change password" icon="pi pi-check" size="small" :disabled="!newPasswordDirty || !passwordsMatch" @click="startPasswordChange" />
            </div>
          </div>
        </template>

        <dl class="meta">
          <div><dt>Status</dt><dd>{{ working.active ? 'Active' : 'Invite pending' }}</dd></div>
          <div><dt>Invited</dt><dd>{{ fmtDate(working.invited_at) }}</dd></div>
          <div><dt>Joined</dt><dd>{{ fmtDate(working.created_at) }}</dd></div>
          <div><dt>Last access</dt><dd>{{ fmtDateTime(working.last_access_at) }}</dd></div>
        </dl>

        <div class="logins-block">
          <div class="logins-head">Logins</div>
          <div class="table-body">
            <DataTable v-if="logins.length" :value="logins" size="small" dataKey="id"
              :paginator="logins.length > LOGIN_PAGE_ROWS" :rows="LOGIN_PAGE_ROWS" :alwaysShowPaginator="false">
              <Column header="Client" field="client_name" :style="{ width: '7rem' }" />
              <Column header="Browser / OS" :style="{ width: '10rem' }">
                <template #body="{ data }">{{ data.browser === 'Unknown' && data.os === 'Unknown' ? '—' : `${data.browser} on ${data.os}` }}</template>
              </Column>
              <Column header="IP" :style="{ width: '8rem' }">
                <template #body="{ data }"><span class="mono">{{ data.ip || '—' }}</span></template>
              </Column>
              <Column header="When" :style="{ width: '10rem' }">
                <template #body="{ data }">{{ fmtDateTime(data.created_at) }}</template>
              </Column>
            </DataTable>
            <p v-else class="muted">No logins yet.</p>
          </div>
        </div>

        <div v-if="justInvited?.id === working.id && justInvited.inviteUrl" class="invite-link">
          <p class="tip">Share this link if the invite email didn't arrive:</p>
          <code class="link-box">{{ justInvited.inviteUrl }}</code>
        </div>

        <div v-if="hasLifecycleActions" class="actions">
          <Button v-if="!working.active" label="Resend invite" icon="pi pi-refresh" text size="small" :loading="saving" @click="resend(working)" />
          <Button v-if="working.id !== authStore.user?.id" label="Remove" icon="pi pi-trash" text severity="danger" size="small" @click="remove(working)" />
        </div>
      </div>

      <div v-else class="usr-empty">Pick a user on the left, or invite one with +.</div>
    </section>

    <!-- right: this user's permissions — a separate concern from their identity above -->
    <aside v-if="working && !inviting" class="usr-side">
      <div class="pane-head">Permissions</div>
      <div class="side-body">
        <p v-if="working.permissions?.includes('*')" class="tip">This account has full access — editing switches it off full access onto whatever's checked below.</p>
        <div v-for="mod in catalog" :key="mod.module" class="side-section">
          <div class="perm-group-label">{{ mod.module }}</div>
          <p v-if="mod.module === 'oauth' && isLastManager" class="perm-group-hint">The only active user who can manage users &amp; permissions — grant it to someone else first.</p>
          <label v-for="item in mod.items" :key="item.key" class="perm-item" :class="{ disabled: item.key === 'users:manage' && isLastManager }">
            <input type="checkbox" :checked="permDraft.includes(item.key)" :disabled="item.key === 'users:manage' && isLastManager" @change="togglePerm(item.key)" />
            <span>
              <span class="perm-item-label">{{ item.label }}</span>
              <span class="perm-item-desc">{{ item.description }}</span>
            </span>
          </label>
        </div>
        <p v-if="permsError" class="err">{{ permsError }}</p>
        <div class="actions">
          <span class="save-note" :class="{ 'save-note--hidden': !permsDirty }"><i class="pi pi-circle-fill" /> Unsaved changes</span>
          <Button label="Discard" text severity="secondary" size="small" :disabled="!permsDirty" @click="loadPermDraft" />
          <Button label="Save" icon="pi pi-check" size="small" :disabled="!permsDirty" :loading="savingPerms" @click="savePermissions" />
        </div>
      </div>
    </aside>
    <ConfirmDialog />

    <Dialog v-model:visible="showCurrentPasswordDialog" modal header="Confirm it's you" :style="{ width: '340px' }">
      <p class="tip">Enter your current password to confirm this change.</p>
      <label class="fld grow"><span class="fld-l">Current password</span><InputText v-model="currentPassword" type="password" autocomplete="current-password" autofocus @keyup.enter="confirmPasswordChange" /></label>
      <p v-if="currentPasswordError" class="err">{{ currentPasswordError }}</p>
      <template #footer>
        <Button label="Cancel" text severity="secondary" size="small" @click="showCurrentPasswordDialog = false" />
        <Button label="Confirm" icon="pi pi-check" size="small" :loading="savingPassword" :disabled="!currentPassword" @click="confirmPasswordChange" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.usr-console { display: flex; height: 100%; min-height: 0; }
.usr-left { flex: none; width: 300px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.usr-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; padding: 22px 26px; overflow: auto; background: var(--panel); }
.usr-side { flex: none; width: 480px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); }
.side-body { flex: 1 1 auto; overflow: auto; padding: 18px; }
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
.ri-sub { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }

.badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; border-radius: 999px; padding: 1px 8px; }
.badge.admin { color: var(--p-primary-contrast-color, #fff); background: var(--accent); }

.panel { width: 100%; display: flex; flex-direction: column; min-height: 0; }
.panel-head { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 650; color: var(--text-strong); margin-bottom: 16px; }
.tip { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.email-input { width: 100%; }
.err { color: var(--danger); font-size: 12.5px; margin: 8px 0 0; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }

/* editable identity fields — same .row/.fld/.fld-l pattern as Campaigns' builder */
.row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.fld { display: flex; flex-direction: column; gap: 5px; flex: 1 1 160px; }
.fld.grow { flex: 1 1 220px; }
.fld-l { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.fld :deep(input) { width: 100%; }
/* no border of its own — always followed by a section that already has its
   own border-top (.password-block or .meta), so adding one here too would
   just stack two dividers back to back with barely any gap between them */
.save-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 14px; }
.save-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-right: auto; }
.save-note .pi-circle-fill { font-size: 8px; color: #d97706; }
.save-note--hidden { visibility: hidden; }

/* read-only system fields */
.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px 24px; margin: 0 0 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.meta > div { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.meta dt { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.meta dd { margin: 0; color: var(--text-strong); font-weight: 550; }
.invite-link { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 4px; }
.link-box { display: block; width: 100%; padding: 8px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; word-break: break-all; }

/* self-service password change — shown only when viewing your own account.
   New password + confirm live here; the current-password re-auth step is a
   separate Dialog, popped up only once these two validate (see startPasswordChange). */
.password-block { border-top: 1px solid var(--border); padding-top: 14px; margin-bottom: 4px; }
/* sentence-case, no letter-spacing/uppercase — matches the query builder's
   .lab tier (analytics/components/query/qb.css), not the .fld-l micro-caps
   field labels directly below it, so the two don't blend into each other */
.password-head { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 12px; }

.logins-block { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 4px; margin-bottom: 4px; }
.logins-head { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.muted { color: var(--muted); font-size: 12.5px; }
.mono { font-family: ui-monospace, monospace; }

/* table styling matches analytics' WidgetCard 'table' widget exactly — same
   PrimeVue DataTable density, paginator sizing, and font scale. */
.table-body :deep(.p-datatable) { font-size: 12.5px; }
.table-body :deep(.p-datatable-table) { width: 100%; table-layout: fixed; }
.table-body :deep(td), .table-body :deep(th) { overflow: hidden; padding: 6px 8px; }
.table-body :deep(th) { font-size: 11px; font-weight: 600; color: var(--muted); }
.table-body :deep(.p-paginator) { padding: 2px 0; font-size: 13px; }
.table-body :deep(.p-paginator-page),
.table-body :deep(.p-paginator-first),
.table-body :deep(.p-paginator-prev),
.table-body :deep(.p-paginator-next),
.table-body :deep(.p-paginator-last) { min-width: 33px; width: 33px; height: 33px; font-size: 13px; }
.table-body :deep(.p-paginator-page) { margin: 0 1px; }
.table-body :deep(.p-paginator .p-select) { height: 33px; }

/* right pane: permissions, grouped by module — matches Campaigns' .side-section divider pattern */
.side-section { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
.side-section:first-child { border-top: none; margin-top: 0; padding-top: 0; }
.perm-group-label { font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
/* module-level note, not tied to one checkbox's own label/description — same idea as
   Campaigns' Objectives tip: an explanation lives with the section it concerns, not
   buried inside a single item or off in an unrelated action area. */
.perm-group-hint { margin: -2px 0 10px; font-size: 12px; color: var(--danger); line-height: 1.4; }
.perm-item { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; cursor: pointer; }
.perm-item input { margin-top: 3px; accent-color: var(--accent); }
.perm-item.disabled { cursor: default; }
.perm-item-label { display: block; font-size: 13.5px; font-weight: 550; color: var(--text-strong); }
.perm-item-desc { display: block; font-size: 12px; color: var(--muted); }
</style>
