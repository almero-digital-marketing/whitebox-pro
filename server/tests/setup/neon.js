import fs from 'fs'
import knex from 'knex'
import { fileURLToPath } from 'url'
import path from 'path'

// .env.test is expected one directory up from whitebox-pro-server's checkout, so
// sibling polyrepo plugins (linked via `npm link whitebox-pro-server`) all read
// the same secrets without duplicating them across repos. Parsed inline to
// avoid pulling dotenv into every plugin's transitive deps.
function loadEnvFile(envPath) {
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {
    // Allow tests to supply env vars from the calling shell instead.
  }
}
const here = path.dirname(fileURLToPath(import.meta.url))
loadEnvFile(path.resolve(here, '../../../.env.test'))

const NEON_API = 'https://console.neon.tech/api/v2'

let projectId
let branchId

async function neon(method, path, body) {
  const res = await fetch(`${NEON_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NEON_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Neon API ${method} ${path} failed (${res.status}): ${text}`)
  }

  return res.json()
}

// ONE BRANCH PER WORKER, so test files can run in parallel.
//
// The suites that touch a real database TRUNCATE shared tables in beforeEach, so two
// files running at once against one database delete each other's fixtures. That is why
// this ran with fileParallelism: false — the constraint was never CPU, it was that
// there was one database.
//
// Schema-per-worker would be cheaper, but the branch is created from a parent that
// ALREADY HAS the tables — no test file migrates from nothing — so a fresh empty schema
// would have nothing in it. A branch is copy-on-write, so N of them cost close to what
// one costs, and each arrives with the schema already there.
//
// WORKERS is a TRADE, not a dial to turn up. Each branch costs provisioning time and a
// sequential prepare() pass (~2s), so raising it adds fixed setup to save variable run
// time, and the run time is dominated by the slowest single FILE — which no amount of
// parallelism splits. Measured on a 16-core machine against eu-central-1:
//
//   1 worker    245s      (what this was)
//   3 workers    81s
//   4 workers   ~56s of tests + ~8s prepare
//
// So the useful range ends early: these tests are network waits, not CPU work, and 16
// branches would spend longer being created than they save. 4 is the default; override
// with TEST_WORKERS when a machine or a network says otherwise.
const WORKERS = Math.max(1, Math.min(16, Number(process.env.TEST_WORKERS || 4)))

let branchIds = []


// The module migrations, by directory and bookkeeping table — the same pairs
// awareness/facts/event-registry pass to knex themselves (see each index.js).
//
// ORDER MATTERS: awareness's 001 puts a foreign key on whitebox_sessions, and facts'
// 001 one on whitebox_passports. Those two tables are not migrations at all — passports
// and sessions create them lazily from init() behind a hasTable check — so init has to
// run first or the awareness migration fails on a missing relation.
const MIGRATIONS = [
  ['event-registry', 'whitebox_event_registry_migrations'],
  ['awareness', 'whitebox_awareness_migrations'],
  ['facts', 'whitebox_facts_migrations'],
]

const quiet = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} }

// Bring ONE branch up to the full schema.
//
// Deliberately sequential across branches (see the caller): passports and sessions keep
// their db handle in a module-level singleton, so two concurrent prepares would each
// overwrite the other's and issue DDL against the wrong branch. The work is a handful of
// round trips per branch, and correctness here is worth more than the seconds.
async function prepare(url) {
  const db = knex({ client: 'pg', connection: url, pool: { min: 0, max: 2 } })
  try {
    // awareness's chunk table has a vector(1536) column, so pgvector has to be there
    // before its migrations run. Branches inherit it from the parent, but a branch is
    // only as prepared as its parent was — asserting it here means a test run does not
    // depend on the state of a long-lived dev branch nobody is maintaining for us.
    await db.raw('CREATE EXTENSION IF NOT EXISTS vector')

    const passports = await import('../../src/passports.js')
    const sessions = await import('../../src/sessions.js')
    await passports.init({ db, logger: quiet, config: {} })
    await sessions.init({ db, passports, logger: quiet, config: {} })
    for (const [dir, tableName] of MIGRATIONS) {
      await db.migrate.latest({
        directory: path.resolve(here, '../../src', dir, 'migrations'),
        tableName,
        loadExtensions: ['.js'],
      })
    }
  } finally {
    await db.destroy()
  }
}

export async function setup() {
  projectId = process.env.NEON_PROJECT_ID
  if (!projectId) throw new Error('NEON_PROJECT_ID is required')
  if (!process.env.NEON_API_KEY) throw new Error('NEON_API_KEY is required')

  const stamp = Date.now()
  console.log(`\nCreating ${WORKERS} Neon branch(es)…`)
  const started = Date.now()

  // In parallel: serially this is the slowest part of the run.
  const made = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) =>
      neon('POST', `/projects/${projectId}/branches`, {
        branch: { name: `test-${stamp}-w${i + 1}` },
        endpoints: [{ type: 'read_write' }],
      })))

  branchIds = made.map(d => d.branch.id)
  const urls = made.map(d => d.connection_uris[0].connection_uri)

  // MIGRATE EVERY BRANCH before any test runs.
  //
  // The suite had a hidden inter-file dependency: whitebox_passports and
  // whitebox_sessions come from the parent branch, but the awareness / facts /
  // event-registry tables are created by whichever test file called that module's
  // migrate() FIRST. Running sequentially, an awareness suite happened to go before
  // the selector suites that read its table, so nobody noticed. Run in parallel, a
  // file can land on a branch where that has not happened yet and fails with
  // `relation "whitebox_awareness_exposures" does not exist`.
  //
  // Preparing the branch here removes the ordering dependency rather than working
  // around it: every worker starts from the same known schema, whatever runs first.
  const prepStart = Date.now()
  for (const url of urls) await prepare(url)
  console.log(`schema prepared on ${urls.length} branch(es) in ${Date.now() - prepStart}ms`)

  // Workers are separate processes forked from this one, so they inherit these. Each
  // picks its own by VITEST_POOL_ID — see tests/setup/worker-db.js.
  process.env.DATABASE_URLS = JSON.stringify(urls)
  // Kept for anything reading it directly (and for a single-worker run).
  process.env.DATABASE_URL = urls[0]
  branchId = branchIds[0]

  console.log(`${WORKERS} branch(es) ready in ${Date.now() - started}ms\n`)
}

export async function teardown() {
  if (!branchIds.length) return
  console.log(`\nDeleting ${branchIds.length} Neon branch(es)…`)
  // allSettled: one failed delete must not leave the rest behind, and a leaked test
  // branch is a copy of production-shaped data that nobody is watching.
  const done = await Promise.allSettled(
    branchIds.map(id => neon('DELETE', `/projects/${projectId}/branches/${id}`)))
  const failed = done.filter(r => r.status === 'rejected')
  if (failed.length) {
    console.error(`WARNING: ${failed.length} branch(es) could not be deleted — delete them by hand:`)
    for (const id of branchIds) console.error(`  ${id}`)
  } else {
    console.log('branches deleted\n')
  }
}
