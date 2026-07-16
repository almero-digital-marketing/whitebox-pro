// The single source of truth for the session — every other store/module reads
// accessToken/isAdmin from here rather than touching localStorage or a token
// env var directly. localStorage is purely the persistence backend this store
// writes through to on login/refresh/logout; nothing outside the store touches
// it. Login itself is a real browser navigation (a <form> POST from Login.vue),
// not an action here — a fetch with redirect:'manual' can't distinguish a
// successful redirect from a failed one on an opaque response.
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { randomVerifier, randomState, challengeFromVerifier } from '../pkce'

const CLIENT_ID = (import.meta as any).env?.VITE_OAUTH_CLIENT_ID || ''
const OAUTH_BASE = '/api/oauth'
const REFRESH_KEY = 'wb_refresh_token'
const VERIFIER_KEY = 'wb_pkce_verifier'
const STATE_KEY = 'wb_oauth_state'
const REDIRECT_URI = () => `${location.origin}/callback`

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null)
  const refreshToken = ref<string | null>(localStorage.getItem(REFRESH_KEY))
  const user = ref<{ id: string; email: string; is_admin: boolean } | null>(null)
  const ready = ref(false)   // true once the boot-time silent refresh has resolved either way

  const isAuthenticated = computed(() => !!accessToken.value)
  const isAdmin = computed(() => !!user.value?.is_admin)

  function persist(tokens: { access_token: string; refresh_token: string }) {
    accessToken.value = tokens.access_token
    refreshToken.value = tokens.refresh_token
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token)
  }

  function clear() {
    accessToken.value = null
    refreshToken.value = null
    user.value = null
    localStorage.removeItem(REFRESH_KEY)
  }

  async function loadMe() {
    try {
      const res = await fetch(`${OAUTH_BASE}/me`, { headers: { authorization: `Bearer ${accessToken.value}` } })
      user.value = res.ok ? await res.json() : null
    } catch { user.value = null }
  }

  // Builds what Login.vue's <form> needs to POST — the actual navigation to
  // /authorize happens as a real page load, not from here.
  async function buildAuthorizeRequest() {
    const verifier = randomVerifier()
    const state = randomState()
    sessionStorage.setItem(VERIFIER_KEY, verifier)
    sessionStorage.setItem(STATE_KEY, state)
    return {
      action: `${OAUTH_BASE}/authorize`,
      fields: {
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI(),
        code_challenge: await challengeFromVerifier(verifier), code_challenge_method: 'S256',
        scope: 'app:use admin:manage', state,
      },
    }
  }

  // Called from Callback.vue once ?code=&state= (or ?error=) arrive.
  async function completeLogin(code: string, state: string) {
    const expectedState = sessionStorage.getItem(STATE_KEY)
    const verifier = sessionStorage.getItem(VERIFIER_KEY)
    sessionStorage.removeItem(STATE_KEY)
    sessionStorage.removeItem(VERIFIER_KEY)
    if (!verifier || !state || state !== expectedState) throw new Error('Login state mismatch — please try again')

    const res = await fetch(`${OAUTH_BASE}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI(),
        code_verifier: verifier, client_id: CLIENT_ID,
      }),
    })
    if (!res.ok) throw new Error('Login failed')
    persist(await res.json())
    await loadMe()
  }

  // Silently mint a fresh access token from the stored refresh token — used
  // both on app boot (so a page reload doesn't force a re-login) and as the
  // apiClient's 401-retry path.
  async function refresh(): Promise<boolean> {
    if (!refreshToken.value) return false
    try {
      const res = await fetch(`${OAUTH_BASE}/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken.value, client_id: CLIENT_ID }),
      })
      if (!res.ok) { clear(); return false }
      persist(await res.json())
      await loadMe()
      return true
    } catch {
      clear()
      return false
    }
  }

  async function init() {
    if (refreshToken.value) await refresh()
    ready.value = true
  }

  function logout() { clear() }

  return { accessToken, user, ready, isAuthenticated, isAdmin, buildAuthorizeRequest, completeLogin, refresh, init, logout }
})
