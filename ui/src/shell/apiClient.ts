// Shared authenticated fetch client — every module's req() delegates here
// instead of each hand-rolling an identical copy against a static token.
// Reads the CURRENT session's access token from useAuthStore, and on a 401
// (expired access token) retries once after a silent refresh before giving
// up, so an expired token mid-session self-heals instead of surfacing an
// error to the user.
import { useAuthStore } from './stores/auth'

export function createClient(base: string) {
  async function call(path: string, opts: any = {}, retried = false): Promise<any> {
    const authStore = useAuthStore()
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(authStore.accessToken ? { authorization: `Bearer ${authStore.accessToken}` } : {}),
        ...(opts.headers || {}),
      },
    })
    if (res.status === 401 && !retried && (await authStore.refresh())) {
      return call(path, opts, true)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    return res.status === 204 ? null : res.json()
  }
  return call
}
