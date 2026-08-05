// Publish gate: fail if the built console carries values that belong to whoever built it.
//
// Run after `npm run build`, from prepublishOnly.
//
// This exists because of a real incident. whitebox-pro-ui@0.1.0 shipped with
// `02a35b96-2bf3-49d0-956a-fe8d242d1509` baked in — an OAuth client_id from a developer's own
// database — because the console read VITE_OAUTH_CLIENT_ID at BUILD time and Vite loads
// `.env.local` in every mode, including production. Every install then failed with "Unknown
// client_id". Nothing caught it: the secret scanner looks for credential PATTERNS and a bare
// UUID is not one, and the tarball check verified the file list rather than the contents.
//
// A published artifact must be a function of the repository alone. This asserts that in both
// directions — the right constant is present, and nothing machine-specific is.
import { readdir, readFile } from 'fs/promises'
import path from 'path'

const DIST = path.resolve(import.meta.dirname, '..', 'dist')

// Must be PRESENT. Catches the opposite failure: someone reintroduces an env-var lookup and
// the build silently produces an empty client_id, which fails identically at runtime.
const REQUIRED = [
  { what: 'the well-known OAuth client id', needle: 'whitebox-console' },
]

// Must be ABSENT. Verified as zero in a clean build before being asserted — an invariant that
// was already false would just be noise.
const FORBIDDEN = [
  {
    what: 'a UUID (an install-specific id such as an OAuth client_id)',
    re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    // The exact value that shipped in 0.1.0, so the message can name the precedent.
    hint: 'VITE_OAUTH_CLIENT_ID used to do this — see the note at the top of this file',
  },
  {
    what: 'a loopback or private address (a developer\'s API base)',
    re: /localhost:\d+|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+/,
    hint: 'VITE_WB_API_BASE is the remaining build-time override that could do this',
  },
]

const files = (await readdir(DIST, { recursive: true }))
  .filter(f => f.endsWith('.js') || f.endsWith('.css'))

if (!files.length) {
  console.error('check-build: no built files in dist/ — did the build run?')
  process.exit(1)
}

const failures = []
const present = new Set()

for (const rel of files) {
  const text = await readFile(path.join(DIST, rel), 'utf8')
  for (const r of REQUIRED) if (text.includes(r.needle)) present.add(r.needle)
  for (const f of FORBIDDEN) {
    const m = f.re.exec(text)
    if (m) failures.push({ rel, what: f.what, found: m[0], hint: f.hint })
  }
}

for (const r of REQUIRED) {
  if (!present.has(r.needle)) {
    failures.push({ rel: 'dist/', what: `MISSING ${r.what} ("${r.needle}")`, found: '—',
      hint: 'the console cannot authenticate without it' })
  }
}

console.log(`Build check — ${files.length} file(s) in dist/`)
if (!failures.length) {
  console.log('Clean — nothing install-specific, and the client id constant is present.')
  process.exit(0)
}

for (const f of failures) {
  console.error(`  ✗ ${f.rel}`)
  console.error(`    ${f.what}`)
  if (f.found !== '—') console.error(`    found: ${f.found}`)
  console.error(`    ${f.hint}`)
}
console.error('\nBuild check FAILED — refusing to publish a bundle that is not reproducible.')
process.exit(1)
