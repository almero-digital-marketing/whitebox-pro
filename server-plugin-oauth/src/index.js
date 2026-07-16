// Self-hosted OAuth 2.1 authorization server for WhiteBox — no external
// identity provider account required. Issues JWTs that whitebox-pro-auth-auth0's
// generic jwt() verifier can validate unmodified, so it composes into
// config.mcp.auth and any plugin's `auth` option exactly like Auth0 does:
//
//   import { oauth } from 'whitebox-pro-server-plugin-oauth'
//   import { jwt } from 'whitebox-pro-auth-auth0'
//
//   plugins: [
//     oauth({ issuer: 'http://localhost:3000/oauth', audience: 'https://whitebox/api' }),
//     …
//   ],
//   mcp: {
//     auth: jwt({ issuer: 'http://localhost:3000/oauth', audience: 'https://whitebox/api', scope: 'mcp:use' }),
//   },
//
// Public clients only (PKCE S256 required, no client_secret) and pre-
// registered clients only (no Dynamic Client Registration) — see
// scripts/create-admin.mjs and scripts/create-client.mjs to bootstrap.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './store.js'
import * as users from './users.js'
import * as keys from './keys.js'
import { mountRoutes } from './routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function oauth(options = {}) {
  const { issuer, audience } = options
  if (!issuer) throw new Error('oauth(): issuer is required, e.g. "http://localhost:3000/oauth"')
  if (!audience) throw new Error('oauth(): audience is required — the value every issued token\'s aud claim carries')

  // basePath (where this mounts in Express) is DERIVED from issuer's own
  // path, not a second independently-set option — issuer and the URLs this
  // server actually serves must never be able to drift out of sync with
  // each other (a mismatch there would make the discovery document lie
  // about where its own endpoints live).
  const basePath = new URL(issuer).pathname.replace(/\/$/, '') || '/oauth'

  return {
    name: 'oauth',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_oauth_migrations',
      })
    },

    async register(app, ctx) {
      const { db, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'oauth' })

      store.init({ db })
      users.init({ db })
      keys.init({ db })

      mountRoutes(app, { basePath, issuer, audience, logger })

      logger.info('Built-in OAuth 2.1 authorization server ready at %s', basePath)
    },
  }
}
