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
