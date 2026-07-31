// whitebox-pro-server-plugin-shortener
//
// Branded short links on their own host that hide a passport behind an opaque
// code. A personalized link, when clicked, hard-binds the visitor's session to
// that customer — stitching any anonymous browsing history onto them via the
// core passport merge. The passport id never appears in a URL: only the code,
// then a single-use claim token in the redirect.
//
// Factory: shortener({ baseUrl, auth: { secret }, codeLength?, defaultTtlSec?,
//                       identityTtlSec?, claimTtlSec?, param? }).

import path from 'path'
import { fileURLToPath } from 'url'

import { resolveAuth } from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'
import * as store from './store.js'
import * as service from './service.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function shortener(options = {}) {
  return {
    name: 'shortener',

    // What our events mean (see server/src/event-catalog.js). One event, and it's
    // inbound: a claim is somebody following a short link we handed out. The link
    // going out was mail's or sms's send; this is the click coming back.
    events: {
      'shortener.claimed': 'in',
    },

    // What our event was ABOUT, for a feed row. live had no branch for us at all,
    // so a claim showed as a bare type name — the code is the one thing that says
    // WHICH link, and `merged` is the interesting part when it happens: the claim
    // joined an anonymous visitor to a known person.
    detail: {
      'shortener.claimed': (d) => {
        const code = d.code ? `/${d.code}` : null
        if (code && d.merged) return `${code} — merged identities`
        return code || (d.merged ? 'merged identities' : null)
      },
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_shortener_migrations',
      })
    },

    async register(app, ctx) {
      const { db, passports, awareness, events, webhooks, eventRegistry, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'shortener' })

      // The short host is just baseUrl's hostname (one source of truth: it both
      // builds short_url and gates the redirect route).
      const host = options.baseUrl ? new URL(options.baseUrl).hostname : null
      if (!host) logger.warn('shortener: no baseUrl configured — the /:code redirect is disabled')

      const config = {
        baseUrl: options.baseUrl,
        host,
        param: options.param || 'wb',
        codeLength: options.codeLength || 8,
        defaultTtlSec:  options.defaultTtlSec  ?? 60 * 60 * 24 * 30,  // link redirect lifetime
        identityTtlSec: options.identityTtlSec ?? 60 * 60 * 24,        // identity bind window
        claimTtlSec:    options.claimTtlSec    ?? 180,                 // claim-token TTL after a click
      }

      // Auth guards the management surface only; the redirect + claim are public.
      const authVerifier = resolveAuth(options.auth, { logger })
      const requireAuth = authVerifier
        ? authVerifier.middleware
        : (req, res) => res.status(401).json({ error: 'shortener: set auth to manage links' })

      const { notify } = createNotify({ webhooksConfig: options.webhooks, events, webhooks, eventRegistry })

      store.init({ db })
      service.init({ passports, awareness, logger, config, notify })

      mountRoutes(app, { requireAuth, host, logger })
      registerMcp(ctx, { service })

      logger.info('Shortener plugin ready (%s)', host ? `short host: ${host}` : 'no baseUrl — redirect off')
      return { service }
    },
  }
}
