import { defineConfig } from 'vitest/config'

// No DOM APIs used (no URL parsing, no history) — plain node environment.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
  },
})
