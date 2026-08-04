import { describe, it, expect } from 'vitest'
import createApp from '../src/app.js'

// `trust proxy fn` is the function Express compiles the setting into (via
// proxy-addr). Calling it directly tests what actually decides whether
// X-Forwarded-For is believed, rather than just asserting the string we passed in —
// and it can check the untrusted case, which a loopback test request never exercises.
const trusts = (app, addr) => app.get('trust proxy fn')(addr, 0)

describe('createApp — trust proxy', () => {

  it('defaults to trusting private peers only', () => {
    const app = createApp()
    expect(app.get('trust proxy')).toBe('loopback, linklocal, uniquelocal')
  })

  it('believes X-Forwarded-For from a proxy on loopback or a private network', () => {
    const app = createApp()
    expect(trusts(app, '127.0.0.1')).toBe(true)      // proxy on the same host
    expect(trusts(app, '10.0.0.5')).toBe(true)       // private network
    expect(trusts(app, '192.168.3.44')).toBe(true)   // the gate, in gpoint's case
    expect(trusts(app, '172.16.0.1')).toBe(true)
    expect(trusts(app, '169.254.1.1')).toBe(true)    // link-local
  })

  // The reason a default is safe at all. A hop count would trust whatever header a
  // directly-connected client sent, letting anyone claim any address — in a system
  // that records addresses against people.
  it('IGNORES X-Forwarded-For from a public peer, so a direct client cannot spoof', () => {
    const app = createApp()
    expect(trusts(app, '8.8.8.8')).toBe(false)
    expect(trusts(app, '94.155.58.44')).toBe(false)
    expect(trusts(app, '1.1.1.1')).toBe(false)
  })

  it('treats {} the same as no argument', () => {
    expect(createApp({}).get('trust proxy')).toBe('loopback, linklocal, uniquelocal')
  })

  it('lets an explicit hop count win', () => {
    const app = createApp({ trustProxy: 1 })
    expect(app.get('trust proxy')).toBe(1)
    // A hop count trusts the immediate peer whatever it is — which is why it is not
    // the default, and why it should only be set when a proxy is definitely in front.
    expect(trusts(app, '8.8.8.8')).toBe(true)
  })

  it('lets an explicit address/subnet list win', () => {
    const app = createApp({ trustProxy: '127.0.0.1,10.0.0.0/8' })
    expect(app.get('trust proxy')).toBe('127.0.0.1,10.0.0.0/8')
    expect(trusts(app, '10.1.2.3')).toBe(true)
    expect(trusts(app, '192.168.1.1')).toBe(false)   // narrower than the default
  })

  it('allows opting out entirely with false', () => {
    const app = createApp({ trustProxy: false })
    expect(app.get('trust proxy')).toBe(false)
    expect(trusts(app, '127.0.0.1')).toBe(false)
  })
})
