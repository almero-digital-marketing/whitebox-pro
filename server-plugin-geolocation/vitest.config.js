import { defineConfig } from 'vitest/config'

// Unit tests stub sessions/facts — no DB, no Neon branch needed (this plugin
// has no store of its own; geo becomes core facts via the injected ctx.facts).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
  },
})
