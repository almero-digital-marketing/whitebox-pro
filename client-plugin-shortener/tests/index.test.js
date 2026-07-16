import { describe, it, expect, vi } from 'vitest'

function makeCore({ claim } = {}) {
  let passportId = 'anon-1'
  const core = {
    http: { request: vi.fn(async () => claim) },
    getPassportId: () => passportId,
    setPassportId: vi.fn(id => { passportId = id }),
    attach: vi.fn(),
    logger: { warn: vi.fn() },
    _passport: () => passportId,
  }
  return core
}

function setUrl(href) {
  // cross-origin setup needs happy-dom's setURL (replaceState would throw);
  // the plugin's own same-origin scrub still uses history.replaceState.
  window.happyDOM.setURL(href)
}

// src/index.js reads its claim token from `location` at MODULE EVALUATION
// time, not inside install() (see its own comment for why). A static
// top-level import only evaluates the module once, before any test or
// beforeEach runs — so every test needs the URL set FIRST, then a fresh
// import via vi.resetModules() to force that top-level read to run again
// against the URL this specific test wants.
async function loadPlugin(href) {
  setUrl(href)
  vi.resetModules()
  const { default: shortenerPlugin } = await import('../src/index.js')
  return shortenerPlugin
}

describe('shortener client plugin', () => {
  it('does nothing (no claim) when there is no token in the URL', async () => {
    const shortenerPlugin = await loadPlugin('https://clinic.com/whitening')
    const core = makeCore()
    await shortenerPlugin().install(core)
    expect(core.http.request).not.toHaveBeenCalled()
    const [name, api] = core.attach.mock.calls[0]
    expect(name).toBe('shortener')
    expect(api.data()).toBeNull()
    expect(api.bound()).toBe(false)
  })

  it('reads a #wb= token, claims, adopts the passport, exposes prefill, scrubs the URL', async () => {
    const shortenerPlugin = await loadPlugin('https://clinic.com/whitening#wb=TOK123')
    const core = makeCore({ claim: { bound: true, passport_id: 'jane', data: { name: 'Jane' } } })
    await shortenerPlugin().install(core)

    expect(core.http.request).toHaveBeenCalledWith('/shortener/claim',
      { method: 'POST', body: { token: 'TOK123', passport_id: 'anon-1' } })
    expect(core.setPassportId).toHaveBeenCalledWith('jane')
    expect(core._passport()).toBe('jane')
    const [name, api] = core.attach.mock.calls[0]
    expect(name).toBe('shortener')
    expect(api.data()).toEqual({ name: 'Jane' })
    expect(api.bound()).toBe(true)
    expect(location.href).toBe('https://clinic.com/whitening')   // token scrubbed
  })

  it('reads a ?wb= token (query handoff)', async () => {
    const shortenerPlugin = await loadPlugin('https://clinic.com/app?wb=TOK456#/whitening')
    const core = makeCore({ claim: { bound: true, passport_id: 'jane', data: {} } })
    await shortenerPlugin().install(core)
    expect(core.http.request).toHaveBeenCalledWith('/shortener/claim',
      expect.objectContaining({ body: { token: 'TOK456', passport_id: 'anon-1' } }))
    expect(location.href).toBe('https://clinic.com/app#/whitening')   // only the wb param dropped
  })

  it('does not adopt a passport when the claim is unbound', async () => {
    const shortenerPlugin = await loadPlugin('https://clinic.com/x#wb=STALE')
    const core = makeCore({ claim: { bound: false } })
    await shortenerPlugin().install(core)
    expect(core.http.request).toHaveBeenCalledWith('/shortener/claim',
      expect.objectContaining({ body: { token: 'STALE', passport_id: 'anon-1' } }))
    expect(core.setPassportId).not.toHaveBeenCalled()
    const [name, api] = core.attach.mock.calls[0]
    expect(name).toBe('shortener')
    expect(api.data()).toBeNull()
    expect(api.bound()).toBe(false)
  })
})
