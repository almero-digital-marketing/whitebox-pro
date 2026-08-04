import express from 'express'
import { randomUUID } from 'crypto'
import logger from './logger.js'

// Trust X-Forwarded-For, but ONLY from a peer that cannot be a visitor.
//
// Behind a reverse proxy — nginx, Caddy, an ALB, Cloudflare, virtually any real
// deployment — `req.ip` is the PROXY's address, because that is who opened the
// connection. The visitor's address arrives in X-Forwarded-For instead, and Express
// ignores that header unless told to trust it. Left untrusted, everything that reads
// an address silently reads the proxy's: server-plugin-geolocation resolves every
// visitor to one place (or to nothing, from a loopback proxy), and the shortener's
// bare /:code redirect stops matching because req.hostname comes from the same
// mechanism. Both fail by doing nothing, which reads as "the feature is broken".
//
// The default below trusts the header only when the immediate peer is loopback,
// link-local or a private range — i.e. something that cannot be a client from the
// internet. So:
//
//   proxy on the same host or private network  →  header trusted, real visitor IP
//   server exposed directly to the internet    →  peer is public, header IGNORED
//
// That is what makes a default safe here. Defaulting to a hop count would trust
// whatever X-Forwarded-For a directly-connected client sent, letting anyone claim
// any address — in a system that records addresses against people.
const PRIVATE_PEERS = 'loopback, linklocal, uniquelocal'

function createApp({ trustProxy } = {}) {
  const app = express()

  // An explicit config.trustProxy always wins: a hop count (1 = exactly one reverse
  // proxy), or an address/subnet list. NEVER a bare `true` — that trusts the whole
  // chain with nothing having stripped a forged entry. See docs/04-configuration.md.
  app.set('trust proxy', trustProxy === undefined ? PRIVATE_PEERS : trustProxy)
  if (trustProxy === undefined) {
    logger.debug('trust proxy defaulted to %s (set config.trustProxy to override)', PRIVATE_PEERS)
  }

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
