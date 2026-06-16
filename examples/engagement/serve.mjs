#!/usr/bin/env node
// Dev server for the WhiteBox engagement demo.
//
//   • serves the static demo page (index.html)
//   • bundles main.js — the real whitebox-client + engagement plugin — with
//     esbuild on the fly (no CDN, works offline)
//   • reverse-proxies API + WebSocket traffic to a running whitebox-server
//     so the browser talks to it SAME-ORIGIN (the server has no HTTP CORS)
//
//   Run:  WB_SERVER=http://localhost:3000 node serve.mjs
//   Then open http://localhost:5173

import http from 'node:http'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 5173)
const TARGET = new URL(process.env.WB_SERVER || 'http://localhost:3000')
const TARGET_PORT = Number(TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80))

// Anything under these prefixes is forwarded to the whitebox-server.
const API_PREFIXES = [
  '/sessions', '/engagement', '/socket.io', '/analytics',
  '/mail', '/voip', '/crm', '/conversions', '/health', '/output',
]
const isApi = (url) => API_PREFIXES.some(p => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))

async function bundleMain() {
  const res = await build({
    entryPoints: [path.join(__dirname, 'main.js')],
    bundle: true,
    format: 'esm',
    write: false,
    sourcemap: 'inline',
    logLevel: 'warning',
  })
  return res.outputFiles[0].text
}

function proxyHttp(req, res) {
  const upstream = http.request({
    protocol: TARGET.protocol,
    hostname: TARGET.hostname,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: TARGET.host },
  }, up => {
    res.writeHead(up.statusCode, up.headers)
    up.pipe(res)
  })
  // Without a timeout, an unreachable-but-not-refused backend would hang the
  // browser fetch forever (and with it the SDK's session resolve). Fail fast.
  upstream.setTimeout(6000, () => upstream.destroy(new Error('upstream timeout (no response in 6s)')))
  upstream.on('error', err => {
    console.error(`proxy ${req.method} ${req.url} → ${err.message}`)
    if (res.headersSent) return res.end()
    res.writeHead(504, { 'content-type': 'text/plain' })
    res.end(`proxy: ${err.message} — is whitebox-server running at ${TARGET.href}?`)
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  try {
    if (isApi(req.url)) return proxyHttp(req, res)

    const noCache = { 'cache-control': 'no-store, no-cache, must-revalidate' }
    const url = req.url.split('?')[0]
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...noCache })
      return res.end(await readFile(path.join(__dirname, 'index.html')))
    }
    if (url === '/main.js') {
      const js = await bundleMain()
      console.log(`bundled main.js (${(js.length / 1024).toFixed(0)} kB)`)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...noCache })
      return res.end(js)
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err?.stack || err))
  }
})

// WebSocket upgrade (socket.io) — pipe raw bytes to the target.
server.on('upgrade', (req, clientSocket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET.hostname, () => {
    const headers = { ...req.headers, host: TARGET.host }
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`
    raw += '\r\n'
    upstream.write(raw)
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})

server.listen(PORT, () => {
  console.log(`WhiteBox engagement demo [v2: proxy-timeout + no-cache] → http://localhost:${PORT}`)
  console.log(`proxying API + WS → ${TARGET.href}`)
})
