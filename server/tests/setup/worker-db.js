// Point this worker at its own database.
//
// Runs as a `setupFiles` entry, which executes in the worker process BEFORE the test
// module is imported — and the test files build their knex instance at import time from
// process.env.DATABASE_URL, so rewriting it here is enough and no test file changes.
//
// VITEST_POOL_ID is 1-based and stable for the life of a worker. Files are distributed
// across workers, so two files never share a database, while files within one worker
// still run sequentially — which is exactly the isolation the TRUNCATE in their
// beforeEach needs.
const urls = process.env.DATABASE_URLS ? JSON.parse(process.env.DATABASE_URLS) : null

if (urls?.length) {
  const id = Number(process.env.VITEST_POOL_ID || 1)
  // Modulo rather than an assertion: if vitest ever runs more workers than there are
  // branches, sharing one is slow and correct, where an out-of-range index is a crash
  // in every DB test at once.
  process.env.DATABASE_URL = urls[(id - 1) % urls.length]
}
