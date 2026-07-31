// The event catalog — what each event MEANS, declared by whoever emits it.
//
// This replaced a map inside server-plugin-live that described sixteen other
// modules' event namespaces. The tests below are mostly about the failure modes
// that map actually had, because every one of them was invisible from the file
// that contained it:
//   · an event nobody declared           → voip.click, classified `unknown`
//   · a declaration nobody emits         → webhook. queue. engagement. audiences.
//   · a near-miss                        → 'conversions.' for `conversion.`
//   · a prefix that is not a channel     → `awareness` in the channel filter
import { describe, it, expect, vi } from 'vitest'
import { build, direction, channel, lookup, CORE_EVENTS } from '../src/event-catalog.js'

const plugin = (name, events, channels) => ({ name, events, ...(channels && { channels }) })

describe('build()', () => {
  it('takes declarations from every plugin plus core', () => {
    const cat = build([plugin('voip', { 'voip.ring': 'in' })])
    expect(lookup(cat, 'voip.ring')).toMatchObject({ module: 'voip', direction: 'in' })
    // core's own are always there, whatever is installed
    expect(lookup(cat, 'passport.created')).toMatchObject({ module: 'core' })
  })

  it('ignores a plugin that declares nothing', () => {
    // The right answer for analytics, audiences, engagement, geolocation, oauth
    // and people — they emit no events. live used to declare 'engagement.' and
    // 'audiences.' anyway, which classified nothing and added two filter options
    // that could never match.
    const cat = build([{ name: 'audiences' }, { name: 'engagement', events: undefined }])
    expect(cat.channels).not.toContain('audiences')
    expect(cat.channels).not.toContain('engagement')
  })

  // Two modules claiming one event type is a real problem, not something to
  // resolve silently by letting the last one win.
  it('reports a duplicate declaration instead of quietly overwriting', () => {
    const warn = vi.fn()
    const cat = build([
      plugin('mail', { 'shared.thing': 'out' }),
      plugin('sms', { 'shared.thing': 'in' }),
    ], { logger: { warn } })

    expect(cat.conflicts).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    // the first declaration stands — dropping the second is the smaller lie
    expect(direction(cat, 'shared.thing')).toBe('out')
  })
})

describe('direction()', () => {
  const cat = build([
    plugin('mail', {
      'mail.sent': 'out',
      'mail.received': 'in',
      'mail.bulk.queued': 'out',
      'mail.bulk.cancelled': 'internal',
    }),
    plugin('crm', { 'crm.': 'in' }),
  ])

  it('reads a fixed direction', () => {
    expect(direction(cat, 'mail.sent')).toBe('out')
    expect(direction(cat, 'mail.received')).toBe('in')
  })

  // The only way to declare an event whose suffix is chosen at runtime —
  // `crm.${kind}`, `conversion.${name}`.
  it('matches a trailing-dot declaration as a family', () => {
    expect(direction(cat, 'crm.deal')).toBe('in')
    expect(direction(cat, 'crm.whatever_the_host_calls_it')).toBe('in')
  })

  // Longest match wins, so declaration order cannot matter.
  it('prefers the most specific declaration', () => {
    expect(direction(cat, 'mail.bulk.queued')).toBe('out')
    expect(direction(cat, 'mail.bulk.cancelled')).toBe('internal')
  })

  // The property that surfaced voip.click. NOT defaulted to `internal`: a plugin
  // added tomorrow shows up in the board's `unknown` bucket and is visibly
  // missing from its own manifest, where a default would be a number quietly
  // drifting wrong.
  it('is unknown for an undeclared type, never a guess', () => {
    expect(direction(cat, 'nobody.declared.this')).toBe('unknown')
    expect(direction(null, 'mail.sent')).toBe('unknown')
  })

  // A near-miss is indistinguishable from a correct declaration until you notice
  // the dashboard reporting everything as unknown. 'conversions.' sat in live's
  // map while the emitter produced `conversion.`.
  it('does not match a declaration that is merely similar', () => {
    const c = build([plugin('conversions', { 'conversions.': 'in' })])
    expect(direction(c, 'conversion.purchase')).toBe('unknown')
  })
})

