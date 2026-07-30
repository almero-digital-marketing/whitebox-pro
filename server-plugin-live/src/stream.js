// The live half: every event, pushed to authenticated dashboards.
//
// TWO decisions here are security-relevant, not stylistic.
//
// 1. ITS OWN NAMESPACE. connect.js's default namespace is where every visitor's
//    browser connects — connect.broadcast() reaches the public. This stream
//    carries internal payloads and passport ids, so it gets `/live` with its
//    own handshake auth. (Worth knowing: `analytics.changed` is currently sent
//    via broadcast(), i.e. to every visitor. Only ids, but the same mistake one
//    size larger would be a real leak.)
//
// 2. ONE SUBSCRIBED CHANNEL, not psubscribe('*'). The Redis db is shared —
//    verified on dev, a wildcard subscriber also receives `directus:bus:logs`
//    from an unrelated application. notify() echoes every event to
//    FIREHOSE_CHANNEL precisely so a monitor can have all of WhiteBox's traffic
//    and none of anyone else's.
import { FIREHOSE_CHANNEL } from 'whitebox-pro-server/notify'
import { toFeedRow } from './service.js'

// Auth verifiers in this codebase expose exactly one thing: an Express
// `middleware`. There is no verify(token), and adding a second code path that
// checks tokens its own way is how a socket ends up with weaker auth than the
// routes beside it. So the handshake runs the SAME middleware against a minimal
// req/res pair — one verifier, two transports.
export const authorize = (middleware, token) => new Promise((resolve, reject) => {
  if (!token) return reject(new Error('unauthorized'))

  const headers = { authorization: `Bearer ${token}` }
  const req = {
    headers,
    method: 'GET',
    url: '/live',
    // Express's own accessor, and verifiers use it rather than reading
    // `headers` directly (whitebox-pro-auth-auth0 does). Omitting it doesn't
    // fail the auth — it throws inside the verifier, which is far worse.
    get: (name) => headers[String(name).toLowerCase()],
    header: (name) => headers[String(name).toLowerCase()],
  }
  // Any attempt to RESPOND means the middleware rejected the request; only
  // calling next() with no error is a pass.
  const deny = () => reject(new Error('unauthorized'))
  const res = {
    status: () => res, set: () => res, setHeader: () => res, type: () => res,
    json: deny, send: deny, end: deny, sendStatus: deny,
  }

  // Promise.resolve(...) around the call, NOT a bare try/catch. These verifiers
  // are async, so a throw inside one surfaces as a REJECTED PROMISE, which a
  // synchronous try/catch cannot see. Unhandled, that rejection terminates the
  // Node process — which is exactly what happened: every dashboard that opened
  // its socket killed the whole API.
  try {
    Promise.resolve(middleware(req, res, err => (err ? reject(err) : resolve(req)))).catch(reject)
  } catch (err) { reject(err) }
})

export function register({ connect, events, requireRead, logger }) {
  if (!connect?.namespace) {
    logger.warn('live: connect.namespace() unavailable — the dashboard will poll instead of streaming')
    // `stats: () => null` is the signal, not an object of zeros. "There is no
    // stream" and "the stream has carried nothing" are different claims, and
    // status() renders them differently.
    return { close: () => {}, stats: () => null }
  }

  const ns = connect.namespace('/live')

  // Same verifier as the REST routes, applied to the handshake. socket.io can't
  // carry an Authorization header on the initial upgrade, so the token comes in
  // `auth` (socket.io's own field, sent in the connect packet — not the query
  // string, which lands in access logs and proxy history).
  // Belt and braces: authorize() already converts every failure mode into a
  // rejection, but a handshake middleware runs OUTSIDE any request lifecycle —
  // anything that escapes here takes the process with it, and a monitoring
  // plugin must never be able to kill the system it monitors.
  ns.use((socket, next) => {
    authorize(requireRead, socket.handshake.auth?.token)
      .then(() => next())
      .catch(() => next(new Error('unauthorized')))
  })

  // ── batching ──────────────────────────────────────────────────────────────
  // A busy system emits faster than any UI can render, and one socket frame per
  // event would make the client's reactivity the bottleneck. Flush on a tick
  // instead: the dashboard is a monitor, so 250ms of latency is invisible while
  // the saving under load is not.
  const FLUSH_MS = 250
  // A hard ceiling per flush. If the system ever outruns this, the dashboard
  // must say so rather than silently show a fraction of the traffic — hence
  // `dropped` travelling with the batch.
  const MAX_PER_FLUSH = 200

  let buffer = []
  let dropped = 0

  // Process-lifetime totals, for status(). Deliberately separate from `dropped`
  // above, which resets on every flush: that copy travels to the client and dies
  // with the tab, so a drop nobody happened to be watching left no trace anywhere
  // in the system. These are the durable version, and they are the only record of
  // whether this plugin's own pipeline is working.
  // `bootedAt` is what stops the firehose cross-check crying wolf. `received` counts
  // from THIS boot, while the registry count covers the selected window — so right
  // after a restart the log legitimately holds events the stream was never going to
  // see, and "recorded > 0 and received === 0" is the normal state rather than a
  // dead subscription. status() only compares them when the window starts after boot.
  const totals = { received: 0, overCeiling: 0, unwatched: 0, bootedAt: Date.now() }

  const onEvent = (message) => {
    // The firehose carries { type, payload }; the registry row shape is what
    // toFeedRow() reads, so adapt once here and the client can't tell a
    // streamed event from a backfilled one.
    totals.received++
    if (buffer.length >= MAX_PER_FLUSH) { dropped++; totals.overCeiling++; return }
    // `data` here is the INPUT toFeedRow reads (it derives detail/direction/
    // channel from it) — it is not carried through onto the emitted row.
    buffer.push(toFeedRow({
      id: null,
      type: message?.type,
      data: message?.payload,
      occurred_at: new Date().toISOString(),
      passport_id: message?.payload?.data?.passport_id ?? null,
    }))
  }

  events.subscribe(FIREHOSE_CHANNEL, onEvent)

  const timer = setInterval(() => {
    if (!buffer.length && !dropped) return
    // No connected dashboards? Drop the batch rather than let it grow — nobody
    // is waiting for it, and the registry holds the durable copy regardless.
    if (ns.sockets.size) ns.emit('live.batch', { events: buffer, dropped })
    else totals.unwatched += buffer.length
    buffer = []
    dropped = 0
  }, FLUSH_MS)
  timer.unref?.()

  logger.info('live: streaming on the /live namespace')

  return {
    // What this plugin knows about its OWN pipeline. Nothing here is windowed:
    // the totals are process-lifetime (they reset on restart and don't extend to a
    // second instance) and `subscribers` is read from socket.io right now.
    stats: () => ({ ...totals, subscribers: ns.sockets.size }),

    close() {
      clearInterval(timer)
      events.unsubscribe?.(FIREHOSE_CHANNEL, onEvent)
    },
  }
}
