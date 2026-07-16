import { describe, it, expect, vi } from 'vitest'
import voipPlugin from '../src/index.js'

function makeCore() {
  const attached = {}
  const core = {
    transport: { isConnected: () => false, send: vi.fn() },
    http: { request: vi.fn(), beacon: vi.fn() },
    emitter: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    queue: (fn) => fn(),   // run inline — install()'s orchestrator.start() call
    logger: { warn: vi.fn(), debug: vi.fn() },
    attach: vi.fn((name, api) => { attached[name] = api }),
  }
  return { core, attached }
}

describe('voip client plugin — attach() surface', () => {
  it('current(tag) returns null when there is no active assignment for that tag', async () => {
    const { core, attached } = makeCore()
    await voipPlugin().install(core)
    expect(attached.voip.current('sales')).toBeNull()
  })

  it('exposes request/release/stop as callable functions', async () => {
    const { core, attached } = makeCore()
    await voipPlugin().install(core)
    expect(typeof attached.voip.request).toBe('function')
    expect(typeof attached.voip.release).toBe('function')
    expect(typeof attached.voip.stop).toBe('function')
  })
})
