import { defineConfig } from 'vitest/config'

const WORKERS = Math.max(1, Math.min(16, Number(process.env.TEST_WORKERS || 4)))

export default defineConfig({
  test: {
    globalSetup: './tests/setup/neon.js',
    // Per-worker database assignment. Runs in the worker before the test module is
    // imported, which is what lets the files keep reading process.env.DATABASE_URL.
    setupFiles: ['./tests/setup/worker-db.js'],
    pool: 'forks',
    // Files run in PARALLEL, each worker against its own Neon branch — see
    // tests/setup/neon.js. This was `false` because the real-DB suites TRUNCATE shared
    // tables and one branch meant they clobbered each other; the fix was to stop
    // sharing the database, not to keep serialising the CPU.
    //
    // maxWorkers is pinned to the branch count so the mapping in worker-db.js is
    // one-to-one. Set TEST_WORKERS to change both together.
    fileParallelism: true,
    // BOTH bounds, pinned equal. Setting only maxWorkers leaves minWorkers at the
    // machine's parallelism (16 here), and tinypool refuses min > max with
    // "options.minThreads and options.maxThreads must not conflict" — which vitest
    // reports as an unhandled error and "no tests", i.e. a green run that tested nothing.
    minWorkers: WORKERS,
    maxWorkers: WORKERS,
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
