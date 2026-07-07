import { describe, it, expect, vi } from 'vitest'
import geolocationPlugin from '../src/index.js'

// A minimal real emitter (on/off/emit), matching client/src/emitter.js's
// contract — the plugin's whole behavior is wired through it.
function makeEmitter() {
  const listeners = new Set()
  return {
    on: vi.fn((event, fn) => { if (event === 'session.resolved') listeners.add(fn) }),
    off: vi.fn((event, fn) => { if (event === 'session.resolved') listeners.delete(fn) }),
    emit: (data) => { for (const fn of listeners) fn(data) },
    _count: () => listeners.size,
  }
}

function makeCore() {
  const emitter = makeEmitter()
  const attached = {}
  const core = { emitter, attach: vi.fn((name, api) => { attached[name] = api }) }
  return { core, emitter, attached }
}

describe('geolocation client plugin', () => {
  it('attaches get() returning null before any session.resolved', () => {
    const { core, attached } = makeCore()
    geolocationPlugin().install(core)
    expect(attached.geolocation.get()).toBeNull()
  })

  it('exposes geo after session.resolved carries it', () => {
    const { core, emitter, attached } = makeCore()
    geolocationPlugin().install(core)
    emitter.emit({ sessionId: 1, passportId: 'p-1', geo: { country: 'BG', city: 'Sofia' } })
    expect(attached.geolocation.get()).toEqual({ country: 'BG', city: 'Sofia' })
  })

  it('ignores a session.resolved with no geo (server had no data for this IP)', () => {
    const { core, emitter, attached } = makeCore()
    geolocationPlugin().install(core)
    emitter.emit({ sessionId: 1, passportId: 'p-1' })
    expect(attached.geolocation.get()).toBeNull()
  })

  it('keeps the last known geo across subsequent resolves that omit it', () => {
    const { core, emitter, attached } = makeCore()
    geolocationPlugin().install(core)
    emitter.emit({ geo: { country: 'BG' } })
    emitter.emit({ sessionId: 2 })   // e.g. a later resolve where the lookup failed
    expect(attached.geolocation.get()).toEqual({ country: 'BG' })
  })

  it('unsubscribes on teardown', () => {
    const { core, emitter } = makeCore()
    const teardown = geolocationPlugin().install(core)
    expect(emitter._count()).toBe(1)
    teardown()
    expect(emitter._count()).toBe(0)
  })

  it('does not throw when core has no emitter', () => {
    const attached = {}
    const core = { attach: (name, api) => { attached[name] = api } }
    expect(() => geolocationPlugin().install(core)).not.toThrow()
    expect(attached.geolocation.get()).toBeNull()
  })
})
