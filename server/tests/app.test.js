import { describe, it, expect } from 'vitest'
import createApp from '../src/app.js'

describe('createApp — trust proxy', () => {
  it('leaves Express\'s default (false) when trustProxy is omitted', () => {
    const app = createApp()
    expect(app.get('trust proxy')).toBe(false)
  })

  it('sets a hop count', () => {
    const app = createApp({ trustProxy: 1 })
    expect(app.get('trust proxy')).toBe(1)
  })

  it('sets an explicit trusted address/subnet list', () => {
    const app = createApp({ trustProxy: '127.0.0.1,10.0.0.0/8' })
    expect(app.get('trust proxy')).toBe('127.0.0.1,10.0.0.0/8')
  })

  it('does not call app.set at all when trustProxy is undefined (default stays Express\'s own, not ours)', () => {
    const app = createApp({})
    expect(app.get('trust proxy')).toBe(false)
  })
})
