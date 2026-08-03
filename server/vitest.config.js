import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: './tests/setup/neon.js',
    pool: 'forks',
    // All test files share one Neon branch; the real-DB suites (passports, facts)
    // TRUNCATE shared tables, so run files sequentially to stop them clobbering
    // each other. (Mocked-DB suites are fast; the cost is small.)
    fileParallelism: false,
    // Sized to the NETWORK, not to a local DB. Every real-DB test here is a series
    // of round trips to a Neon branch in eu-central-1, and individual tests measure
    // 1–5s — vitest's 5000ms default leaves effectively no headroom, so the suite
    // failed differently from run to run.
    //
    // The cascade mattered more than the flakiness: a vitest timeout abandons the
    // TEST but not the QUERY, so the orphaned transaction keeps its locks and the
    // next test's TRUNCATE ... CASCADE in beforeEach deadlocks against a test that
    // was already given up on. Every deadlock we saw was the test AFTER a timeout.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
