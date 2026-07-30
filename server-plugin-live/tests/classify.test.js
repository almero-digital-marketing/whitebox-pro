import { describe, it, expect } from 'vitest'
import { direction, channel } from '../src/classify.js'

describe('direction()', () => {
  it('reads awareness from its OWN recorded direction, not the type', () => {
    // core already decided this at the point of the touch; re-deriving it from
    // the event name would be a second source of truth
    expect(direction('awareness.recorded', { data: { direction: 'exposure' } })).toBe('out')
    expect(direction('awareness.recorded', { data: { direction: 'expression' } })).toBe('in')
    expect(direction('awareness.recorded', { data: { direction: 'conversion' } })).toBe('in')
    expect(direction('awareness.recorded', { data: { direction: 'observation' } })).toBe('in')
  })

  // a call is genuinely both ways; it counts as `in` because the question this
  // view answers is "is anything coming back?"
  it('counts a conversation as inbound', () => {
    expect(direction('awareness.recorded', { data: { direction: 'conversation' } })).toBe('in')
  })

  it('classifies sends as out and arrivals as in', () => {
    expect(direction('mail.sent')).toBe('out')
    expect(direction('sms.sent')).toBe('out')
    expect(direction('mail.received')).toBe('in')
    expect(direction('sms.received')).toBe('in')
    expect(direction('crm.deal')).toBe('in')
    // singular — matches what the conversions plugin emits (`conversion.${name}`)
    expect(direction('conversion.purchase')).toBe('in')
  })

  // the distinction that keeps the numbers honest: orchestration is not traffic
  it('keeps orchestration out of the in/out counts', () => {
    expect(direction('journey.enrolled')).toBe('internal')
    expect(direction('campaigns.activated')).toBe('internal')
    expect(direction('audiences.synced')).toBe('internal')
  })

  // longest prefix wins, so a specific type beats its family
  it('prefers the most specific prefix', () => {
    expect(direction('mail.bulk.queued')).toBe('out')
    expect(direction('mail.bulk.cancelled')).toBe('internal')
  })

  // deliberately NOT defaulted: an unmapped type should be visibly unclassified
  // rather than quietly folded into a number an operator is trusting
  it('reports an unmapped type as unknown rather than guessing', () => {
    expect(direction('something.nobody.mapped')).toBe('unknown')
    expect(direction('awareness.recorded', { data: { direction: 'telepathy' } })).toBe('unknown')
  })
})

describe('channel()', () => {
  it('uses awareness own channel, else the type prefix', () => {
    expect(channel('awareness.recorded', { data: { channel: 'web' } })).toBe('web')
    expect(channel('mail.sent')).toBe('mail')
    expect(channel('journey.enrolled')).toBe('journey')
  })
})

describe('coverage against what the plugins actually emit', () => {
  // Guards a whole class of silent failure: a prefix here that matches no real
  // event type looks identical to "correctly classified" until you notice the
  // dashboard reporting everything as unknown. 'conversions.' (plural) sat here
  // while the emitter produced `conversion.${name}` (singular).
  const EMITTED = [
    'conversion.view_content', 'conversion.find_location', 'conversion.purchase',
    'crm.reservation', 'crm.note',
    'mail.sent', 'mail.queued', 'mail.failed', 'mail.received',
    'mail.delivered', 'mail.bounced', 'mail.opened', 'mail.clicked',
    'mail.complained', 'mail.unsubscribed', 'mail.engaged',
    'mail.bulk.queued', 'mail.bulk.cancelled',
    'sms.sent', 'sms.queued', 'sms.failed', 'sms.received',
    'sms.delivered', 'sms.bounced', 'sms.bulk.queued', 'sms.bulk.cancelled',
    'voip.ring', 'voip.pick', 'voip.call',
    'awareness.forgotten',
    'passport.created', 'session.started',
  ]

  it.each(EMITTED)('classifies %s as something other than unknown', (type) => {
    expect(direction(type, null)).not.toBe('unknown')
  })

  it('only leaves awareness.recorded unknown, and only without its payload', () => {
    // This one is legitimately payload-dependent — the type spans both legs.
    expect(direction('awareness.recorded', null)).toBe('unknown')
    expect(direction('awareness.recorded', { data: { direction: 'observation' } })).toBe('in')
    expect(direction('awareness.recorded', { data: { direction: 'exposure' } })).toBe('out')
  })
})
