import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { voip } from '../src/index.js'

// Checks our `events` declaration against the notify() calls in our own src/.
// `voip.click` is named explicitly because it is the one that was missing — it is
// emitted by the number POOL rather than by telephony, which is how it came to be
// the only voip event live's old map had never heard of.
manifestSuite({
  plugin: voip({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['voip.click'],
  // `awareness.recorded` is core's event; we describe only the rows WE produced
  // (the catalog routes by `data.plugin`). See docs/11-plugin-events.md.
  scopedDetail: ['awareness.recorded'],
})

// What our events look like in a feed row. live used to write these, reading
// `caller` and `line`/`destination` — and knowing nothing about `number`, which is
// what the pool calls the same field. So every click-to-call had a blank detail
// column while its payload carried both the number and the tag.
describe('voip event detail', () => {
  const d = voip({}).detail['voip.']

  it('attributes a call by the line it rang', () => {
    expect(d({ caller: '+359888', line: '+35924374782', tag: 'web' }))
      .toBe('+359888 → +35924374782 (web)')
  })

  // A click is an intent, not a connection: there is no calling party yet, so the
  // number shown is the whole story and the tag says which pool it came from.
  it('describes a click-to-call by the number shown, with no caller to point at', () => {
    expect(d({ number: '+35924374782', tag: 'web', connectionId: 'c1' })).toBe('+35924374782 (web)')
  })

  it('reads the pool own field name for the tracked number', () => {
    // pool.js writes `number`; ari.js writes `line`. Both must work.
    for (const key of ['number', 'line', 'destination']) {
      expect(d({ [key]: '+359123' })).toBe('+359123')
    }
  })

  it('still names the pool when only a tag survives', () => {
    expect(d({ tag: 'sales' })).toBe('tag sales')
  })

  it('says nothing rather than something vague', () => {
    expect(d({})).toBeNull()
  })
})
