<script setup lang="ts">
// App shell — the VS Code-style activity bar + the active module. Routing drives
// which module shows (one path per module, see shell/router.ts); the activity bar
// reflects the current route and navigates on click. keep-alive preserves each
// module's state across switches. Each module is self-contained under src/modules/.
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import Toast from 'primevue/toast'
import ActivityBar from './shell/ActivityBar.vue'
import { modules } from './shell/modules'
import { useAuthStore } from './shell/stores/auth'
import { initToast } from './shell/toast'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
initToast(useToast())
// /login, /callback, /accept-invite are standalone screens — no activity bar chrome.
const isAuthScreen = computed(() => ['login', 'callback', 'accept-invite'].includes(route.name as string))
const visibleModules = computed(() => modules.filter((m) => !m.requiresAnyPermission || m.requiresAnyPermission.some((k) => authStore.hasPermission(k))))
const activeId = computed(() => (route.name as string) || modules[0].id)
function logout() {
  authStore.logout()
  router.replace('/login')
}
// remember each module's last full path (incl. its sub-state, e.g. analytics' open
// report + selected widget) so switching modules and back returns where you left off.
const lastPath = reactive<Record<string, string>>({})
watch(() => route.fullPath, () => { if (route.name) lastPath[route.name as string] = route.fullPath }, { immediate: true })
// The module we're navigating TO. router.push is async, so `activeId` (the resolved route)
// lags a frame — guarding on it lets a rapid second click read a stale value and no-op onto
// the wrong module. `pendingId` updates synchronously on click, so the last click always wins;
// a watcher keeps it honest when the route changes by other means (back/forward, in-module nav).
const pendingId = ref(activeId.value)
watch(activeId, (v) => { pendingId.value = v })
function select(id: string) {
  if (id === pendingId.value) return
  pendingId.value = id
  router.push(lastPath[id] || `/${id}`)
}
</script>

<template>
  <Toast position="top-right" />
  <router-view v-if="isAuthScreen" />
  <div v-else class="shell">
    <ActivityBar :modules="visibleModules" :active-id="activeId" @select="select" @logout="logout" />
    <main class="module-host">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
  </div>
</template>
