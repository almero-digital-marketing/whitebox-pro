<script setup lang="ts">
// A real <form method="post"> to /api/oauth/authorize — a genuine browser
// navigation, not a fetch. A fetch with redirect:'manual' can't distinguish a
// successful redirect from a failed one on the resulting opaque response, so
// only a real page load can drive this leg of the OAuth flow — no submit
// handler needed, the browser does it natively. On wrong credentials the
// server redirects back here with ?error=1 (see server-plugin-oauth's
// redirectWithError on the /authorize POST handler).
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const authStore = useAuthStore()
const fields = ref<Record<string, string>>({})
const action = ref('')

onMounted(async () => {
  const req = await authStore.buildAuthorizeRequest()
  action.value = req.action
  fields.value = req.fields
})
</script>

<template>
  <div class="login-screen">
    <form class="login-card" method="post" :action="action">
      <img src="/logo.svg" alt="WhiteBox" width="36" height="36" />
      <h1>Sign in</h1>
      <p v-if="route.query.error" class="err">Incorrect email or password.</p>
      <p v-else-if="route.query.created" class="ok">Admin account created — log in below.</p>

      <input v-for="(v, k) in fields" :key="k" type="hidden" :name="k" :value="v" />
      <input type="email" name="email" placeholder="Email" required autofocus class="field" />
      <input type="password" name="password" placeholder="Password" required class="field" />
      <button type="submit" class="submit-btn" :disabled="!action">Sign in</button>
    </form>
  </div>
</template>

<style scoped>
.login-screen { display: grid; place-items: center; height: 100vh; background: var(--bg); }
.login-card {
  width: 320px; padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-md);
}
.login-card h1 { font-size: 17px; margin: 0 0 6px; color: var(--text-strong); }
.err { color: var(--danger); font-size: 13px; margin: -4px 0 4px; }
.ok { color: var(--accent); font-size: 13px; margin: -4px 0 4px; }
.field {
  width: 100%; padding: 9px 10px; border: 1px solid var(--border-2); border-radius: 8px;
  font-size: 14px; background: var(--panel); color: var(--text);
}
.field:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.submit-btn {
  width: 100%; margin-top: 6px; padding: 9px; border: none; border-radius: 8px;
  background: var(--accent); color: var(--p-primary-contrast-color, #fff); font-size: 14px; font-weight: 500; cursor: pointer;
}
.submit-btn:hover { opacity: .92; }
.submit-btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
