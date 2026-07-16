import { Server } from 'socket.io'
import logger from './logger.js'

const CH_EMIT = 'whitebox:connect:emit'
const CH_BROADCAST = 'whitebox:connect:broadcast'
const CH_CONNECTED = 'whitebox:connect:connected'
const CH_DISCONNECTED = 'whitebox:connect:disconnected'
const CH_MESSAGE = 'whitebox:connect:message'
const CH_SESSION_READY = 'whitebox:connect:session-ready'

let events
let sessions

const connections = new Map()

function init(options) {
  events = options.events
  sessions = options.sessions

  const io = new Server(options.server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  io.on('connection', async socket => {
    const connectionId = socket.id
    const { passport: passportId, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = socket.handshake.query
    const utms = { utm_source, utm_medium, utm_campaign, utm_term, utm_content }

    // Register + publish BEFORE the session resolve, not after: a client can
    // (and does — see voip's pick-on-mount) send its first message within
    // milliseconds of 'connect' firing, well before an async DB round-trip
    // would finish. Consumers gating on find(connectionId)/CH_CONNECTED
    // (crm, engagement, voip's number pool) only ever need passportId
    // synchronously — it's already in the handshake query, no DB needed.
    // sessionId is best-effort enrichment, backfilled below and pushed via
    // CH_SESSION_READY for anyone (voip) that persists it on their own record.
    connections.set(connectionId, { sessionId: null, passportId: passportId || null })

    logger.debug('Socket connected: %s', connectionId)
    events.publish(CH_CONNECTED, { connectionId, passportId: passportId || null, sessionId: null })

    socket.onAny((event, data) => {
      events.publish(CH_MESSAGE, { connectionId, event, data })
    })

    socket.on('disconnect', async () => {
      connections.delete(connectionId)
      logger.debug('Socket disconnected: %s', connectionId)
      events.publish(CH_DISCONNECTED, { connectionId })
    })

    const session = await sessions.resolve(passportId || null, utms).catch(err => {
      logger.warn({ err }, 'Failed to resolve session for %s', connectionId)
      return null
    })
    if (session?.id) {
      const existing = connections.get(connectionId)
      if (existing) existing.sessionId = session.id
      events.publish(CH_SESSION_READY, { connectionId, sessionId: session.id })
    }
  })

  events.subscribe(CH_EMIT, ({ connectionId, event, data }) => {
    io.to(connectionId).emit(event, data)
  })

  events.subscribe(CH_BROADCAST, ({ event, data }) => {
    io.emit(event, data)
  })

  logger.info('Socket.io ready')
}

function emit(connectionId, event, data) {
  return events.publish(CH_EMIT, { connectionId, event, data })
}

function broadcast(event, data) {
  return events.publish(CH_BROADCAST, { event, data })
}

function find(connectionId) {
  const connection = connections.get(connectionId)
  return connection || null
}

function onMessage(handler) {
  events.subscribe(CH_MESSAGE, handler)
}

function onConnected(handler) {
  events.subscribe(CH_CONNECTED, handler)
}

function onDisconnected(handler) {
  events.subscribe(CH_DISCONNECTED, handler)
}

function onSessionReady(handler) {
  events.subscribe(CH_SESSION_READY, handler)
}

export { init, emit, broadcast, find, onMessage, onConnected, onDisconnected, onSessionReady }
