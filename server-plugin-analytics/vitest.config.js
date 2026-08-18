import { defineConfig } from 'vitest/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The test harness lives in whitebox-pro-server, which is a sibling checkout — one
// Neon branch per worker (globalSetup) plus the per-worker assignment that reads the
// list (setupFiles). Both are needed: taking the branches without the assignment
// points every worker at the first one and reintroduces the clobbering they exist to
// stop.
//
// The path is SEARCHED rather than hardcoded. `./node_modules/whitebox-pro-server`
// was wrong in this repo — npm workspaces hoists the symlink to the monorepo root, so
// the plugin has no node_modules of its own and globalSetup silently never ran. It is
// also not resolvable by package name: the package's `exports` map does not publish
// ./tests/*. So try the layouts this repo is actually used in, and say so plainly if
// none match rather than failing later with an unreadable module error.
const here = path.dirname(fileURLToPath(import.meta.url))
const CANDIDATES = [
  '../node_modules/whitebox-pro-server/tests/setup',   // npm workspaces (this repo)
  './node_modules/whitebox-pro-server/tests/setup',    // polyrepo + npm link
  '../server/tests/setup',                             // plain sibling checkout
]
const setupDir = CANDIDATES.map(c => path.resolve(here, c)).find(p => fs.existsSync(p))
if (!setupDir) {
  throw new Error(
    'whitebox-pro-server test harness not found. Looked in:\n  ' +
    CANDIDATES.map(c => path.resolve(here, c)).join('\n  ') +
    '\nThese tests need the sibling server checkout (its tests/ directory is not published to npm).')
}

const WORKERS = Math.max(1, Math.min(16, Number(process.env.TEST_WORKERS || 4)))

export default defineConfig({
  test: {
    // Anchored explicitly. The setup files live OUTSIDE this directory (they belong to
    // the server checkout), and vitest infers `root` from the paths it is given — so
    // without this it widens to a common ancestor, the default include glob no longer
    // matches tests/, and the run reports "no tests" with a green exit code.
    root: here,
    globalSetup: path.join(setupDir, 'neon.js'),
    setupFiles: [path.join(setupDir, 'worker-db.js')],
    pool: 'forks',
    fileParallelism: true,
    // BOTH bounds, pinned equal. Setting only maxWorkers leaves minWorkers at the
    // machine's parallelism (16 here), and tinypool refuses min > max with
    // "options.minThreads and options.maxThreads must not conflict" — which vitest
    // reports as an unhandled error and "no tests", i.e. a green run that tested nothing.
    minWorkers: WORKERS,
    maxWorkers: WORKERS,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
