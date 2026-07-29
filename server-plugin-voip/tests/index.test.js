import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { voip } from '../src/index.js'

function makeApp({ passportsOverrides = {}, awarenessOverrides = {} } = {}) {
  const passports = {
    identify: vi.fn(async () => 'p-new'),
    link: vi.fn(async () => {}),
    ...passportsOverrides,
  }
  const sessions = { resolve: vi.fn(async () => ({ id: 's1' })) }
  const awareness = { record: vi.fn(async () => {}), ...awarenessOverrides }
  const logger = { child: () => logger, warn: vi.fn(), error: vi.fn(), info: vi.fn() }
  const connect = { onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn(), onSessionReady: vi.fn() }
  const webhooks = { register: vi.fn() }
  const events = {}
  const db = () => ({ insert: vi.fn(async () => []) })

  const app = express()
  const ctx = { db, webhooks, events, connect, passports, sessions, ai: {}, awareness, logger, config: {} }
  const plugin = voip({ country: 'BG' })
  return plugin.register(app, ctx).then(() => ({ app, passports, sessions, awareness }))
}

async function request(app, method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method, url: path,
      headers: { 'content-type': 'application/json' },
      get(name) { return this.headers[name.toLowerCase()] },
      body: body || {},
      id: 'test-req',
    }
    const res = {
      _status: 200, _body: null,
      statusCode: 200, headers: {},
      setHeader() {}, getHeader() {}, removeHeader() {}, writeHead() {},
      status(s) { this._status = s; this.statusCode = s; return this },
      json(b) { this._body = b; resolve({ status: this._status, body: this._body }); return this },
      send(b) { this._body = b; resolve({ status: this._status, body: this._body }); return this },
    }
    app(req, res, err => err && reject(err))
  })
}

describe('POST /voip/calls — direction: outbound (WE called the customer)', () => {
  it('resolves/creates the recipient\'s passport by phone identity, not the DNI pool', async () => {
    const { app, passports, sessions, awareness } = await makeApp()
    const { status, body } = await request(app, 'POST', '/voip/calls', {
      body: { number: '0888123456', direction: 'outbound', transcription: 'Discussed the invoice.', duration: 42 },
    })
    expect(status).toBe(200)
    expect(body).toEqual({ passport_id: 'p-new', recorded: true })

    expect(passports.identify).toHaveBeenCalledWith(null)
    // normalized to E.164 using the plugin's configured country (BG), like ari.js's
    // own caller-resolution fallback does for an anonymous inbound caller.
    expect(passports.link).toHaveBeenCalledWith('p-new', [{ type: 'phone', name: 'e164', value: '+359888123456' }])
    expect(sessions.resolve).toHaveBeenCalledWith('p-new')

    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p-new', session_id: 's1', channel: 'voip', source: 'call',
      text: 'Discussed the invoice.', dwell_ms: 42000,
      meta: expect.objectContaining({ call_direction: 'outbound', line: '0888123456' }),
    }))
  })

  it('still records the call even if identify/link fails (best-effort, matching ari.js)', async () => {
    const { app, awareness } = await makeApp({
      passportsOverrides: { identify: vi.fn(async () => { throw new Error('db down') }) },
    })
    const { status, body } = await request(app, 'POST', '/voip/calls', {
      body: { number: '0888123456', direction: 'outbound' },
    })
    expect(status).toBe(200)
    expect(body.passport_id).toBeUndefined()   // no passport resolved
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({ passport_id: undefined }))
  })

  it('400s on an unparseable recipient number, without touching passports/awareness', async () => {
    const { app, passports, awareness } = await makeApp()
    const { status } = await request(app, 'POST', '/voip/calls', {
      body: { number: 'not-a-phone-number', direction: 'outbound' },
    })
    expect(status).toBe(400)
    expect(passports.identify).not.toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })
})

describe('POST /voip/calls — direction: inbound (default, unchanged)', () => {
  it('still 202s when no visitor holds the dialed number — never falls through to phone-identity resolution', async () => {
    const { app, passports, awareness } = await makeApp()
    const { status, body } = await request(app, 'POST', '/voip/calls', {
      body: { number: '+35929999999' },   // no direction field — defaults to inbound
    })
    expect(status).toBe(202)
    expect(body).toEqual({ reason: 'no_visitor_for_number' })
    expect(passports.identify).not.toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('400s when number is missing, for either direction', async () => {
    const { app } = await makeApp()
    expect((await request(app, 'POST', '/voip/calls', { body: {} })).status).toBe(400)
    expect((await request(app, 'POST', '/voip/calls', { body: { direction: 'outbound' } })).status).toBe(400)
  })
})
