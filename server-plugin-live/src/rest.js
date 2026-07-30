// REST transport — the dashboard's reads. All read-only: this module observes,
// it never acts, so there is no write verifier and no write route.
export function register(app, { service, requireRead }) {
  const read = (path, fn) => app.get(`/live${path}`, requireRead, wrap(fn))

  // Everything the header and cards need, in ONE call — the dashboard refreshes
  // as a whole, and splitting it would only guarantee the cards disagree.
  // `dir`/`chan` are the dashboard-wide filter — one token list per axis, `-`
  // prefixed to exclude (see makeFilter). Only the two endpoints whose numbers are
  // classified take them: /utm and /content answer different questions (sessions,
  // content kinds) that a direction has no bearing on.
  read('/summary', async (req) => service.summary({
    window: req.query.window, dir: req.query.dir, chan: req.query.chan,
  }))
  // Attribution for the window, from session.started's own payload.
  read('/utm', async (req) => service.utm({ window: req.query.window, limit: req.query.limit }))
  // What was consumed — video/text/image, from awareness.recorded's `source`.
  read('/content', async (req) => service.content({ window: req.query.window, limit: req.query.limit }))
  // `points` is how many bars the client can actually draw — it measures its own
  // plot and asks for a resolution that fits. Server-side it's a HINT, clamped
  // and snapped to a readable bucket size (see service.timeseries).
  read('/timeseries', async (req) => service.timeseries({
    window: req.query.window, points: req.query.points,
    dir: req.query.dir, chan: req.query.chan,
  }))
  // Backfill for the feed, so a quiet system reads as measured rather than dead.
  read('/recent', async (req) => ({ events: await service.recent({ limit: req.query.limit, window: req.query.window }) }))
}

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
