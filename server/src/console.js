// Serve the admin console, if it is installed.
//
// `whitebox-pro-ui` is an ordinary dependency: install it and the console appears at the
// root of the same origin as the API. Nothing to build, no static host to run, no reverse
// proxy to configure. Omit it and this is a no-op — the server is API-only.
//
// Same origin matters and is not incidental. The console holds an OAuth access token and
// talks to a dozen plugin surfaces; served from a different origin it would need CORS with
// credentials on every one of them, plus its own reverse proxy to reach them. Serving it
// from the process that owns those routes makes all of that disappear.
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
import express from 'express'
import logger from './logger.js'

const require = createRequire(import.meta.url)

// Registered LAST, after every plugin, so it can never shadow an API route: express.static
// only answers for files that exist, and the fallback below defers anything that is not a
// browser navigation.
// `dist` overrides where the console is served from — for a fork or a custom build, and
// it is what lets this be tested without whitebox-pro-ui installed.
function mount(app, { enabled = true, dist: distOverride } = {}) {
  if (!enabled) {
    logger.info('Admin console disabled by config')
    return false
  }

  let dist = distOverride
  try {
    dist ??= path.join(path.dirname(require.resolve('whitebox-pro-ui/package.json')), 'dist')
  } catch {
    // Not installed. This is the normal API-only case, so it is debug rather than a warning
    // — a deployment that never wanted a console should not be told about one on every boot.
    logger.debug('whitebox-pro-ui is not installed — serving no admin console')
    return false
  }

  const index = path.join(dist, 'index.html')
  if (!fs.existsSync(index)) {
    // Installed but unbuilt: only reachable from a workspace/link checkout, since the
    // published package ships `dist` and nothing else. Worth a warning, because the intent
    // to have a console is clear and it is not going to appear.
    logger.warn('whitebox-pro-ui is installed but %s is missing — run its build', index)
    return false
  }

  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }))

  // SPA fallback for client-side routes (/users, /people/:id, …), which exist only in the
  // browser's router and have no file behind them.
  //
  // The accepts() test is what stops this swallowing API 404s. `req.accepts('html')` would
  // be TRUE for a bare `curl` (Accept: */*), so a mistyped API path would return the
  // console's HTML with a 200 instead of a JSON 404 — a confusing failure for a client that
  // asked for JSON. Asking which of the two is PREFERRED gets it right: a browser sends
  // `text/html,…` and wins html; `*/*` resolves to the first listed, json, and falls
  // through to the 404 it deserves.
  app.get(/.*/, (req, res, next) => {
    if (req.accepts(['json', 'html']) !== 'html') return next()
    res.sendFile(index)
  })

  logger.info('Admin console mounted at / (from %s)', dist)
  return true
}

export { mount }
