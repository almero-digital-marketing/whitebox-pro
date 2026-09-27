import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import * as webhooks from '../src/webhooks.js'
import logger from '../src/logger.js'

function makeQueue() {
  const queue = { add: vi.fn(async () => ({})) }
  const q = { createQueue: vi.fn(() => queue), createWorker: vi.fn(() => ({ on: vi.fn() })) }
  webhooks.init({ config: {}, queue: q })
  return { queue }
}

describe('webhooks.send — no secret (regression: must stay byte-identical to pre-signing behavior)', () => {
  it('enqueues the same job data/headers shape as before signing existed', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: { a: 1 } })
    expect(queue.add).toHaveBeenCalledWith(
      'webhook',
      { url: 'https://example.com/hook', method: 'POST', body: JSON.stringify({ a: 1 }), headers: {} },
      undefined,
    )
  })

  it('passes explicit headers through untouched when no secret is given', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: { a: 1 }, headers: { 'X-Custom': 'v' } })
    expect(queue.add.mock.calls[0][1].headers).toEqual({ 'X-Custom': 'v' })
  })
})

describe('webhooks.send — with secret', () => {
  it('adds a verifiable HMAC-SHA256 signature header over `${timestamp}.${body}`', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: { a: 1 }, secret: 'shh' })
    const [, jobData] = queue.add.mock.calls[0]
    const sig = jobData.headers['X-Whitebox-Signature']
    const ts = jobData.headers['X-Whitebox-Timestamp']
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(ts).toBe(sig.match(/t=(\d+)/)[1])
    const expected = crypto.createHmac('sha256', 'shh').update(`${ts}.${jobData.body}`).digest('hex')
    expect(sig).toBe(`t=${ts},v1=${expected}`)
  })

  it('merges signature headers alongside caller-supplied headers, not over them', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: { a: 1 }, secret: 'shh', headers: { 'X-Custom': 'v' } })
    const headers = queue.add.mock.calls[0][1].headers
    expect(headers['X-Custom']).toBe('v')
    expect(headers['X-Whitebox-Signature']).toBeDefined()
  })

  it('does not sign a GET (no body to sign)', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', method: 'GET', data: { a: 1 }, secret: 'shh' })
    const jobData = queue.add.mock.calls[0][1]
    expect(jobData.body).toBeUndefined()
    expect(jobData.headers['X-Whitebox-Signature']).toBeUndefined()
  })

  it('never puts the raw secret into the enqueued job data', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: { a: 1 }, secret: 'super-secret-value' })
    const serialized = JSON.stringify(queue.add.mock.calls[0][1])
    expect(serialized).not.toContain('super-secret-value')
  })
})

// GET and HEAD must not carry a body (RFC 9110 §9.3) — fetch() throws outright
// if one is supplied. DELETE and OPTIONS may, so they keep theirs.
describe('webhooks.send — bodyless methods', () => {
  for (const method of ['GET', 'HEAD']) {
    it(`sends no body for ${method}`, async () => {
      const { queue } = makeQueue()
      await webhooks.send({ url: 'https://example.com/hook', method, data: { a: 1 } })
      expect(queue.add.mock.calls[0][1].body).toBeUndefined()
    })
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    it(`still sends a body for ${method}`, async () => {
      const { queue } = makeQueue()
      await webhooks.send({ url: 'https://example.com/hook', method, data: { a: 1 } })
      expect(queue.add.mock.calls[0][1].body).toBe('{"a":1}')
    })
  }

  it('is case-insensitive about the method', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', method: 'head', data: { a: 1 } })
    expect(queue.add.mock.calls[0][1].body).toBeUndefined()
  })
})

describe('webhooks.send — jobId (idempotent enqueue)', () => {
  it('passes jobId through as the queue.add options when given', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: {}, jobId: 'journey-webhook:enr1:step1' })
    expect(queue.add.mock.calls[0][2]).toEqual({ jobId: 'journey-webhook:enr1:step1' })
  })

  it('passes undefined options when no jobId is given', async () => {
    const { queue } = makeQueue()
    await webhooks.send({ url: 'https://example.com/hook', data: {} })
    expect(queue.add.mock.calls[0][2]).toBeUndefined()
  })
})

describe('webhooks.send — no url', () => {
  it('returns early without touching the queue', async () => {
    const { queue } = makeQueue()
    const result = await webhooks.send({ data: {} })
    expect(result).toBeUndefined()
    expect(queue.add).not.toHaveBeenCalled()
  })
})

describe('webhooks.send — a missing url is a misconfiguration, not a no-op', () => {
  // logger's default export is a Proxy whose get() returns a FRESH bound
  // function each access, so vi.spyOn cannot install through it — the spy is
  // never the function send() ends up calling. Assigning works, because the
  // proxy's set() forwards to the live pino instance.
  const captureWarnings = () => {
    const lines = []
    const original = logger.warn
    logger.warn = (...args) => lines.push(args.join(' '))
    return { lines, restore: () => { logger.warn = original } }
  }

  it('logs a warning and enqueues nothing', () => {
    const { queue } = makeQueue()
    const { lines, restore } = captureWarnings()

    webhooks.send({ method: 'post', data: { a: 1 } })

    expect(queue.add).not.toHaveBeenCalled()
    expect(lines).toHaveLength(1)
    restore()
  })

  it('names the keys it received but never their values — secret passes through here', () => {
    makeQueue()
    const { lines, restore } = captureWarnings()

    webhooks.send({ method: 'post', secret: 'super-secret-value', data: { a: 1 } })

    const logged = lines.join(' ')
    expect(logged).toContain('secret')              // the key name is useful
    expect(logged).not.toContain('super-secret-value')
    restore()
  })

  it('survives being called with nothing at all', () => {
    const { queue } = makeQueue()
    const { restore } = captureWarnings()

    expect(() => webhooks.send()).not.toThrow()

    expect(queue.add).not.toHaveBeenCalled()
    restore()
  })
})
