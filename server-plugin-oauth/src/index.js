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
  const { issuer, audience, appUrl, fromEmail } = options
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

    // This plugin's own entry in the aggregated permission catalog (see
    // server/src/plugins.js) — managing users & permissions is just another
    // module capability now, not a special is_admin flag. Never a default:
    // the only way to hold it is an explicit grant, or the '*' bootstrap
    // sentinel scripts/create-admin.mjs sets for the very first user.
    permissions: {
      items: [{ key: 'users:manage', label: 'Manage users & permissions', description: 'Invite, remove, and set permissions for teammates' }],
      defaults: [],
    },

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

      // Auto-bootstrap the first admin from ADMIN_EMAIL/ADMIN_PASSWORD (the
      // same env vars scripts/create-admin.mjs reads) when the users table
      // is completely empty — lets a fresh deploy self-bootstrap straight
      // from .env with no separate manual script run, handy for
      // containerized/automated deploys. Gated on the table being EMPTY
      // (not just "no admin yet"), so it only ever fires once: any existing
      // user, admin or not, skips it — safe to leave these two vars sitting
      // in .env permanently across every restart. Same validation as the
      // script (password length), same '*' wildcard sentinel, same
      // one-time-bootstrap-only semantics — see scripts/create-admin.mjs.
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !(await store.hasAnyUser())) {
        if (process.env.ADMIN_PASSWORD.length < 12) {
          logger.warn('ADMIN_EMAIL/ADMIN_PASSWORD are set but the password is under 12 characters — skipping admin auto-bootstrap')
        } else {
          const admin = await users.createUser({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, permissions: ['*'] })
          logger.info('Bootstrapped admin %s from ADMIN_EMAIL/ADMIN_PASSWORD (users table was empty)', admin.email)
        }
      }

      // Lazy lookup so plugin load order doesn't matter (mail may register
      // after oauth) — mirrors server-plugin-mail's own getShortener.
      const getMail = () => ctx.plugins?.mail?.service

      mountRoutes(app, {
        basePath, issuer, audience, logger, appUrl, fromEmail, getMail,
        permissionsCatalog: ctx.permissions?.catalog || [],
      })

      logger.info('Built-in OAuth 2.1 authorization server ready at %s', basePath)
    },
  }
}
