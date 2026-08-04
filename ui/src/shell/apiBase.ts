// Where the API lives, relative to wherever the console is served from.
//
// In DEV the console runs on Vite's server and the API is a separate process, so calls go
// to `/api/*` and vite.config's proxy strips that prefix. In a BUILD the console is served
// by whitebox-pro-server itself, on the same origin as the API — so there is no prefix to
// strip, and adding one would 404 every request.
//
// Deciding it in ONE place is the point: it used to be baked into eight separate
// createClient('/api/…') calls plus the auth store, which meant a built console could only
// work behind a proxy that reproduced the dev server's rewrite.
//
// VITE_WB_API_BASE overrides both, for serving the console from a different origin than the
// API — then it must be an absolute URL, and the API needs CORS for that origin.
//
// This lives in its own module with NO imports on purpose. Putting it in apiClient.ts
// created a cycle (apiClient → stores/auth → apiClient), and because this is a `const`
// evaluated at module load, the loser of that cycle would have read `undefined`.
export const API_BASE: string =
  (import.meta.env.VITE_WB_API_BASE as string | undefined) ?? (import.meta.env.DEV ? '/api' : '')
