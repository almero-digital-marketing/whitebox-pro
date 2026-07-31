// Socket.IO transport. Mirrors the server-side `core/connect.js` (also Socket.IO).
//
// Dynamic import keeps socket.io-client out of the main bundle — it's downloaded
// on demand the first time the transport opens. Sites that only use HTTP plugins
// (e.g. just the mail contact form) can opt out by passing `transport: false`.

export default function createTransport({ url, getSessionId, getPassportId, emitter, logger }) {
  let socket = null
  let connected = false
  let reportedFailure = false   // see connect_error below — one warning per outage

  async function open() {
    if (socket) return socket

    const { io } = await import('socket.io-client')

    socket = io(url, {
      transports: ['websocket', 'polling'],
      // `auth` as a FUNCTION, because socket.io re-evaluates it before every
      // connection attempt — where `query` is captured once, at construction.
      //
      // That difference mattered: a page whose /sessions/resolve failed (an
      // outage, a first visit that raced the server coming up) had no passport
      // when the socket opened, so it handshook with '' — and then kept sending
      // '' on every reconnect for the rest of the page's life, even after the
      // retry on `transport:connected` had acquired a real passport. The socket
      // stayed anonymous until a full page reload.
      auth: (cb) => cb({ passport: getPassportId() || '' }),
      // Kept alongside it: a server that only reads handshake.query still gets
      // the passport it had at open time, which is what it got before.
      query: { passport: getPassportId() || '' },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    })

    socket.on('connect', () => {
      connected = true
      // A successful connect ends the outage, so the next one is worth reporting
      // again — this is per-outage, not once per page.
      reportedFailure = false
      emitter.emit('transport:connected', { id: socket.id })
    })
    socket.on('disconnect', (reason) => {
      connected = false
      emitter.emit('transport:disconnected', { reason })
    })
    socket.on('connect_error', (err) => {
      // ONCE per outage, not once per attempt. socket.io retries with backoff to a
      // 30s ceiling and never gives up, so logging every attempt means a warning
      // every 30 seconds for as long as the server is down — in the HOST's console,
      // about a system that is not theirs. The first one carries the information;
      // the rest are just the retry loop being audible.
      if (reportedFailure) return
      reportedFailure = true
      logger?.warn?.('whitebox: realtime connection unavailable, retrying in the background', err?.message || err)
    })
    socket.onAny((event, data) => {
      emitter.emit(event, data)
    })

    return socket
  }

  function send(event, data) {
    if (!socket || !connected) return false
    socket.emit(event, data)
    return true
  }

  function close() {
    socket?.disconnect()
    socket = null
    connected = false
  }

  return {
    open,
    send,
    close,
    isConnected: () => connected,
  }
}
