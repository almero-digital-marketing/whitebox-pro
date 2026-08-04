import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import * as adminConsole from '../src/console.js'

// A fixture dist, so these tests do not depend on whitebox-pro-ui being installed. It
// deliberately is NOT a workspace here (it carries primevue/tinymce/echarts, which the
// server has no business installing to run its own tests), so a fresh clone cannot resolve
// it and a test asserting otherwise would fail for everyone but us.
function fixtureDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-console-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'export default 1\n')
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>\n')
  return dir
}

// listen(0) + fetch, matching the pattern the other route tests use — no extra dependency.
//
// The stub routes stand in for what plugins register. Most of these tests exist to prove
// the console cannot shadow them, which is why it is mounted last in server.js.
let server, base, dist
beforeAll(async () => {
  dist = fixtureDist()
  const app = express()
  app.get('/health', (req, res) => res.json({ db: 'ok' }))
  app.get('/oauth/permissions/catalog', (req, res) => res.json({ items: [] }))
  expect(adminConsole.mount(app, { dist })).toBe(true)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => {
  await new Promise(r => server.close(r))
  fs.rmSync(dist, { recursive: true, force: true })
})

const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
const get = (path, headers = HTML) => fetch(base + path, { headers })

describe('admin console', () => {

  it('serves the SPA shell at the root', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
  })

  it('falls back to the shell for client-side routes with no file behind them', async () => {
    for (const path of ['/users', '/people/abc-123', '/analytics/reports/1']) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type'), path).toMatch(/html/)
    }
  })

  it('never shadows an API route', async () => {
    expect(await get('/health').then(r => r.json())).toEqual({ db: 'ok' })
    expect(await get('/oauth/permissions/catalog').then(r => r.json())).toEqual({ items: [] })
  })

  it('lets an API 404 stay a 404 for a client that asked for JSON', async () => {
    const res = await get('/no/such/route', { Accept: 'application/json' })
    expect(res.status).toBe(404)
  })

  // req.accepts('html') alone would be TRUE for `Accept: */*`, so a bare curl to a mistyped
  // API path would get the console's HTML with a 200 instead of a JSON 404 — the worst
  // possible answer for a machine client. Asking which of json/html is PREFERRED gets it
  // right: */* resolves to the first listed.
  it('and for Accept: */* — a bare curl must not receive the SPA', async () => {
    const res = await get('/no/such/route', { Accept: '*/*' })
    expect(res.status).toBe(404)
  })

  it('does not intercept non-GET requests', async () => {
    const res = await fetch(base + '/no/such/route', { method: 'POST', headers: HTML })
    expect(res.status).toBe(404)
  })

  it('serves the shell at / for ANY client, so a bare curl does not look like an outage', async () => {
    const res = await get('/', { Accept: '*/*' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
  })

  // The classic SPA cache trap: hashed assets can live forever, index.html must not, or a
  // browser keeps requesting the previous build's filenames and never sees an update.
  it('never long-caches the shell, whose filename does not change', async () => {
    for (const path of ['/', '/users']) {
      const res = await get(path)
      expect(res.headers.get('cache-control'), path).not.toMatch(/immutable|max-age=31536000/)
    }
  })

  it('serves hashed assets as immutable, since their names change every build', async () => {
    const shell = await get('/').then(r => r.text())
    const asset = (shell.match(/\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0]
    expect(asset, 'index.html referenced no hashed asset').toBeTruthy()
    const res = await get(asset, {})
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/immutable/)
  })
})

describe('admin console — not serving', () => {

  it('is a no-op when disabled, so an API-only deployment stays API-only', () => {
    const app = express()
    expect(adminConsole.mount(app, { enabled: false })).toBe(false)
  })
})

describe('admin console — resolution', () => {

  it('returns false when whitebox-pro-ui is not installed, rather than throwing', () => {
    // The normal API-only case: a deployment that never wanted a console must boot.
    expect(adminConsole.mount(express(), { dist: '/nonexistent/dist' })).toBe(false)
  })

  it('finds the real package when it IS installed', () => {
    const require_ = createRequire(import.meta.url)
    let installed = true
    try { require_.resolve('whitebox-pro-ui/package.json') } catch { installed = false }
    if (!installed) return   // fresh clone — ui is not a workspace, nothing to assert
    expect(adminConsole.mount(express())).toBe(true)
  })
})
