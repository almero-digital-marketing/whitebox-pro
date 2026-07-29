<script setup lang="ts">
// Reached only when an authenticated user holds no permission for any
// module at all (router.ts's beforeEach falls back here when it can't find
// a single allowed module to redirect to) — e.g. right after an admin
// explicitly clears every grant. Distinct from the per-module icon hiding
// in App.vue: that still leaves SOME module reachable; this is the "none
// at all" edge case.
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'

const authStore = useAuthStore()
const router = useRouter()

function logout() {
  authStore.logout()
  router.replace('/login')
}
</script>

<template>
  <div class="no-access-screen">
    <div class="no-access-card">
      <img src="/logo.svg" alt="WhiteBox" width="36" height="36" />
      <h1>No access yet</h1>
      <p class="muted">Your account isn't granted access to any module yet. Ask an admin to grant you a permission.</p>
      <button type="button" class="signout-btn" @click="logout">Sign out</button>
    </div>
  </div>
</template>

<style scoped>
.no-access-screen { display: grid; place-items: center; height: 100vh; background: var(--bg); }
.no-access-card {
  width: 340px; padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-md);
}
.no-access-card h1 { font-size: 17px; margin: 0; color: var(--text-strong); }
.muted { color: var(--muted); font-size: 13px; margin: 0; line-height: 1.5; }
.signout-btn {
  width: 100%; margin-top: 6px; padding: 9px; border: none; border-radius: 8px;
  background: var(--accent); color: var(--p-primary-contrast-color, #fff); font-size: 14px; font-weight: 500; cursor: pointer;
}
.signout-btn:hover { opacity: .92; }
</style>
