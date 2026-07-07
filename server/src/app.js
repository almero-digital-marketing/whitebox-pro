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

  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  app.use((req, res, next) => {
    req.id = randomUUID()
    req.log = logger.child({ reqId: req.id, method: req.method, url: req.url })
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
