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
    port: 5173,
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
