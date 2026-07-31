import path from 'path'
import { fileURLToPath } from 'url'

import { collapse, urlPath } from 'whitebox-pro-server/event-format'

import * as content from './content.js'
import * as sections from './sections.js'
import * as text from './text.js'
import * as videos from './videos.js'
import * as images from './images.js'
import * as links from './link.js'
import { resolveAuth } from 'whitebox-pro-server/auth'

import { createDispatch, KIND_BY_TYPE, batchSchema } from './events.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: engagement({ auth: { secret }, image: { detail }, video: { visionDetail } }).
// Server options are auth + the AI vision detail used to caption images / video
// frames. The reading-detection knobs (cps, dwell, viewport ratios) are CLIENT-
// side — set on engagementPlugin({ text: { cps } }) in the browser, not here.
export function engagement(options = {}) {
  return {
    name: 'engagement',

    // No `events` — we emit none, on purpose. A touch is recorded as AWARENESS
    // rather than as its own event type, because emitting both would double-count
    // one interaction in the traffic totals.
    //
    // But we still author those awareness rows, so we describe them. Core emits
    // `awareness.recorded`; the payload is ours (see text.js / videos.js /
    // images.js), and the catalog routes a row back to the plugin that produced
    // it via `data.plugin`. Core's generic version is the fallback for rows from
    // a plugin that declared nothing.
    detail: {
      'awareness.recorded': (d) => {
        // WHAT was consumed — 'video' | 'text' | 'image' | 'section' | 'link' —
        // is the distinction that only survives here, and it is the first thing
        // you want to know.
        const kind = d.source || null
        // The real (already-redacted upstream) text beats an internal id every
        // time: "text · verify-text-1" told an operator nothing where the
        // sentence the person actually read was available.
        const said = collapse(d.preview) || null
        const where = urlPath(d.content_url) || d.content_id || null
        // Dwell is the difference between "scrolled past" and "read it", and
        // nothing else on the row carries it.
        const dwell = d.dwell_ms ? `${Math.round(d.dwell_ms / 1000)}s` : null
        return [kind, said || where, dwell].filter(Boolean).join(' · ') || null
      },
    },

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_engagement_migrations',
      })
    },

    async register(app, ctx) {
      const { db, connect, awareness, ai, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'engagement' })
      const engagementConfig = options

      // Singleton modules: capture deps once via init(), in dependency order.
      // content first (sections/text/videos/images import it as a namespace),
      // then the consumers which only need awareness/logger via init.
      content.init({ db, ai, options: engagementConfig, logger })
      sections.init({ awareness, logger })
      text.init({ awareness, logger })
      videos.init({ awareness, logger })
      images.init({ awareness, logger })
      links.init({ awareness, logger })

      const authVerifier = resolveAuth(engagementConfig.auth, { logger })
      if (!authVerifier) throw new Error('engagement: auth (a secret or a composed verifier) is required')
      const requireAuth = authVerifier.middleware

      const { dispatch, dispatchBatchEvent } = createDispatch({ sections, text, videos, images, links, logger })

      // Live events arrive over the existing connect socket. Batched envelope
      // is also supported for high-volume sessions.
      connect.onMessage(async ({ connectionId, event, data }) => {
        const kind = KIND_BY_TYPE[event]
        if (!kind && event !== 'engagement.batch') return

        const visitor = connect.find(connectionId)
        if (!visitor?.passportId) return

        if (event === 'engagement.batch') {
          const parsed = batchSchema.safeParse(data)
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'engagement.batch validation failed')
            return
          }
          for (const e of parsed.data.events) await dispatchBatchEvent(visitor, e)
          return
        }
        await dispatch(visitor, kind, data)
      })

      mountRoutes(app, { db, content, dispatchBatchEvent, requireAuth })
      registerMcp(ctx, { db, content })

      logger.info('Engagement plugin ready')

      // A service purely so monitoring surfaces can find status() — this plugin
      // is otherwise a write channel with nothing for other plugins to call.
      // content.js owns the cache, so it owns the answer (see docs/10-plugin-status.md).
      return { service: { status: content.status } }
    },
  }
}
