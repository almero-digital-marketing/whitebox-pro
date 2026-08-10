import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as templates from '../src/templates.js'

// templates.js is whitebox's mikser client — the one seam between "who and when"
// (this side) and "what it looks like" (mikser). It is also the only synchronous
// dependency on the critical path of a customer-facing action: a booking
// confirmation cannot be sent until a render comes back.
//
// Which is why the retry rule lives here rather than in each consumer. gpoint hit
// the failure first and fixed it in its own client, so the logic existed twice —
// once correctly and once not.

const RENDERED = { 'content-type': 'text/html' }

function mockFetch(responses) {
  const calls = []
  const fetch = vi.fn(async (u, init) => {
    calls.push({ url: u, body: init?.body })
    const next = responses.shift()
    if (typeof next === 'function') return next()
    return next
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}

const res = (status, { headers = {}, body = '' } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
})

beforeEach(() => {
  templates.init({ config: { mikser: { url: 'http://cms:3001', token: 't' } } })
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The retry sleeps, so every test that exercises it has to let the timers run.
const run = async (p) => {
  const settled = p.catch((e) => ({ __err: e }))
  await vi.runAllTimersAsync()
  const out = await settled
  if (out && out.__err) throw out.__err
  return out
}

describe('templates.request — retrying mikser', () => {
  it('renders on the first try when mikser is ready', async () => {
    const { calls } = mockFetch([res(200, { headers: RENDERED, body: '<p>hi</p>' })])
    await expect(run(templates.renderText({ meta: { layout: 'x' } }))).resolves.toBe('<p>hi</p>')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://cms:3001/mikser/render')
  })

  it('retries through a 503 and returns the render', async () => {
    // mikser answers 503 for its whole first build cycle — it binds the port
    // before the catalog exists. Coming back a second later is the entire point
    // of the status.
    const { calls } = mockFetch([
      res(503, { headers: { 'retry-after': '1' }, body: '{"ready":false}' }),
      res(503, { headers: { 'retry-after': '1' }, body: '{"ready":false}' }),
      res(200, { headers: RENDERED, body: '<p>built</p>' }),
    ])
    await expect(run(templates.renderText({ meta: { layout: 'x' } }))).resolves.toBe('<p>built</p>')
    expect(calls).toHaveLength(3)
  })

  it('does NOT retry a 422 — the entity is unrenderable, asking again cannot help', async () => {
    const { calls } = mockFetch([res(422, { body: 'no layout' })])
    await expect(run(templates.renderText({ meta: {} }))).rejects.toThrow(/422/)
    expect(calls).toHaveLength(1)
  })

  it('does NOT retry a 500 — a struggling renderer must not be asked again', async () => {
    // Retrying a render mikser could not finish is what turns a slow content
    // server into an unreachable one.
    const { calls } = mockFetch([res(500, { body: 'boom' })])
    await expect(run(templates.renderText({ meta: {} }))).rejects.toThrow(/500/)
    expect(calls).toHaveLength(1)
  })

  it('gives up inside the budget when 503 never clears', async () => {
    const { calls } = mockFetch(Array.from({ length: 200 }, () =>
      res(503, { headers: { 'retry-after': '1' }, body: 'still building' })))
    await expect(run(templates.renderText({ meta: {} }))).rejects.toThrow(/still building after/)
    // ~30s budget at 1s apart: repeated, but bounded well short of the 200 queued.
    expect(calls.length).toBeGreaterThan(5)
    expect(calls.length).toBeLessThan(60)
  })

  it('honours Retry-After over the floor, and floors a missing one', async () => {
    const { calls } = mockFetch([
      res(503, { headers: { 'retry-after': '5' } }),
      res(503, {}),                                   // no header at all
      res(200, { headers: RENDERED, body: 'ok' }),
    ])
    await expect(run(templates.renderText({ meta: {} }))).resolves.toBe('ok')
    expect(calls).toHaveLength(3)
  })

  it('204 is "nothing to render", not a failure and not a retry', async () => {
    const { calls } = mockFetch([res(204)])
    await expect(run(templates.renderText({ meta: {} }))).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })
})
