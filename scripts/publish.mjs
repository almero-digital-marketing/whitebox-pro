#!/usr/bin/env node
// publish.mjs
//
// Same idea as mikser's own publish-mikser.mjs: scans for packages, asks the
// npm registry whether the EXACT local version is already published, and
// `npm publish`s anything that isn't. Whitebox's packages aren't all in one
// flat sibling folder like mikser's, though — they're split across two
// locations, so this scans both:
//   - this repo's own npm workspaces (server, client, adnetworks,
//     server-plugin-*, client-plugin-*)
//   - ../whitebox-pro-integrations (a sibling checkout of independent
//     provider packages — ad networks, mail, SMS, auth — same convention
//     scripts/link-integrations.sh already uses, including the
//     WB_INTEGRATIONS_DIR override)
// A package is included if its package.json `name` starts with "whitebox"
// and it isn't `private` (the workspace root itself is private, so it's
// naturally excluded without special-casing).
//
// Publishes sequentially so the npm OTP prompt (when 2FA is enabled) can be
// entered interactively for each package — batching them with a single OTP
// is brittle because the 30-second OTP window typically expires before the
// second publish starts.
//
// Before publishing anything, every candidate package is scanned for
// leaked credentials — not by grepping the working directory, but by
// running `npm pack --dry-run` and checking exactly the files THAT WOULD
// BE PUBLISHED (a package's `files` field, or .gitignore/.npmignore
// fallback, already keeps most things out — this is the last check on
// what's left: dangerous filenames like .env/.npmrc/*.pem, and file
// contents that look like a hardcoded password/token/secret/key). See
// lib/scanSecrets.mjs. Any finding blocks the run — pass --force to
// publish anyway once you've confirmed by eye it's a false positive
// (e.g. a README example like `secret: 'your-token-here'`).
//
// Usage:
//   node scripts/publish.mjs           # publish anything stale
//   node scripts/publish.mjs --dry     # report only, do not publish
//   node scripts/publish.mjs --only whitebox-pro-server,whitebox-pro-mail-mailgun
//   node scripts/publish.mjs --force   # publish even if the secret scan found something
//
// Flags can be combined. --only filters discovery to the named set
// (comma-separated, no spaces) — matched against package.json `name`,
// regardless of which of the two roots it lives in.

import { readdir, readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanPackage } from './lib/scanSecrets.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const INTEGRATIONS_DIR = process.env.WB_INTEGRATIONS_DIR || path.resolve(REPO_ROOT, '..', 'whitebox-pro-integrations')
const ROOTS = [REPO_ROOT, INTEGRATIONS_DIR]

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FORCE = argv.includes('--force')
const onlyArg = argv[argv.indexOf('--only') + 1]
const ONLY = argv.includes('--only') && onlyArg
    ? new Set(onlyArg.split(',').map(s => s.trim()).filter(Boolean))
    : null

async function findPackagesUnder(root) {
    let entries
    try {
        entries = await readdir(root, { withFileTypes: true })
    } catch {
        return []   // e.g. INTEGRATIONS_DIR not checked out on this machine
    }
    const pkgs = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const dir = path.join(root, entry.name)
        const pkgPath = path.join(dir, 'package.json')
        let pkg
        try {
            pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        } catch {
            continue
        }
        if (typeof pkg.name !== 'string') continue
        if (!pkg.name.startsWith('whitebox')) continue
        if (pkg.private === true) continue
        if (ONLY && !ONLY.has(pkg.name)) continue
        pkgs.push({ dir, name: pkg.name, version: pkg.version })
    }
    return pkgs
}

async function findPackages() {
    const found = await Promise.all(ROOTS.map(findPackagesUnder))
    return found.flat().sort((a, b) => a.name.localeCompare(b.name))
}

function isPublished(name, version) {
    // `npm view <name>@<version> version` prints the version when that
    // exact tarball exists on the registry, and prints nothing (exit 0)
    // when the package exists but the version doesn't. A non-zero exit
    // means the package itself is unknown — also "not published" for
    // our purposes, the publish call will succeed (first-time publish)
    // or fail loudly (name taken by someone else).
    const r = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
        encoding: 'utf8',
    })
    return r.status === 0 && r.stdout.trim() !== ''
}

function publish(dir) {
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['publish'], {
            cwd: dir,
            stdio: 'inherit', // lets the OTP prompt reach the user
        })
        child.on('exit', code => {
            if (code === 0) resolve()
            else reject(new Error(`npm publish exited with code ${code}`))
        })
        child.on('error', reject)
    })
}

const all = await findPackages()
if (all.length === 0) {
    console.log('No whitebox packages found under:\n  ' + ROOTS.join('\n  '))
    process.exit(0)
}

console.log(`Scanning ${all.length} package(s):`)
const todo = []
for (const pkg of all) {
    process.stdout.write(`  ${pkg.name.padEnd(40)} ${String(pkg.version).padEnd(10)} `)
    if (isPublished(pkg.name, pkg.version)) {
        console.log('[ok] already on npm')
    } else {
        console.log('[stale] not on npm')
        todo.push(pkg)
    }
}

if (todo.length === 0) {
    console.log('\nAll local versions are already published.')
    process.exit(0)
}

console.log(`\n${todo.length} package(s) to publish:`)
for (const p of todo) console.log(`  ${p.name}@${p.version}`)

console.log('\nScanning for leaked credentials in exactly what would be packed...')
let totalFindings = 0
for (const pkg of todo) {
    const findings = await scanPackage(pkg.dir)
    if (findings.length === 0) continue
    totalFindings += findings.length
    console.log(`\n  ${pkg.name}:`)
    for (const f of findings) {
        console.log(`    [${f.kind}] ${f.file} — ${f.what}${f.snippet ? ` -> ${f.snippet}` : ''}`)
    }
}

if (totalFindings > 0) {
    console.log(`\n${totalFindings} potential secret(s) found across ${todo.length} package(s) — see above.`)
    if (!FORCE) {
        console.log('Refusing to publish. If you\'ve checked these by eye and they\'re false')
        console.log('positives (e.g. a README placeholder), re-run with --force to proceed anyway.')
        process.exit(1)
    }
    console.log('--force: proceeding despite the finding(s) above.')
} else {
    console.log('Clean — no filenames or content matched a known credential pattern.')
}

if (DRY) {
    console.log('\n--dry: stopping before publish.')
    process.exit(0)
}

console.log('\nPublishing sequentially. Enter OTP at each prompt.\n')

let ok = 0
let fail = 0
const failed = []
for (const pkg of todo) {
    console.log(`>>> ${pkg.name}@${pkg.version}`)
    try {
        await publish(pkg.dir)
        console.log(`    [ok] published\n`)
        ok++
    } catch (err) {
        console.error(`    [fail] ${err.message}\n`)
        fail++
        failed.push(`${pkg.name}@${pkg.version}`)
    }
}

console.log(`Done. ${ok} published, ${fail} failed.`)
if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log('  ' + f)
    process.exit(1)
}
