import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

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
    // 5174, not Vite's default 5173: the console is a SECOND dev server, running alongside
    // whatever app the customer is developing — which will already own 5173.
    //
    // `strictPort` matters more than the number. The console's redirect_uri is
    // `${location.origin}/callback` and OAuth matches it EXACTLY, so a server that quietly
    // fell back to 5175 because 5174 was busy would fail at /authorize with "redirect_uri is
    // not registered" — a confusing error a long way from its cause. Refusing to start is the
    // honest failure. Whatever port this is must equal the port in the server's WB_APP_URL.
    port: 5174,
    strictPort: true,
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