describe('payload-derived declarations', () => {
  // For an event that carries its own classification, recorded at the point it
  // happened. Re-deriving it from the type would be a second source of truth for
  // a fact the emitter already established.
  it('reads the direction out of the payload via a map', () => {
    const cat = build([])
    expect(direction(cat, 'awareness.recorded', { data: { direction: 'exposure' } })).toBe('out')
    expect(direction(cat, 'awareness.recorded', { data: { direction: 'expression' } })).toBe('in')
    // a call is genuinely both ways; `in` because the question is "is anything
    // coming back?", and a call is the strongest possible yes
    expect(direction(cat, 'awareness.recorded', { data: { direction: 'conversation' } })).toBe('in')
  })

  it('does not guess a value the map does not cover', () => {
    const cat = build([])
    expect(direction(cat, 'awareness.recorded', { data: { direction: 'telepathy' } })).toBe('unknown')
    expect(direction(cat, 'awareness.recorded', null)).toBe('unknown')
  })
})

describe('channel()', () => {
  const cat = build([
    plugin('mail', { 'mail.sent': 'out' }),
    plugin('billing', { 'invoice.raised': { direction: 'out', channel: 'billing' } }),
  ])

  it('defaults to the type first segment, which is how these names are built', () => {
    expect(channel(cat, 'mail.sent')).toBe('mail')
  })

  it('honours an explicit channel that differs from the prefix', () => {
    expect(channel(cat, 'invoice.raised')).toBe('billing')
    expect(cat.channels).toContain('billing')
    expect(cat.channels).not.toContain('invoice')
  })

  it('reads a per-row channel out of the payload', () => {
    expect(channel(cat, 'awareness.recorded', { data: { channel: 'voip' } })).toBe('voip')
  })

  // So an unclassified row still lands somewhere in the per-channel breakdown
  // rather than disappearing from it.
  it('still names a channel for an undeclared type', () => {
    expect(channel(cat, 'nobody.declared.this')).toBe('nobody')
  })
})

describe('the channel list', () => {
  // A filter list is not a report: it is every channel the system HAS, so a
  // channel can be switched off before it gets busy rather than only after.
  it('is the union of declared channels, sorted', () => {
    const cat = build([
      plugin('voip', { 'voip.ring': 'in' }),
      plugin('mail', { 'mail.sent': 'out' }),
      plugin('widgets', { 'widget.poked': 'in' }, ['gadget']),
    ])
    expect(cat.channels).toEqual(['gadget', 'mail', 'passport', 'session', 'voip', 'web', 'widget'])
  })

  // `web` arrives ONLY as an awareness channel, from the browser SDK's page
  // views, so no event type mentions it — it has to be declared by name or the
  // SDK's traffic is unfilterable.
  it('includes web, which no event type reveals', () => {
    expect(build([]).channels).toContain('web')
  })

  // The invariant that replaced live's hand-written blacklist: a module reporting
  // a different channel on every row cannot itself BE a channel. `awareness` is
  // a type family; its events say which channel they happened on.
  it('excludes a namespace whose channel is per-row', () => {
    expect(build([]).channels).not.toContain('awareness')
    // ...while awareness events still classify perfectly well
    expect(direction(build([]), 'awareness.forgotten')).toBe('internal')
  })

  it('cannot offer a channel nobody declared', () => {
    const cat = build([plugin('mail', { 'mail.sent': 'out' })])
    for (const dead of ['webhook', 'queue', 'engagement', 'audiences', 'journeys']) {
      expect(cat.channels).not.toContain(dead)
    }
  })
})

describe("core's own declarations", () => {
  it('gives every core event a usable direction', () => {
    const cat = build([])
    for (const type of Object.keys(CORE_EVENTS)) {
      const d = direction(cat, type, { data: { direction: 'exposure', channel: 'web' } })
      expect(['in', 'out', 'internal'], type).toContain(d)
    }
  })
})
