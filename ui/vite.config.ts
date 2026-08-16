import fs from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The console derives its PKCE challenge with `crypto.subtle` (see src/shell/pkce.ts),
// which browsers expose ONLY in a secure context: HTTPS, localhost, or 127.0.0.1.
// Serving this dev server over plain HTTP on a LAN address (http://192.168.x.x:9269)
// therefore leaves "Sign in" permanently DISABLED — challengeFromVerifier() throws,
// buildAuthorizeRequest() never resolves, and Login.vue gates the button on its result.
// The failure is silent, so it reads as "login is broken" rather than "wrong origin".
//
// Two ways out: reach the console over localhost (`ssh -L 9269:localhost:9269 host`),
// or set both vars below to a cert and serve HTTPS directly. Unset ⇒ plain HTTP.
const HTTPS_CERT = process.env.WB_UI_HTTPS_CERT
const HTTPS_KEY = process.env.WB_UI_HTTPS_KEY
const https =
  HTTPS_CERT && HTTPS_KEY
    ? { cert: fs.readFileSync(HTTPS_CERT), key: fs.readFileSync(HTTPS_KEY) }
    : undefined

// Dev server proxies the backend REST surface and the Socket.IO transport to the
// running WhiteBox server, so the SPA talks same-origin. The API lives under /api/*
// so it never collides with the client routes (/analytics, /campaigns, …); the /api
// prefix is stripped on the way through, so the server still serves /analytics/*.
// Override the API target with WB_API_PROXY when the server isn't on :3000
// (e.g. another whitebox instance already owns 3000 in local dev).
const API_TARGET = process.env.WB_API_PROXY || 'http://localhost:3000'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 9269 — "WBOX" on a phone keypad. Deliberately NOT in the 5173-5180 Vite range: the
    // console is a SECOND dev server, running alongside whatever app the customer is
    // developing. 5173 is Vite's default (the customer's app owns it) and 5174 is merely
    // the next one Vite reaches for, so it collides with the second Vite app just as
    // readily. A port well outside that range collides with nothing by convention.
    //
    // `strictPort` matters more than the number. The console's redirect_uri is
    // `${location.origin}/callback` and OAuth matches it EXACTLY, so a server that quietly
    // fell back to 9270 because 9269 was busy would fail at /authorize with "redirect_uri is
    // not registered" — a confusing error a long way from its cause. Refusing to start is the
    // honest failure. Whatever port this is must equal the port in the server's WB_APP_URL.
    port: 9269,
    strictPort: true,
    https,
    // Dev-only remote preview via ngrok — a free-tier tunnel gets a fresh random
    // subdomain each run, so this allows the whole domain space (not a specific
    // host, and never `true`/all-hosts) rather than needing an edit on every restart.
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app'],
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
})
