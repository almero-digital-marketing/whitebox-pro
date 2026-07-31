// live as a CONSUMER of the event catalog.
//
// These tests deliberately declare their own plugins inline rather than
// importing the real ones. That's the point of the refactor: live has no
// knowledge of any other module's event types, so a test that reached into
// server-plugin-mail to find out what mail emits would be re-introducing
// exactly the coupling this file used to have.
//
// Whether each plugin's manifest matches what it actually emits is that
// plugin's own test to write — see server-plugin-voip/tests/manifest.test.js
// for the pattern. What's tested here is only: given a catalog, does live read
// it correctly.
import { describe, it, expect, beforeEach } from 'vitest'
import { build } from 'whitebox-pro-server/event-catalog'
import { direction, channel, channels, init } from '../src/classify.js'

// A stand-in for a real plugin set — enough shapes to cover the contract: fixed
// directions, a prefix, an internal, and a module whose channel differs from its
// type prefix.
const PLUGINS = [
  {
    name: 'mail',
    events: {
      'mail.sent': 'out',
      'mail.received': 'in',
      'mail.bulk.queued': 'out',
      'mail.bulk.cancelled': 'internal',
    },
  },
  { name: 'voip', events: { 'voip.ring': 'in', 'voip.click': 'in', 'voip.pick': 'internal' } },
  { name: 'crm', events: { 'crm.': 'in' } },
  { name: 'journeys', events: { 'journey.enrolled': 'internal' } },
  { name: 'widgets', events: { 'widget.poked': 'in' }, channels: ['widget', 'gadget'] },
]

beforeEach(() => init({ eventCatalog: build(PLUGINS) }))

describe('direction()', () => {
  it('classifies sends as out and arrivals as in', () => {
    expect(direction('mail.sent')).toBe('out')
    expect(direction('mail.received')).toBe('in')
    expect(direction('voip.ring')).toBe('in')
  })

  // the distinction that keeps the numbers honest: orchestration is not traffic
  it('keeps orchestration out of the in/out counts', () => {
    expect(direction('journey.enrolled')).toBe('internal')
    expect(direction('voip.pick')).toBe('internal')
  })

  // A trailing dot declares a family, which is the only way to classify an event
  // whose suffix is chosen at runtime (`crm.${kind}`).
  it('matches a prefix declaration against any suffix', () => {
    expect(direction('crm.deal')).toBe('in')
    expect(direction('crm.anything_the_host_invents')).toBe('in')
  })

  it('prefers the most specific declaration, whatever the order', () => {
    expect(direction('mail.bulk.queued')).toBe('out')
    expect(direction('mail.bulk.cancelled')).toBe('internal')
  })

  // Deliberately NOT defaulted. An undeclared type is visibly unclassified rather
  // than quietly folded into a number an operator is trusting — which is exactly
  // how voip.click was found: it sat in `unknown` because voip had never declared
  // it and live had guessed the rest of the namespace.
  it('reports an undeclared type as unknown rather than guessing', () => {
    expect(direction('something.nobody.declared')).toBe('unknown')
  })

  it('is unknown for everything when no catalog was handed over', () => {
    init({})
    expect(direction('mail.sent')).toBe('unknown')
  })
})

describe('payload-derived declarations', () => {
  // For an event that carries its own classification, recorded where it
  // happened. Re-deriving it from the type would be a second source of truth for
  // something the emitter already decided.
  const cat = build([{
    name: 'core',
    events: {
      'touch.recorded': {
        direction: { from: 'data.direction', map: { exposure: 'out', expression: 'in' } },
        channel: { from: 'data.channel' },
      },
    },
    channels: ['web'],
  }])

  beforeEach(() => init({ eventCatalog: cat }))

  it('reads the direction out of the payload', () => {
    expect(direction('touch.recorded', { data: { direction: 'exposure' } })).toBe('out')
    expect(direction('touch.recorded', { data: { direction: 'expression' } })).toBe('in')
  })

  it('does not guess a value the declaration does not cover', () => {
    expect(direction('touch.recorded', { data: { direction: 'telepathy' } })).toBe('unknown')
    expect(direction('touch.recorded', null)).toBe('unknown')
  })

  it('reads the channel out of the payload too', () => {
    expect(channel('touch.recorded', { data: { channel: 'voip' } })).toBe('voip')
  })

  // A module reporting a different channel per row cannot itself BE a channel —
  // otherwise `touch` shows up as a filter option that matches nothing. live used
  // to carry a hand-written blacklist for this.
  it('keeps a per-row channel namespace out of the filter list', () => {
    expect(channels()).not.toContain('touch')
    expect(channels()).toContain('web')
  })
})

describe('channel()', () => {
  it('defaults to the type first segment', () => {
    expect(channel('mail.sent')).toBe('mail')
    expect(channel('journey.enrolled')).toBe('journey')
  })

  // So an unclassified row still lands somewhere sensible in the breakdown
  // rather than vanishing from it.
  it('still names a channel for an undeclared type', () => {
    expect(channel('something.nobody.declared')).toBe('something')
  })
})

describe('channels() — the filter list', () => {
  // A filter list is not a report. It is every channel the system HAS, so a
  // channel can be switched off before it gets busy rather than only after.
  // `passport`, `session` and `web` are core's own and are always present — core
  // emits passport.created / session.started and receives the browser SDK's page
  // views, whatever plugins are installed.
  it('is the union of what core and the loaded plugins declared', () => {
    expect(channels()).toEqual([
      'crm', 'gadget', 'journey', 'mail', 'passport', 'session', 'voip', 'web', 'widget',
    ])
  })

  // The old list was derived from live's own map and offered three options that
  // could never match a row (audiences and engagement emit nothing; nothing has
  // ever emitted webhook.*). Nobody declares them, so they cannot appear.
  it('cannot offer a channel no plugin declared', () => {
    for (const dead of ['audiences', 'engagement', 'webhook']) {
      expect(channels()).not.toContain(dead)
    }
  })

  it('is empty rather than fabricated when nothing was handed over', () => {
    init({})
    expect(channels()).toEqual([])
  })
})
