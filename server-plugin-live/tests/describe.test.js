// live as a CONSUMER of the detail declarations.
//
// This file used to assert what mail, sms, voip, conversions and awareness put in
// a feed row — 18 tests about other modules' payload shapes, in the package that
// was guessing at them. Those assertions moved to the modules that own the
// payloads (see server-plugin-voip/tests/manifest.test.js and each plugin's
// detail tests, plus server/tests/event-catalog.test.js for core's own events).
//
// What's left here is the only thing live is now responsible for: dispatching to
// whoever declared the event, and not breaking when they misbehave.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { build } from 'whitebox-pro-server/event-catalog'
import { describe as detailOf, init } from '../src/describe.js'

const PLUGINS = [
  {
    name: 'mail',
    events: { 'mail.sent': 'out', 'mail.bulk.queued': 'out' },
    detail: {
      'mail.bulk.': (d) => `${d.accepted} recipients`,
      'mail.': (d) => d.to ?? null,
    },
  },
  {
    name: 'boom',
    events: { 'boom.thing': 'in' },
    detail: { 'boom.thing': () => { throw new Error('payload was not what I expected') } },
  },
  { name: 'quiet', events: { 'quiet.thing': 'in' } },   // declares no detail at all
]

beforeEach(() => init({ eventCatalog: build(PLUGINS) }))

describe('dispatch', () => {
  it('routes an event to the module that declared it', () => {
    expect(detailOf('mail.sent', { data: { to: 'a@b.c' } })).toBe('a@b.c')
  })

  it('prefers the most specific declaration', () => {
    expect(detailOf('mail.bulk.queued', { data: { accepted: 9 } })).toBe('9 recipients')
  })

  // Payloads are nested one level — notify(type, { type, data }) — and the
  // declaration receives the inner body, so no plugin has to unwrap it.
  it('hands the declaration the payload body, not the envelope', () => {
    expect(detailOf('mail.sent', { type: 'mail.sent', data: { to: 'x@y.z' } })).toBe('x@y.z')
  })

  it('tolerates a bare payload with no data wrapper', () => {
    expect(detailOf('mail.sent', { to: 'bare@y.z' })).toBe('bare@y.z')
  })
})

describe('when there is nothing to say', () => {
  // "—" in the UI is honest; an invented summary is worse than no summary.
  it('is null for an event nobody declared detail for', () => {
    expect(detailOf('quiet.thing', { data: { a: 1 } })).toBeNull()
    expect(detailOf('nobody.declared.this', { data: { a: 1 } })).toBeNull()
  })

  it('is null when the declaration itself returns nothing', () => {
    expect(detailOf('mail.sent', { data: {} })).toBeNull()
  })

  it('is null with no catalog at all, rather than throwing', () => {
    init({})
    expect(detailOf('mail.sent', { data: { to: 'a@b.c' } })).toBeNull()
  })
})

describe('a misbehaving declaration', () => {
  // These functions run over arbitrary HISTORICAL payloads, including rows
  // written before a field existed. One row failing to describe itself must never
  // be the thing that breaks the board.
  it('yields null and a warning instead of taking the request down', () => {
    const warn = vi.fn()
    init({ eventCatalog: build(PLUGINS), logger: { warn } })
    expect(() => detailOf('boom.thing', { data: {} })).not.toThrow()
    expect(detailOf('boom.thing', { data: {} })).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('survives a missing or malformed payload', () => {
    for (const p of [null, undefined, {}, { data: null }, 'nonsense', 42]) {
      expect(() => detailOf('mail.sent', p)).not.toThrow()
    }
  })
})
