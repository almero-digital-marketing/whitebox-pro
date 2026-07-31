import { describe, it, expect } from 'vitest'
import { engagement } from '../src/index.js'

// We emit NO events, so there is no `events` manifest and no manifestSuite here —
// a touch is recorded as awareness rather than as its own event type, because
// emitting both would double-count one interaction in the traffic totals.
//
// We still author those awareness rows, though, so we describe them. This is the
// detail-only case of the contract (docs/11-plugin-events.md): core emits
// `awareness.recorded`, the payload is ours, and the catalog routes a row back
// here by `data.plugin`.
describe('engagement declares detail without declaring events', () => {
  const plugin = engagement({})

  it('has no events and does not pretend to', () => {
    expect(plugin.events).toBeUndefined()
  })

  it('describes the awareness rows it produces', () => {
    expect(plugin.detail?.['awareness.recorded']).toBeTypeOf('function')
  })
})

describe('engagement awareness detail', () => {
  const d = engagement({}).detail['awareness.recorded']

  // WHAT was consumed is the distinction that survives nowhere else — there is no
  // engagement.* event type to carry it.
  it('leads with the kind of content', () => {
    expect(d({ source: 'video', content_url: 'https://g.bg/watch/1' })).toBe('video · /watch/1')
    expect(d({ source: 'image', content_id: 'hero-1' })).toBe('image · hero-1')
  })

  // The real (already-redacted) text beats an internal id: "text · verify-text-1"
  // told an operator nothing where the sentence the person read was available.
  it('prefers the actual text over an identifier', () => {
    expect(d({ source: 'text', content_id: 'para-7', preview: 'Как работи лазерната епилация' }))
      .toBe('text · Как работи лазерната епилация')
  })

  it('flattens the newlines real page text arrives with', () => {
    expect(d({ source: 'text', preview: 'one\n\n  two   three' })).toBe('text · one two three')
  })

  // Dwell is the difference between "scrolled past" and "read it", and nothing
  // else on the row carries it.
  it('adds dwell time when there is any', () => {
    expect(d({ source: 'video', preview: 'Как работи', dwell_ms: 12400 })).toBe('video · Как работи · 12s')
    expect(d({ source: 'video', preview: 'Как работи' })).toBe('video · Как работи')
  })

  it('says nothing rather than something vague', () => {
    expect(d({})).toBeNull()
  })
})
