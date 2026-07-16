<script setup lang="ts">
// Reached only via the emailed invite link (?token=…) — public, no session.
// Calls server-plugin-oauth's public GET/POST /oauth/invite/:token[...]
// directly rather than going through the authenticated apiClient.
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const token = route.query.token as string | undefined

const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(true)
const saving = ref(false)
const valid = ref(false)

onMounted(async () => {
  if (!token) { error.value = 'Missing invite token.'; loading.value = false; return }
  try {
    const res = await fetch(`/api/oauth/invite/${token}`)
    if (!res.ok) throw new Error('This invite link is invalid or has expired.')
    email.value = (await res.json()).email
    valid.value = true
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

async function submit() {
  error.value = ''
  if (password.value.length < 12) { error.value = 'Password must be at least 12 characters.'; return }
  if (password.value !== confirmPassword.value) { error.value = 'Passwords do not match.'; return }
  saving.value = true
  try {
    const res = await fetch(`/api/oauth/invite/${token}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not set your password.')
    router.replace('/login')
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="invite-screen">
    <div class="invite-card">
      <img src="/logo.svg" alt="WhiteBox" width="36" height="36" />
      <template v-if="loading">
        <p class="muted">Checking your invite…</p>
      </template>
      <template v-else-if="valid">
        <h1>Set your password</h1>
        <p class="muted">{{ email }}</p>
        <p v-if="error" class="err">{{ error }}</p>
        <form @submit.prevent="submit">
          <input v-model="password" type="password" placeholder="Password (min. 12 characters)" required class="field" />
          <input v-model="confirmPassword" type="password" placeholder="Confirm password" required class="field" />
          <button type="submit" class="submit-btn" :disabled="saving">{{ saving ? 'Saving…' : 'Set password' }}</button>
        </form>
      </template>
      <template v-else>
        <p class="err">{{ error }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.invite-screen { display: grid; place-items: center; height: 100vh; background: var(--bg); }
.invite-card {
  width: 340px; padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-md);
}
.invite-card h1 { font-size: 17px; margin: 0; color: var(--text-strong); }
.invite-card form { display: flex; flex-direction: column; gap: 10px; width: 100%; margin-top: 6px; }
.muted { color: var(--muted); font-size: 13px; margin: 0; }
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
