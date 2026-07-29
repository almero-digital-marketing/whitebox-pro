// Scans exactly what `npm publish` would actually put in the tarball for
// one package (via `npm pack --dry-run --json`, not the whole working
// directory — a package's `files` field, or .gitignore/.npmignore fallback,
// already keeps plenty out; this is the last check on what's LEFT) for
// filenames and file contents that look like a leaked credential.
//
// A deliberately loose net: flags candidates for a human to look at rather
// than trying to perfectly classify real-vs-placeholder — missing a real
// secret is much more expensive than a false positive here.

import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DANGEROUS_NAME_PATTERNS = [
  { name: '.env file', re: /(^|\/)\.env(\.[^/]+)?$/i, exclude: /\.env\.(example|sample|template)$/i },
  { name: 'npm auth config (.npmrc)', re: /(^|\/)\.npmrc$/i },
  { name: 'private key / cert file', re: /\.(pem|key|p12|pfx|jks)$/i },
  { name: 'SSH private key', re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[^/]+)?$/i },
  { name: 'credentials/secrets file', re: /(^|\/)(credentials|secrets|service-account[^/]*)\.(json|ya?ml)$/i },
  { name: 'AWS credentials file', re: /(^|\/)\.aws\/credentials$/i },
]

const CONTENT_PATTERNS = [
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Stripe live key', re: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  // A literal string value assigned to a credential-shaped key — deliberately
  // does NOT match `secret: process.env.WB_SECRET` (no quote right after the
  // `:`/`=`), which is the normal, safe way these packages read config.
  { name: 'hardcoded password/token/secret/key literal',
    re: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*['"][^'"$]{8,}['"]/i },
]

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.wasm', '.mp3', '.mp4', '.pdf'])

// Docs are full of illustrative placeholder values ("secret: 'your-token'")
// that match the same shape a real hardcoded credential would — skip content
// scanning here, same as BINARY_EXT (filename checks above still apply to
// every file regardless, docs included).
const DOC_EXT = new Set(['.md', '.mdx', '.txt'])

export function packedFiles(dir) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed in ${dir}: ${r.stderr}`)
  const [info] = JSON.parse(r.stdout)
  return (info.files || []).map(f => f.path)
}

export async function scanPackage(dir) {
  const findings = []
  const files = packedFiles(dir)

  for (const rel of files) {
    for (const pat of DANGEROUS_NAME_PATTERNS) {
      if (pat.exclude?.test(rel)) continue
      if (pat.re.test(rel)) findings.push({ file: rel, kind: 'filename', what: pat.name })
    }

    const ext = path.extname(rel).toLowerCase()
    if (BINARY_EXT.has(ext) || DOC_EXT.has(ext)) continue
    let text
    try {
      text = await readFile(path.join(dir, rel), 'utf8')
    } catch {
      continue   // unreadable/binary — nothing to scan as text
    }
    for (const pat of CONTENT_PATTERNS) {
      const m = pat.re.exec(text)
      if (m) findings.push({ file: rel, kind: 'content', what: pat.name, snippet: m[0].slice(0, 60) })
    }
  }

  return findings
}
