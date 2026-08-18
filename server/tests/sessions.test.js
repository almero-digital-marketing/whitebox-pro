import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'
import express from 'express'
import * as sessions from '../src/sessions.js'

// Real DB — sessions.js runs real knex queries (findActive/start/the route), so
// stubbing db would mean re-implementing its query chains. passports is a thin
// stub (identify mints/reuses a real row so the sessions FK is satisfiable;
// resolve is a passthrough) — the system under test is sessions.js, not identity
// merge chains, which have their own suite.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
const passports = {
  identify: async (id) => id || newPassport(),
  resolve: async (id) => id,
}

let app, server, base
beforeAll(async () => {
  await sessions.init({ db, passports })
  app = express()
  app.use(express.json())
  sessions.register(app)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => {
  await new Promise(r => server.close(r))
  await db.destroy()
})
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_sessions, whitebox_passports CASCADE')
  await sessions.init({ db, passports })   // resets resolveHooks — same live array the
  // already-registered route closes over, so this cleanly isolates each test's hooks
})

const post = (body = {}) =>
  fetch(base + '/sessions/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())

describe('POST /sessions/resolve — base behavior (unaffected by hooks)', () => {
  it('mints a passport + session with no extra keys when no hooks are registered', async () => {
    const res = await post({})
    expect(res.passportId).toBeTruthy()
    expect(res.sessionId).toBeTruthy()
    expect(Object.keys(res).sort()).toEqual(['passportId', 'sessionId'])
  })
})

describe('sessions.onResolve — the hook a plugin uses to piggyback data on session resolve', () => {
  it('rejects a non-function', () => {
    expect(() => sessions.onResolve('nope')).toThrow(/must be a function/)
  })

  it('merges one hook\'s returned object into the response', async () => {
    const off = sessions.onResolve(() => ({ geo: { country: 'BG', city: 'Sofia' } }))
    const res = await post({})
    expect(res.geo).toEqual({ country: 'BG', city: 'Sofia' })
  })

  it('supports a zero-arg hook (the exact call site server-plugin-audiences already uses)', async () => {
    sessions.onResolve(() => ({ ad_identity_manifest: { meta: true } }))
    const res = await post({})
    expect(res.ad_identity_manifest).toEqual({ meta: true })
  })

  it('awaits an async hook', async () => {
    sessions.onResolve(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { async_field: 'ready' }
    })
    const res = await post({})
    expect(res.async_field).toBe('ready')
  })

  it('merges multiple hooks together', async () => {
    sessions.onResolve(() => ({ a: 1 }))
    sessions.onResolve(() => ({ b: 2 }))
    const res = await post({})
    expect(res).toMatchObject({ a: 1, b: 2 })
  })

  it('a throwing hook is caught and logged — other hooks and the base response still work', async () => {
    sessions.onResolve(() => { throw new Error('boom') })
    sessions.onResolve(() => ({ survived: true }))
    const res = await post({})
    expect(res.passportId).toBeTruthy()
    expect(res.survived).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('passes { passportId, sessionId, req } to each hook', async () => {
    const seen = vi.fn(() => ({}))
    sessions.onResolve(seen)
    const res = await post({})
    expect(seen).toHaveBeenCalledOnce()
    const arg = seen.mock.calls[0][0]
    expect(arg.passportId).toBe(res.passportId)
    expect(arg.sessionId).toBe(res.sessionId)
    expect(arg.req).toBeTruthy()   // the express request — e.g. for req.ip
  })
})

// resolve() is the "get me this passport's visit" API that every plugin and the
// socket handshake call. It used to fall through to start(null) when handed no
// passport, minting a row that belonged to nobody — 37 of 57 sessions on the dev
// database, each with a `session.started` event carrying no person.
describe('resolve() — no passport, no session', () => {
  it('returns null instead of minting an orphan session', async () => {
    const notify = vi.fn(async () => {})
    await sessions.init({ db, passports, notify })

    expect(await sessions.resolve(null)).toBeNull()
    expect(await sessions.resolve(undefined)).toBeNull()
    expect(await sessions.resolve('')).toBeNull()

    // nothing written, and — the part that reached the Live feed — nothing emitted
    const { count } = await db('whitebox_sessions').count('* as count').first()
    expect(Number(count)).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('still opens a visit for a real passport, and reuses the active one', async () => {
    const notify = vi.fn(async () => {})
    await sessions.init({ db, passports, notify })
    const passportId = await newPassport()

    const first = await sessions.resolve(passportId, { utm_source: 'google' })
    expect(first?.id).toBeTruthy()
    expect(first.passport_id).toBe(passportId)
    expect(first.utm_source).toBe('google')

    // second call finds the active one rather than opening another
    const second = await sessions.resolve(passportId)
    expect(second.id).toBe(first.id)

    const { count } = await db('whitebox_sessions').count('* as count').first()
    expect(Number(count)).toBe(1)
  })

  // The event that made this visible. A session.started with no passport_id is
  // what the Live feed showed, and it is inbound traffic attributed to nobody.
  it('emits session.started carrying the passport it belongs to', async () => {
    const notify = vi.fn(async () => {})
    await sessions.init({ db, passports, notify })
    const passportId = await newPassport()

    await sessions.resolve(passportId)
    expect(notify).toHaveBeenCalledWith('session.started', expect.objectContaining({
      type: 'session.started',
      // snake_case: the event registry persists payload.data.passport_id and
      // nothing else, so this is the field that decides whether the row has a
      // person on it
      data: expect.objectContaining({ passport_id: passportId }),
    }))
  })
})

// How many times someone came back. `last_seen_at` says they were here; nothing on
// a person record said whether it was their first visit or their ninth.
describe('historyFor() — the visit count', () => {
  it('counts this passport sessions and reports the first', async () => {
    await sessions.init({ db, passports })
    const passportId = await newPassport()

    expect(await sessions.historyFor(passportId)).toEqual({ sessions: 0, first_session_at: null })

    await sessions.start(passportId)
    await db('whitebox_sessions').update({ ended_at: new Date() })   // close it so the next is new
    await sessions.start(passportId)

    const h = await sessions.historyFor(passportId)
    expect(h.sessions).toBe(2)
    expect(h.first_session_at).toBeTruthy()
  })

  // 0 and "no such person" are different answers, and a caller rendering a count
  // needs to tell them apart from a crash.
  it('answers zero for an unknown or missing passport rather than throwing', async () => {
    await sessions.init({ db, passports })
    expect(await sessions.historyFor(null)).toEqual({ sessions: 0, first_session_at: null })
    expect((await sessions.historyFor(crypto.randomUUID())).sessions).toBe(0)
  })

  // The merge chain is the point of resolve(): an absorbed id must keep answering
  // with the survivor's history rather than reporting the empty tombstone.
  it('follows the merge chain, so an absorbed id reports the survivor history', async () => {
    const survivor = await newPassport()
    const absorbed = await newPassport()
    await sessions.init({
      db,
      // passports.resolve is the stub in this suite; point the absorbed id at the
      // survivor the way a real merge would.
      passports: { ...passports, resolve: async (id) => (id === absorbed ? survivor : id) },
    })
    await sessions.start(survivor)
    expect((await sessions.historyFor(absorbed)).sessions).toBe(1)
  })
})

// WHEN A VISIT ENDS, and when a new one begins.
//
// Neither question had an answer. `end()` was never called anywhere in the monorepo and
// there was no sweep, so `ended_at IS NULL` matched every row ever written and
// findActive always found the first session the passport ever opened. Measured on
// production before this: 159,588 sessions, 0 ended, 158,089 passports.
//
// Two consequences, and the second is the one that cost money. A "visit" was a lifetime.
// And because resolve() returned the existing session and discarded the UTMs it was
// handed, a returning visitor's ad click was attributed to whatever brought them the
// first time — 117,957 passports carried attribution from their FIRST session and 340
// from any later one.
describe('sessions: when a visit ends', () => {
  const idle = (mins) => sessions.init({ db, passports, config: { sessions: { idleMinutes: mins } } })
  const ageSession = (id, minutes) => db('whitebox_sessions').where({ id })
    .update({ last_activity_at: new Date(Date.now() - minutes * 60_000) })

  it('reuses a session that is still active', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords' })
    expect((await sessions.resolve(p, {})).id).toBe(first.id)
  })

  it('starts a new one once the idle window has passed', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords' })
    await ageSession(first.id, 31)
    const next = await sessions.resolve(p, {})
    expect(next.id).not.toBe(first.id)
  })

  it('counts ACTIVITY, not start time — a long visit is one visit', async () => {
    // The failure this avoids: /sessions/resolve fires once per full page load, so on an
    // SPA a visitor reading one page for 40 minutes would come back to a new session and
    // have their single visit split in two. Their events are the evidence they are here.
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, {})
    await db('whitebox_sessions').where({ id: first.id })
      .update({ started_at: new Date(Date.now() - 90 * 60_000) })   // began 90 min ago
    await sessions.touch(first.id)                                   // but active just now
    expect((await sessions.resolve(p, {})).id).toBe(first.id)
  })

  it('touching is what resolve does, so browsing keeps the visit open', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, {})
    await ageSession(first.id, 20)
    await sessions.resolve(p, {})                                    // 20 min in, still fine
    await ageSession(first.id, 20)                                   // …would be 40 from the START
    expect((await sessions.resolve(p, {})).id).toBe(first.id)         // but only 20 since activity
  })

  it('refuses a nonsensical idle window at boot rather than at request time', async () => {
    await expect(sessions.init({ db, passports, config: { sessions: { idleMinutes: 0 } } }))
      .rejects.toThrow(/positive number of minutes/)
    await expect(sessions.init({ db, passports, config: { sessions: { idleMinutes: 'half an hour' } } }))
      .rejects.toThrow(/positive number of minutes/)
    await idle(30)
  })
})

