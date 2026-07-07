import express from 'express'
import { randomUUID } from 'crypto'
import logger from './logger.js'

function createApp({ trustProxy } = {}) {
  const app = express()

  // Behind a reverse proxy (nginx, an ALB, Cloudflare — virtually any real
  // deployment), req.ip/req.hostname otherwise reflect the PROXY, not the
  // visitor — silently breaking anything that reads them (geolocation's IP
  // lookup, the shortener's public-host detection). Set via config.trustProxy
  // in whitebox.config.js. Use a hop count (e.g. 1 for exactly one reverse
  // proxy) or an explicit trusted address/subnet list — NEVER a bare `true`,
  // which trusts whatever X-Forwarded-For arrives with no proxy to have
  // stripped a client-forged one first. See docs/04-configuration.md.
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy)

  // Embeddable browser SDK, arbitrary customer origins — same permissive
  // policy as the socket.io transport in connect.js. Express auto-answers
  // OPTIONS for any registered route with a bare 200, but without these
  // headers the browser rejects the preflight and never sends the real
  // request (it never even reaches this server to log).
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Accept')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  app.use((req, res, next) => {
    req.id = randomUUID()
    req.log = logger.child({ reqId: req.id, method: req.method, url: req.url })
    // Access log on completion. Runs inside the request's async context, so
    // when tracing is on (see a deployment's otel bootstrap) the pino
    // instrumentation stamps trace_id/span_id onto it — making this the line
    // that correlates a request's logs to its trace.
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const duration_ms = Number(process.hrtime.bigint() - start) / 1e6
      req.log.info(
        { component: 'http', status: res.statusCode, duration_ms: Math.round(duration_ms * 10) / 10 },
        '%s %s %d',
        req.method, req.originalUrl || req.url, res.statusCode,
      )
    })
    next()
  })

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    const log = req.log || logger
    if (status >= 500) log.error({ err }, 'Unhandled error')
    else log.warn({ err }, 'Request error')
    res.status(status).json({ error: err.message || 'Internal server error' })
  })

  return app
}

export default createApp
