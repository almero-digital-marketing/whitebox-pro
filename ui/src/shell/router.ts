// Client-side routing. Each module owns a top-level path (/analytics, /campaigns, …)
// derived from its id in the registry, so adding a module to modules.ts gives it a
// route for free. "/" redirects to the first module (nominally); unknown paths fall
// back to it too — but beforeEach below re-checks permission on whatever that
// resolves to, same as any other navigation, so it never actually strands anyone
// on a module they can't use. /login, /callback, and /accept-invite sit outside the
// module system — they're the auth flow itself, not a feature module, and must
// never require a session.
import { createRouter, createWebHistory } from 'vue-router'
import { modules } from './modules'
import { useAuthStore } from './stores/auth'
import Login from './views/Login.vue'
import Callback from './views/Callback.vue'
import AcceptInvite from './views/AcceptInvite.vue'
import NoAccess from './views/NoAccess.vue'

const home = `/${modules[0].id}`
const PUBLIC_PATHS = new Set(['/login', '/callback', '/accept-invite'])

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: home },
    { path: '/login', name: 'login', component: Login },
    { path: '/callback', name: 'callback', component: Callback },
    { path: '/accept-invite', name: 'accept-invite', component: AcceptInvite },
    { path: '/no-access', name: 'no-access', component: NoAccess },
    ...modules.map((m) => ({ path: m.subPath ? `/${m.id}/${m.subPath}` : `/${m.id}`, name: m.id, component: m.component })),
    { path: '/:pathMatch(.*)*', redirect: home },
  ],
})

// A module a user can't use is unreachable, not just icon-hidden — App.vue's
// activity-bar filter is cosmetic on its own (a direct URL or the "/" default
// redirect would otherwise still land on and render a module's full UI shell
// with zero permission for it, even though every actual data request from it
// would 403 server-side). This is the real gate; that filter just keeps the
// icon in sync with it.
function isAllowed(name: unknown, authStore: ReturnType<typeof useAuthStore>) {
  const mod = modules.find((m) => m.id === name)
  return !mod?.requiresAnyPermission || mod.requiresAnyPermission.some((k) => authStore.hasPermission(k))
}

router.beforeEach(async (to) => {
  if (PUBLIC_PATHS.has(to.path) || to.name === 'no-access') return true
  const authStore = useAuthStore()
  if (!authStore.ready) await authStore.init()
  if (!authStore.isAuthenticated) return { path: '/login' }
  if (isAllowed(to.name, authStore)) return true

  const firstAllowed = modules.find((m) => isAllowed(m.id, authStore))
  return { path: firstAllowed ? `/${firstAllowed.id}` : '/no-access' }
})
