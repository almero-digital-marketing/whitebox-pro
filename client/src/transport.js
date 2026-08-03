// Socket.IO transport. Mirrors the server-side `core/connect.js` (also Socket.IO).
//
// Dynamic import keeps socket.io-client out of the main bundle — it's downloaded
// on demand the first time the transport opens. Sites that only use HTTP plugins
// (e.g. just the mail contact form) can opt out by passing `transport: false`.

// Split the configured url into the ORIGIN to connect to and the engine PATH.
//
// socket.io does not treat the path part of a url as a prefix — it reads it as a
// NAMESPACE. So `io('https://example.com/whitebox')` connects to
// `https://example.com`, asks for namespace `/whitebox`, and puts the engine at
// `/socket.io` — not `/whitebox/socket.io`. Behind a reverse proxy that only
// forwards `/whitebox/*` that request never reaches the server, and the namespace
// isn't one the server serves either. The HTTP half of the SDK keeps working
// (`${baseUrl}${path}` needs no help), so the failure is silent: tracking looks
// fine and realtime just never connects.
//
// Hence this: connect to the origin, and move the prefix into `path`, which is
// what socket.io's option is for.
//
// A url with no path is the overwhelming case and is unchanged — origin as given,
// `/socket.io`, no namespace.
export function socketTarget(url) {
  try {
    const u = new URL(url)
    const prefix = u.pathname.replace(/\/+$/, '')   // '' for '/' or ''
    return { origin: u.origin, path: `${prefix}/socket.io` }
  } catch {
    // Not an absolute url (a relative base, or something odd). Pass it through
    // rather than guessing — the previous behaviour, and a same-origin relative
    // base already resolves correctly.
    return { origin: url, path: '/socket.io' }
  }
}

export default function createTransport({ url, getSessionId, getPassportId, emitter, logger }) {
  let socket = null
  let connected = false
  let reportedFailure = false   // see connect_error below — one warning per outage

  async function open() {
    if (socket) return socket

    const { io } = await import('socket.io-client')

    const { origin, path } = socketTarget(url)
    socket = io(origin, {
      // Where the engine lives on the PUBLIC url. Derived from `url` above, so a
      // prefix-STRIPPING proxy (`proxy_pass http://host:port/` — note the trailing
      // slash) needs nothing configured: the server never sees the prefix and stays
      // path-agnostic. A proxy that PRESERVES the prefix needs the server told the
      // matching value too — `connect: { path }` in whitebox.config.js.
      path,
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
