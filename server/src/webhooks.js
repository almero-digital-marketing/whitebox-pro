import crypto from 'node:crypto'
import logger from './logger.js'

const QUEUE_NAME = 'whitebox:webhooks'
let webhookQueue

// GET and HEAD must not carry a body (RFC 9110 §9.3) — fetch() throws
// outright on GET/HEAD with one. DELETE and OPTIONS may, so they're not here.
const BODYLESS = new Set(['GET', 'HEAD'])
const hasBody = (method) => !BODYLESS.has(String(method || 'POST').toUpperCase())

function init(options) {
  const { concurrency = 5, retries = 3, timeout = 10000 } = options.config.webhooks || {}

  webhookQueue = options.queue.createQueue(QUEUE_NAME)

  options.queue.createWorker(QUEUE_NAME, async job => {
    const { url, method = 'POST', body, headers = {} } = job.data
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: hasBody(method) ? body : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`Webhook responded ${response.status}: ${url}`)
    logger.debug('Webhook delivered: %s', url)
  }, {
    concurrency,
    defaultJobOptions: {
      attempts: retries,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    },
  })
}

// `secret`, when given, HMAC-signs the request so a receiver can verify it
// really came from this whitebox instance — computed here, synchronously, in
// the caller's own process, so the raw secret never touches Redis job data
// (only the derived signature headers are enqueued). The body is serialized
// once, here, and passed through as-is to the worker — never re-JSON.stringify
// it from job data, so the signed bytes can't diverge from the transmitted
// bytes across the Redis round-trip.
// `jobId`, when given, makes a repeated send() with the same id a BullMQ
// no-op — lets a retried caller (e.g. a journey step re-run after a crash)
// enqueue idempotently instead of firing the webhook twice.
function send({ url, method = 'POST', data, headers = {}, secret, jobId }) {
  if (!url) return
  const body = hasBody(method) ? JSON.stringify(data) : undefined
  let finalHeaders = headers
  if (secret && body) {
    const timestamp = String(Date.now())
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    finalHeaders = { ...headers, 'X-Whitebox-Signature': `t=${timestamp},v1=${signature}`, 'X-Whitebox-Timestamp': timestamp }
  }
  return webhookQueue.add('webhook', { url, method, body, headers: finalHeaders }, jobId ? { jobId } : undefined)
}

export { init, send }
