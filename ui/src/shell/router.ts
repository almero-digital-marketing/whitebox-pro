// Client-side routing. Each module owns a top-level path (/analytics, /campaigns, …)
// derived from its id in the registry, so adding a module to modules.ts gives it a
// route for free. "/" redirects to the first module; unknown paths fall back to it.
// /login, /callback, and /accept-invite sit outside the module system — they're the
// auth flow itself, not a feature module, and must never require a session.
import { createRouter, createWebHistory } from 'vue-router'
import { modules } from './modules'
import { useAuthStore } from './stores/auth'
import Login from './views/Login.vue'
import Callback from './views/Callback.vue'
import AcceptInvite from './views/AcceptInvite.vue'

const home = `/${modules[0].id}`
const PUBLIC_PATHS = new Set(['/login', '/callback', '/accept-invite'])

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: home },
    { path: '/login', name: 'login', component: Login },
    { path: '/callback', name: 'callback', component: Callback },
    { path: '/accept-invite', name: 'accept-invite', component: AcceptInvite },
    ...modules.map((m) => ({ path: m.subPath ? `/${m.id}/${m.subPath}` : `/${m.id}`, name: m.id, component: m.component })),
    { path: '/:pathMatch(.*)*', redirect: home },
  ],
})

router.beforeEach(async (to) => {
  if (PUBLIC_PATHS.has(to.path)) return true
  const authStore = useAuthStore()
  if (!authStore.ready) await authStore.init()
  if (!authStore.isAuthenticated) return { path: '/login' }
  return true
})
