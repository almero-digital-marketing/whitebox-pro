import logger from './logger.js'

const TABLE = 'whitebox_sessions'

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

let db
let passports
let notify
const resolveHooks = []

// Register a callback to run on every /sessions/resolve, merging its returned
// object into the response. Lets a plugin piggyback data onto the one request
// every client SDK already makes on load — e.g. an ad-identity manifest
// (server-plugin-audiences), or a geolocation lookup — without a second
// round-trip. Called with { passportId, sessionId, req }; may return a plain
// object or a Promise of one. A hook that throws is logged and skipped — one
// misbehaving plugin never breaks session resolution for everyone else.
export function onResolve(fn) {
  if (typeof fn !== 'function') throw new Error('sessions.onResolve: fn must be a function')
  resolveHooks.push(fn)
}

export async function init(options) {
  db = options.db
  passports = options.passports
  // Optional: a deployment without it just doesn't emit lifecycle events.
  notify = options.notify || null
  resolveHooks.length = 0   // fresh boot ⇒ no hooks registered yet; plugins re-add theirs during their own init
  const exists = await db.schema.hasTable(TABLE)
  if (!exists) {
    await db.schema.createTable(TABLE, t => {
      t.increments('id')
      t.uuid('passport_id').references('id').inTable('whitebox_passports')
      t.string('utm_source', 128)
      t.string('utm_medium', 128)
      t.string('utm_campaign', 128)
      t.string('utm_term', 128)
      t.string('utm_content', 128)
      t.string('referrer', 1024)
      t.timestamp('started_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('ended_at')
      t.index('passport_id')
    })
    logger.info('Sessions table created')
  } else if (!(await db.schema.hasColumn(TABLE, 'referrer'))) {
    // awareness/store.js joins sessions and selects s.referrer — ensure it exists.
    await db.schema.alterTable(TABLE, t => t.string('referrer', 1024))
    logger.info('Sessions table: added referrer column')
  }
}

// Open a visit. The caller is expected to have a passport already — see
// resolve()'s note on why a session with no passport is not an anonymous session
// but an orphan. The only caller that reaches here directly is the
// /sessions/resolve route, which identifies first.
export async function start(passportId, utms = {}) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  const data = { passport_id: resolvedId }
  for (const field of UTM_FIELDS) {
    if (utms[field]) data[field] = utms[field]
  }
  if (utms.referrer) data.referrer = utms.referrer
  const [session] = await db(TABLE).insert(data).returning('*')
  // Only fires from resolve() when there was no active session to reuse, so this
  // counts SESSIONS, not requests — /sessions/resolve runs on every page load.
  // The UTMs ride along because "a new session arrived, attributed to this
  // campaign" is the whole question an operator watching traffic is asking.
  notify?.('session.started', {
    type: 'session.started',
    data: {
      session_id: session.id,
      passport_id: session.passport_id,
      utm_source: session.utm_source ?? null,
      utm_medium: session.utm_medium ?? null,
      utm_campaign: session.utm_campaign ?? null,
      referrer: session.referrer ?? null,
    },
  })?.catch?.(() => {})
  return session
}

export async function end(sessionId) {
  await db(TABLE).where({ id: sessionId }).whereNull('ended_at').update({ ended_at: new Date() })
}

export async function findActive(passportId) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  if (!resolvedId) return null
  const session = await db(TABLE).where({ passport_id: resolvedId }).whereNull('ended_at').orderBy('started_at', 'desc').first()
  return session
}

// How many visits this person has made, and when the first one was.
//
// Merge-resolving like findActive, so an absorbed id reports the SURVIVOR's history
// rather than the empty tombstone it was folded into — the whole point of the merge
// chain is that an old id keeps answering.
//
// `first_seen` comes from the sessions table rather than the passport's created_at:
// they differ, and the difference is the interesting part. A passport is minted the
// first time the SDK sees a browser; a session is a visit. Someone with one passport
// and nine sessions has come back eight times.
export async function historyFor(passportId) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  if (!resolvedId) return { sessions: 0, first_session_at: null }
  const row = await db(TABLE).where({ passport_id: resolvedId })
    .count('* as n').min('started_at as first').first()
  return { sessions: Number(row?.n || 0), first_session_at: row?.first ?? null }
}

export async function findById(id) {
  const session = await db(TABLE).where({ id }).first()
  return session
}

// Get this passport's current visit, opening one if it has none.
//
// No passport, no session — and that is the whole contract. A session is a
// PASSPORT'S visit; a row with `passport_id: null` is not an anonymous session,
// it is a session belonging to nobody. It can never be attributed, it inflates
// both the session count and the inbound `session.started` signal, and it is
// immediately superseded by a real session the moment the caller does identify.
//
// This used to fall through to `start(passportId || null)`, so `resolve(null)`
// silently minted one. The socket handshake was the volume path: the browser SDK
// sends `passport: ''` when it has none yet (client/src/transport.js), so any
// socket that connected before its passport existed — a first visit whose
// /sessions/resolve failed, an outage, `autoResolveSession: false` — produced an
// orphan row plus a `session.started` event with no person attached to it. On this
// dev database that was 37 of 57 sessions.
//
// Fixed here rather than at the six call sites, five of which already wrote
// `resolve(passportId || null)` and clearly expected null to be a no-op. Note the
// fallback three of them then apply — `passportId || session?.passport_id` — could
// never have worked: a session minted by `resolve(null)` has a null passport by
// construction.
//
// The /sessions/resolve ROUTE is unaffected: it calls passports.identify() first
// and then start() with a real passport, which is exactly the right order and the
// reason that path always produced attributed sessions.
export async function resolve(passportId, utms = {}) {
  if (!passportId) return null
  const session = await findActive(passportId).catch(() => null)
  return session || await start(passportId, utms).catch(() => null)
}

export function register(app) {
  // The browser SDK calls this at startup. Mints a passport for a new visitor
  // (or reuses the one it sends back), opens/finds a session, and returns
  // camelCase ids the client stores and carries on the socket handshake.
  app.post('/sessions/resolve', async (req, res) => {
    try {
      const { passport_id: passportId, utms: bodyUtms = {}, referrer } = req.body || {}
      const utms = { ...bodyUtms, ...(referrer ? { referrer } : {}) }
      for (const field of UTM_FIELDS) {
        if (req.query[field]) utms[field] = req.query[field]
      }
      const resolvedPassport = await passports.identify(passportId || null)
      let session = await findActive(resolvedPassport).catch(() => null)
      if (!session) session = await start(resolvedPassport, utms)

      const extra = {}
      for (const hook of resolveHooks) {
        try {
          const result = await hook({ passportId: resolvedPassport, sessionId: session.id, req })
          if (result && typeof result === 'object') Object.assign(extra, result)
        } catch (err) {
          logger.warn({ err }, 'sessions.onResolve hook failed')
        }
      }
      res.json({ passportId: resolvedPassport, sessionId: session.id, ...extra })
    } catch (err) {
      logger.error({ err }, 'Failed to resolve session')
      res.status(500).json({ error: 'Failed to resolve session' })
    }
  })
}
