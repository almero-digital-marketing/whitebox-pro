// WhiteBox engagement demo — wires the real client SDK to the page.
// Bundled by serve.mjs (esbuild) from the workspace packages.

import whitebox from 'whitebox-client'
import engagementPlugin from 'whitebox-client-plugin-engagement'

const logEl = document.querySelector('#log')
const statusEl = document.querySelector('#status')
const passportEl = document.querySelector('#passport')

function log(kind, data) {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  const time = new Date().toLocaleTimeString()
  row.innerHTML = `<span class="t">${time}</span> <span class="k">${kind}</span> ` +
    `<span class="d">${escapeHtml(typeof data === 'string' ? data : JSON.stringify(data))}</span>`
  logEl.prepend(row)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// Served same-origin via serve.mjs, which proxies /sessions, /socket.io,
// /engagement, … to the real whitebox-server. So the SDK url is just us.
const wb = whitebox({
  url: location.origin,
  logger: {
    debug: () => {},
    warn:  (...a) => log('warn', a.join(' ')),
    error: (...a) => log('error', a.join(' ')),
  },
  plugins: [
    // Short flush interval + small batch so events show up quickly in the demo.
    engagementPlugin({ flushIntervalMs: 2000, batchSize: 5 }),
  ],
})

// The plugin emits a local event for every tracked read — mirror them to the log.
wb.on('engagement.text',  e => log('text',  `“${e.id}” ${e.length_chars}c · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`))
wb.on('engagement.image', e => log('image', `${e.id} · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`))
wb.on('engagement.video', e => log('video', `${e.id} · ${e.total_watched_s}s watched · ${e.completion_pct}%${e.partial ? ' · partial' : ''}`))

await wb.ready
statusEl.textContent = 'connected'
statusEl.className = 'ok'
passportEl.textContent = wb.passportId || '(none — is the server up?)'
log('ready', `passport ${wb.passportId}`)

// Wire the toolbar buttons.
document.querySelector('#flush').addEventListener('click', () => {
  wb.engagement.flush()
  log('flush', 'forced flush')
})
document.querySelector('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wb.passportId || '')
  log('copy', 'passport id copied')
})

// Expose for the console — poke at it manually if you like.
window.wb = wb
