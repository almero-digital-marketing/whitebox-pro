import logger from './logger.js'

const TABLE = 'whitebox_sessions'

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

let db
let passports
let notify
let idleMs
const resolveHooks = []

// How long a session survives without activity. 30 minutes is the analytics
// convention, and the number matters less than having one at all: `end()` was never
// called anywhere in this codebase and there was no sweep, so `ended_at IS NULL`
// matched every row ever written. Measured on production before this change: 159,588
// sessions, 0 ended, 158,089 passports — one eternal session per person.
//
// Two things followed from that. A "visit" was not a visit, it was a lifetime. And
// findActive always found something, so resolve() always took the existing-session
// branch and threw the incoming UTMs away: 117,957 passports carried attribution from
// their FIRST session and 340 from any later one, meaning a returning visitor's ad
// click was recorded nowhere.
const DEFAULT_IDLE_MINUTES = 30

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
  const minutes = Number(options.config?.sessions?.idleMinutes ?? DEFAULT_IDLE_MINUTES)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`sessions: config.sessions.idleMinutes must be a positive number of minutes — got ${JSON.stringify(options.config?.sessions?.idleMinutes)}`)
  }
  idleMs = minutes * 60_000
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
      t.timestamp('last_activity_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('ended_at')
      t.index('passport_id')
    })
    logger.info('Sessions table created')
  } else if (!(await db.schema.hasColumn(TABLE, 'referrer'))) {
    // awareness/store.js joins sessions and selects s.referrer — ensure it exists.
    await db.schema.alterTable(TABLE, t => t.string('referrer', 1024))
    logger.info('Sessions table: added referrer column')
  }

  // Backfilled from started_at, not from now(): a session's activity cannot be later
  // than the request that is adding the column, and dating them all to the deploy would
  // make every historical session look freshly active and suppress the idle rule for one
  // whole window.
  if (!(await db.schema.hasColumn(TABLE, 'last_activity_at'))) {
    await db.schema.alterTable(TABLE, t => t.timestamp('last_activity_at').defaultTo(db.fn.now()))
    await db(TABLE).whereNull('last_activity_at').update({ last_activity_at: db.ref('started_at') })
    logger.info('Sessions table: added last_activity_at column')
  }
}

// Mark a session as still in use. Called on every resolve and by awareness when it
// records an exposure carrying a session_id — otherwise a visitor reading one page for
// 40 minutes would be handed a new session on their next click, splitting one visit in
// two, which is the opposite failure to the one being fixed.
//
// Fire-and-forget by design: this is bookkeeping on a request that has already done its
// real work, and it must never be the reason a page view fails.
export async function touch(sessionId) {
  if (!sessionId) return
  try {
    await db(TABLE).where({ id: sessionId }).whereNull('ended_at').update({ last_activity_at: new Date() })
  } catch (err) {
    logger.warn({ err, sessionId }, 'sessions.touch failed')
  }
}

// Open a visit. The caller is expected to have a passport already — see
// resolve()'s note on why a session with no passport is not an anonymous session
// but an orphan. The only caller that reaches here directly is the
// /sessions/resolve route, which identifies first.
export async function start(passportId, utms = {}) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  // Set here, not left to a column default: the default exists on a freshly CREATED
  // table but not on one the ALTER above added the column to, and a NULL fails every
  // comparison — so findActive matched nothing and every resolve opened a new session.
  const data = { passport_id: resolvedId, last_activity_at: new Date() }
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
  // IDLE-BOUNDED. Without the last_activity_at floor this returned the first session the
  // passport ever opened, forever — see DEFAULT_IDLE_MINUTES. Ordered by activity rather
  // than start, because after a supersede the newest session is the live one.
  const session = await db(TABLE)
    .where({ passport_id: resolvedId })
    .whereNull('ended_at')
    // coalesce: a row written before last_activity_at existed has none, and reading
    // that as "never active" would silently retire every historical session.
    .whereRaw('coalesce(last_activity_at, started_at) > ?', [new Date(Date.now() - idleMs)])
    .orderByRaw('coalesce(last_activity_at, started_at) desc')
    .first()
  return session
}

// Do these UTMs describe a different campaign than the session already carries?
//
// Only fields the caller actually SENT are compared. A direct visit mid-session sends
// none, and treating "no campaign" as a change would start a new session on every
// ordinary page load — which would be a worse bug than the one being fixed. A visitor
// who clicks a second ad from the same campaign stays in one session; a different
// source, medium or campaign is a new visit by any definition of attribution.
export function isNewCampaign(session, utms = {}) {
  if (!session) return false
  const sent = UTM_FIELDS.filter(f => utms[f] != null && utms[f] !== '')
  if (!sent.length) return false
  return sent.some(f => String(utms[f]) !== String(session[f] ?? ''))
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
  // A CAMPAIGN CHANGE opens a new visit. This used to return the existing session and
  // discard `utms` outright, so a returning visitor's ad click was attributed to
  // whatever brought them the first time — or to nothing.
  if (session && isNewCampaign(session, utms)) {
    await end(session.id).catch(() => null)
    return await start(passportId, utms).catch(() => null)
  }
  if (session) {
    await touch(session.id)
    return session
  }
  return await start(passportId, utms).catch(() => null)
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
      // Same two rules as resolve(), and deliberately not a second copy of them: this
      // route and resolve() disagreeing about when a visit begins is how attribution
      // ends up depending on which entry point a caller happened to use.
      if (session && isNewCampaign(session, utms)) {
        await end(session.id).catch(() => null)
        session = null
      }
      if (session) await touch(session.id)
      else session = await start(resolvedPassport, utms)

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
