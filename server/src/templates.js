import path from 'path'
import crypto from 'crypto'
import { writeFile } from 'fs/promises'

const EXT_BY_MIME = {
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/css': 'css',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/xhtml+xml': 'xhtml',
  'application/rss+xml': 'rss',
  'application/atom+xml': 'atom',
  'application/javascript': 'js',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

function extFromContentType(contentType) {
  // Strip charset and other params: "text/html; charset=utf-8" → "text/html"
  const mime = contentType.split(';')[0].trim()
  return EXT_BY_MIME[mime] || 'bin'
}

// Dependencies + config captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let url
let base
let token
let outputFolder
let headers
const outputUrl = '/output'

export function init({ config }) {
  ;({ url, base = '/mikser', token, outputFolder } = config.mikser)
  headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// 503 is the ONLY status worth retrying, and the narrowness is the point.
//
// mikser binds its port at the end of its loaded phase but builds the catalog
// after it, so from 9.3.0 it answers 503 + Retry-After for the whole first build
// rather than rendering against an catalog that is not there yet. That is a
// server saying "not yet, come back": it returns instantly, holds no socket and
// spawns no headless browser, so retrying is free and is the entire point of the
// status.
//
// Everything else fails on the first attempt, deliberately. A 422 means the
// entity is unrenderable and asking again cannot change that. A timeout or a 5xx
// that is not 503 means mikser is struggling, and retrying a render it could not
// finish is what turns a slow content server into an unreachable one — every
// caller holding a socket while the queue behind it grows.
//
// The window is normally sub-second and easy to miss. It widens whenever mikser
// has to rebuild its cache from scratch, which a version upgrade forces via the
// schema stamp — and there it is long enough to swallow every notification a
// deployment sends. That is not hypothetical: it cost gpoint hours of email
// before the gate existed, and the retry was written into that consumer rather
// than here, which is why the same logic now has to exist twice. It belongs here
// so no future deployment has to discover it the same way.
const RETRY_BUDGET_MS = 30_000
const RETRY_MIN_DELAY_MS = 1_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function retryDelayMs(res) {
  const seconds = Number(res.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(seconds * 1000, RETRY_MIN_DELAY_MS)
    : RETRY_MIN_DELAY_MS
}

async function request(entity) {
  const deadline = Date.now() + RETRY_BUDGET_MS

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${url}${base}/render`, {
      method: 'POST',
      headers,
      body: JSON.stringify(entity),
    })

    if (res.status === 204) return null

    if (res.status === 503) {
      const delay = retryDelayMs(res)
      // Past the budget we give up rather than hold the caller open forever —
      // a bounded loss beats a request that never returns.
      if (Date.now() + delay > deadline) {
        const text = await res.text().catch(() => '')
        throw new Error(`Mikser still building after ${RETRY_BUDGET_MS}ms (503): ${text}`)
      }
      await sleep(delay)
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Mikser render failed (${res.status}): ${text}`)
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await res.arrayBuffer())

    return { contentType, buffer }
  }
}

export async function renderText(entity) {
  const result = await request(entity)
  if (!result) return null
  return result.buffer.toString('utf8')
}

export async function renderFile(entity) {
  const result = await request(entity)
  if (!result) return null

  const ext = extFromContentType(result.contentType)
  const filename = `${crypto.randomUUID()}.${ext}`
  await writeFile(path.join(outputFolder, filename), result.buffer)

  return `${outputUrl}/${filename}`
}
