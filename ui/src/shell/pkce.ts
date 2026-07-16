// PKCE (RFC 7636), S256 — the browser-side half of the same algorithm
// server-plugin-oauth/src/pkce.js implements server-side. Only the verifier
// leaves this module in cleartext (kept in sessionStorage by the auth store);
// the challenge is what actually crosses the wire in the /authorize request.

function base64url(bytes: Uint8Array): string {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}
