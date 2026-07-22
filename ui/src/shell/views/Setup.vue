<script setup lang="ts">
// First-run admin creation — reached only when the server has zero users at
// all (see server-plugin-oauth's GET /setup-required, and the router guard
// that redirects here for ANY navigation in that state). A third bootstrap
// path alongside scripts/create-admin.mjs and ADMIN_EMAIL/ADMIN_PASSWORD's
// own auto-bootstrap on server boot — this one needs no shell access at all.
// Public, no session, same posture as AcceptInvite.vue: calls the oauth
// plugin's public routes directly rather than going through apiClient.
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(true)
const saving = ref(false)
const stillRequired = ref(false)

onMounted(async () => {
  // Independent, un-cached check (not the store's memoized one) — someone
  // else may have completed setup (another tab, the CLI script, .env) a
  // moment ago, and a direct navigation here should catch that immediately
  // rather than trust a value cached before this tab even opened.
  try {
    const res = await fetch('/api/oauth/setup-required')
    stillRequired.value = res.ok && !!(await res.json()).required
  } catch {
    stillRequired.value = false
  }
  loading.value = false
  if (!stillRequired.value) router.replace('/login')
})

async function submit() {
  error.value = ''
  if (password.value.length < 12) { error.value = 'Password must be at least 12 characters.'; return }
  if (password.value !== confirmPassword.value) { error.value = 'Passwords do not match.'; return }
  saving.value = true
  try {
    const res = await fetch('/api/oauth/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not create the admin account.')
    authStore.markSetupComplete()
    router.replace('/login?created=1')
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="setup-screen">
    <div class="setup-card">
      <img src="/logo.svg" alt="WhiteBox" width="36" height="36" />
      <template v-if="loading">
        <p class="muted">Checking setup status…</p>
      </template>
      <template v-else-if="stillRequired">
        <h1>Create the admin account</h1>
        <p class="muted">This is a fresh install with no users yet — this account gets every permission.</p>
        <p v-if="error" class="err">{{ error }}</p>
        <form @submit.prevent="submit">
          <input v-model="email" type="email" placeholder="Email" required autofocus class="field" />
          <input v-model="password" type="password" placeholder="Password (min. 12 characters)" required class="field" />
          <input v-model="confirmPassword" type="password" placeholder="Confirm password" required class="field" />
          <button type="submit" class="submit-btn" :disabled="saving">{{ saving ? 'Creating…' : 'Create admin account' }}</button>
        </form>
      </template>
    </div>
  </div>
</template>

<style scoped>
.setup-screen { display: grid; place-items: center; height: 100vh; background: var(--bg); }
.setup-card {
  width: 340px; padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-md);
}
.setup-card h1 { font-size: 17px; margin: 0; color: var(--text-strong); text-align: center; }
.setup-card form { display: flex; flex-direction: column; gap: 10px; width: 100%; margin-top: 6px; }
.muted { color: var(--muted); font-size: 13px; margin: 0; text-align: center; }
.err { color: var(--danger); font-size: 13px; margin: 0; text-align: center; }
.field {
  width: 100%; padding: 9px 10px; border: 1px solid var(--border-2); border-radius: 8px;
  font-size: 14px; background: var(--panel); color: var(--text);
}
.field:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.submit-btn {
  width: 100%; padding: 9px; border: none; border-radius: 8px;
  background: var(--accent); color: var(--p-primary-contrast-color, #fff); font-size: 14px; font-weight: 500; cursor: pointer;
}
.submit-btn:hover { opacity: .92; }
.submit-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
