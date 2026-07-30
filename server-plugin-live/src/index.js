// whitebox-pro-server-plugin-live
//
// A realtime operations view: what's arriving, what's leaving, and whether
// delivery is healthy. The question it answers is "is this thing working right
// now", which is a different question from any other module's.
//
// OWNS NO TABLES. Everything already exists:
//   · core's event registry is the durable record of every notify()
//   · notify()'s FIREHOSE_CHANNEL is the live one
//   · mail/sms expose windowed outbox stats
// This assembles them and adds the one thing none of them has: an opinion about
// which way the data was flowing (src/classify.js).
//
// READ-ONLY by construction — one permission, no write verifier, no write
// route. A monitor that can change things is a monitor you hesitate to open.
import * as service from './service.js'
import * as rest from './rest.js'
import * as stream from './stream.js'
import { resolveAuth } from 'whitebox-pro-server/auth'

export function live(options = {}) {
  return {
    name: 'live',

    permissions: {
      items: [
        { key: 'live:read', label: 'View Live', description: 'See realtime system traffic, delivery health and the event feed' },
      ],
      defaults: [],
    },

    async register(app, ctx) {
      const { logger: rootLogger, events, connect, eventRegistry } = ctx
      const logger = rootLogger.child({ component: 'live' })

      // One verifier: `auth` (no read/write split, because there is nothing to
      // write). The same one guards the REST routes and the socket handshake.
      const auth = resolveAuth(options.auth, { logger })
      if (!auth) throw new Error('live: auth (a secret, or a composed verifier) is required')

      if (!eventRegistry) throw new Error('live: ctx.eventRegistry is required — it is the durable record this reads')

      // Soft, exactly like people's journeys/audiences: no mail plugin means no
      // mail delivery card, not a broken dashboard.
      // No named plugins any more. Hand over ctx.plugins itself and let the
      // service discover whoever implements status() at request time — that's
      // what makes a new channel appear here without this file changing, and why
      // live no longer has to register after the plugins it reports on.
      // Plugin NAMES come from the config, which is the only complete list:
      // ctx.plugins holds just those that returned a service, so a plugin that
      // returns nothing would otherwise be invisible even as "not monitored".
      const pluginNames = (ctx.config?.plugins || []).map(p => p?.name).filter(Boolean)
      service.init({ eventRegistry, plugins: ctx.plugins, pluginNames, logger })
      rest.register(app, { service, requireRead: auth.middleware })

      // The live half is optional in the sense that it degrades: without a
      // socket the dashboard still renders from /summary and /recent, it just
      // won't update on its own.
      const streaming = stream.register({ connect, events, requireRead: auth.middleware, logger })

      logger.info('Live plugin ready')
      return { service, close: streaming.close }
    },
  }
}

export default live
