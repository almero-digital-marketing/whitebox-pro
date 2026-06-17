// WhiteBox console — ask grounded questions about a passport and inspect its
// memory, with NO external Claude/OpenAI client: every call hits the server's
// own /analytics/* routes (the server does the LLM synthesis). Plain fetch, no
// SDK. serve.mjs proxies /analytics + hands us the analytics token from .env.

const $ = (s) => document.querySelector(s)
const passportEl = $('#passport')
const tokenEl = $('#token')
const qEl = $('#q')
const outEl = $('#out')
const srvHint = $('#srvhint')

const PREDEFINED = [
  'What do we know about this customer, and what have they done?',
  'Summarize their journey across mail, web, voip and CRM.',
  'What are they most interested in? Cite evidence with dates.',
  'Have they shown buying intent? What signals?',
  'What did they read on our pricing / marketing pages?',
  'Did they contact sales or request a callback?',
]

// ── persistence ────────────────────────────────────────────────────────────
passportEl.value = localStorage.getItem('wb.console.passport') || ''
tokenEl.value = localStorage.getItem('wb.console.token') || ''
passportEl.addEventListener('change', () => localStorage.setItem('wb.console.passport', passportEl.value.trim()))
tokenEl.addEventListener('change', () => localStorage.setItem('wb.console.token', tokenEl.value.trim()))

// Pull the analytics token from the server's .env so the console is turnkey.
;(async () => {
  try {
    const { analyticsToken } = await fetch('/console/config').then(r => r.json())
    if (analyticsToken && !tokenEl.value) { tokenEl.value = analyticsToken; localStorage.setItem('wb.console.token', analyticsToken) }
    srvHint.textContent = analyticsToken ? 'token loaded from .env' : 'paste your analytics token →'
  } catch { srvHint.textContent = 'paste your analytics token →' }
})()

// ── rendering ────────────────────────────────────────────────────────────────
function card({ kind, title, answer, evidence, context, json, error }) {
  const div = document.createElement('div')
  const cls = error ? 'err' : (kind === 'ask' ? '' : 'tool')
  const head = document.createElement('div')
  head.className = `qline ${cls}`
  head.innerHTML = `<span class="badge">${kind}</span>`
  head.appendChild(document.createTextNode(title))
  div.appendChild(head)

  if (answer != null) { const a = document.createElement('div'); a.className = 'answer'; a.textContent = answer; div.appendChild(a) }
  if (Array.isArray(evidence) && evidence.length) {
    const d = document.createElement('details')
    d.innerHTML = `<summary>evidence (${evidence.length})</summary>`
    for (const h of evidence) {
      const e = document.createElement('div'); e.className = 'ev'
      const ts = h.ts ? new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ') : '?'
      e.innerHTML = `<div class="meta">[${ts}] ${h.channel || '?'}/${h.direction || '?'}</div>`
      e.appendChild(document.createTextNode(h.chunk_text || ''))
      d.appendChild(e)
    }
    div.appendChild(d)
  }
  if (context && Object.keys(context).length) {
    const d = document.createElement('details'); d.innerHTML = '<summary>structured context</summary>'
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(context, null, 2); d.appendChild(pre); div.appendChild(d)
  }
  if (json !== undefined) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(json, null, 2); div.appendChild(pre) }
  outEl.prepend(div)
  return div
}

// ── server calls ─────────────────────────────────────────────────────────────
function need() {
  const passport_id = passportEl.value.trim(), token = tokenEl.value.trim()
  if (!passport_id) { card({ kind: 'error', title: 'Set a passport id first (paste one from the integration demo header).', error: true }); return null }
  if (!token) { card({ kind: 'error', title: 'Set the analytics token first.', error: true }); return null }
  return { passport_id, token }
}
async function authed(path, { method = 'GET', body } = {}, token) {
  const res = await fetch(path, {
    method,
    headers: { 'authorization': `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data?.error ? JSON.stringify(data.error) : `HTTP ${res.status}`))
  return data
}

async function ask(question) {
  const ctx = need(); if (!ctx) return
  const pending = card({ kind: 'ask', title: question }); pending.querySelector('.qline').insertAdjacentHTML('beforeend', ' <span class="spin">…thinking</span>')
  try {
    const r = await authed('/analytics/ask', { method: 'POST', body: { passport_id: ctx.passport_id, question } }, ctx.token)
    pending.remove()
    card({ kind: 'ask', title: question, answer: r.answer, evidence: r.evidence, context: r.context })
  } catch (e) { pending.remove(); card({ kind: 'error', title: `${question} — ${e.message}`, error: true }) }
}

async function tool(name) {
  const ctx = need(); if (!ctx) return
  try {
    let json, title = name
    if (name === 'timeline') json = await authed(`/analytics/timeline/${encodeURIComponent(ctx.passport_id)}`, {}, ctx.token)
    else if (name === 'context') json = await authed(`/analytics/context/${encodeURIComponent(ctx.passport_id)}`, {}, ctx.token)
    else if (name === 'recall') { const query = $('#recallq').value.trim() || 'pricing'; title = `recall: "${query}"`
      json = await authed('/analytics/recall', { method: 'POST', body: { passport_id: ctx.passport_id, query } }, ctx.token) }
    else if (name === 'population') { const query = $('#popq').value.trim() || 'pricing'; title = `population: "${query}"`
      json = await authed('/analytics/population', { method: 'POST', body: { query } }, ctx.token) }
    card({ kind: name === 'population' ? 'population' : name, title, json })
  } catch (e) { card({ kind: 'error', title: `${name} — ${e.message}`, error: true }) }
}

// ── wire up ──────────────────────────────────────────────────────────────────
const chips = $('#chips')
for (const q of PREDEFINED) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = q
  b.addEventListener('click', () => { qEl.value = q; ask(q) })
  chips.appendChild(b)
}
$('#ask').addEventListener('click', () => { const q = qEl.value.trim(); if (q) ask(q) })
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = qEl.value.trim(); if (q) ask(q) } })
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => tool(b.dataset.tool)))