describe('sessions: a new campaign is a new visit', () => {
  const idle = (mins) => sessions.init({ db, passports, config: { sessions: { idleMinutes: mins } } })

  it('starts a new session when the campaign changes mid-window', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords', utm_campaign: 'spring' })
    const next = await sessions.resolve(p, { utm_source: 'facebook', utm_campaign: 'summer' })
    expect(next.id).not.toBe(first.id)
    expect(next.utm_source).toBe('facebook')
    // …and the superseded one is closed, so it stops being "active" forever.
    const closed = await db('whitebox_sessions').where({ id: first.id }).first()
    expect(closed.ended_at).not.toBeNull()
    expect(closed.utm_source).toBe('adwords')     // its own attribution is untouched
  })

  it('keeps one session when the same campaign is seen again', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords', utm_campaign: 'spring' })
    const same = await sessions.resolve(p, { utm_source: 'adwords', utm_campaign: 'spring' })
    expect(same.id).toBe(first.id)
  })

  it('does NOT start a new session for a direct visit mid-session', async () => {
    // The rule compares only the fields the caller SENT. Treating "no campaign" as a
    // change would mint a session on every ordinary page load — a worse bug than the one
    // being fixed, and one that would quietly multiply every session-based number.
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords' })
    expect((await sessions.resolve(p, {})).id).toBe(first.id)
    expect((await sessions.resolve(p, { referrer: 'https://google.com' })).id).toBe(first.id)
  })

  it('treats a partial overlap as a change', async () => {
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, { utm_source: 'adwords', utm_campaign: 'spring' })
    // same source, different campaign — a different ad, so a different visit
    const next = await sessions.resolve(p, { utm_source: 'adwords', utm_campaign: 'winter' })
    expect(next.id).not.toBe(first.id)
    expect(next.utm_campaign).toBe('winter')
  })

  it('attributes a first campaign onto a session that had none', async () => {
    // A visitor who arrived direct and then clicked an ad in the same window: the session
    // has no utm_source, the click has one, so the click gets its own attributed session
    // rather than being folded into an unattributed one.
    await idle(30)
    const p = await newPassport()
    const first = await sessions.start(p, {})
    const next = await sessions.resolve(p, { utm_source: 'adwords' })
    expect(next.id).not.toBe(first.id)
    expect(next.utm_source).toBe('adwords')
  })

  it('applies the same rules through the HTTP route', async () => {
    // resolve() and the route are two entry points to one question. They used to hold
    // separate copies of the logic, which is how they would come to disagree.
    await idle(30)
    const p = await newPassport()
    const opened = await fetch(`${base}/sessions/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passport_id: p, utms: { utm_source: 'adwords' } }),
    }).then(r => r.json())

    const same = await fetch(`${base}/sessions/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passport_id: p }),
    }).then(r => r.json())
    expect(same.sessionId).toBe(opened.sessionId)

    const switched = await fetch(`${base}/sessions/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passport_id: p, utms: { utm_source: 'tiktok' } }),
    }).then(r => r.json())
    expect(switched.sessionId).not.toBe(opened.sessionId)

    const row = await db('whitebox_sessions').where({ id: switched.sessionId }).first()
    expect(row.utm_source).toBe('tiktok')
  })
})
