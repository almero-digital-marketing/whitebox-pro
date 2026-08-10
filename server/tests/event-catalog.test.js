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
import { build, direction, channel, detail, severity, severityTypes, lookup, CORE_EVENTS } from '../src/event-catalog.js'

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

// Anything offering event types to a human needs a LIST, and the only list that
// used to exist was "types seen in the log" — so the journeys trigger picker could
// not offer an event until it had already happened.
describe('the enumerable vocabulary', () => {
  it('lists every exactly-declared type, so it can be offered before it fires', () => {
    const cat = build([
      { name: 'voip', events: { 'voip.click': 'in', 'voip.ring': 'in' } },
      { name: 'mail', events: { 'mail.sent': 'out' } },
    ])
    expect(cat.types).toEqual(expect.arrayContaining(['mail.sent', 'voip.click', 'voip.ring']))
    // core's own too — they exist whatever is installed
    expect(cat.types).toEqual(expect.arrayContaining(['passport.created', 'session.started']))
  })

  it('keeps prefixes out of the type list, because a prefix is not a pickable event', () => {
    const cat = build([{ name: 'crm', events: { 'crm.': 'in' } }])
    expect(cat.types).not.toContain('crm.')
  })

  // The answer for everything that ISN'T predefined: crm emits `crm.${kind}` where
  // the kind is the host CRM's vocabulary, conversions emits `conversion.${name}`
  // where the name is whatever the site invents. Publishing the prefix, rather than
  // pretending it doesn't exist, is what lets a picker offer free-text entry under
  // it instead of a dead end.
  it('publishes the open-ended families, with who owns each one', () => {
    const cat = build([
      { name: 'crm', events: { 'crm.': 'in' } },
      { name: 'conversions', events: { 'conversion.': 'in', 'adnetwork.accepted': 'out' } },
    ])
    expect(cat.families).toEqual([
      { prefix: 'conversion.', module: 'conversions', direction: 'in' },
      { prefix: 'crm.', module: 'crm', direction: 'in' },
    ])
    // an exactly-declared type is not a family
    expect(cat.families.map(f => f.prefix)).not.toContain('adnetwork.accepted')
  })

  it('has no families when every declaration is exact', () => {
    expect(build([{ name: 'voip', events: { 'voip.click': 'in' } }]).families).toEqual([])
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

// ── detail: what an event was ABOUT ─────────────────────────────────────────

describe('severity()', () => {
  const cat = () => build([plugin('mail', {
    'mail.sent': 'out',
    'mail.failed': { direction: 'out', severity: 'error' },
    'mail.bounced': { direction: 'out', severity: 'warn' },
  })])

  it('reports what the emitting module declared', () => {
    expect(severity(cat(), 'mail.failed')).toBe('error')
    expect(severity(cat(), 'mail.bounced')).toBe('warn')
  })

  // The absence IS the statement — see the note on the contract. A routine event
  // and an undeclared one both answer null, deliberately: a feed filtered to
  // problems shows what modules have CLAIMED is a problem, so a plugin that
  // declares nothing is visibly absent from that view rather than guessed at.
  it('is null for a routine event and for one nobody declared', () => {
    expect(severity(cat(), 'mail.sent')).toBeNull()
    expect(severity(cat(), 'voip.click')).toBeNull()
    expect(severity(null, 'mail.failed')).toBeNull()
  })

  // A value outside the vocabulary is not passed through to the UI, which would
  // then be styling a class name a plugin invented.
  it('rejects a level it does not define', () => {
    const c = build([plugin('x', { 'x.a': { direction: 'in', severity: 'critical' } })])
    expect(severity(c, 'x.a')).toBeNull()
  })

  // Per-ROW severity — one type whose outcome is only known from the payload.
  // voip is the real case: a completed call and an unanswered one are both
  // `voip.call`, and only `data.status` separates them. This shape existed
  // untested until something needed it.
  describe('{ from, map } — decided per row', () => {
    const rowCat = () => build([plugin('voip', {
      'voip.call': { direction: 'in', severity: { from: 'data.status', map: { missed: 'warn' } } },
    })])

    it('reads the level out of the payload', () => {
      expect(severity(rowCat(), 'voip.call', { data: { status: 'missed' } })).toBe('warn')
    })

    it('is routine for a value the map does not name', () => {
      // An answered call is not a problem, and must not be styled as one.
      expect(severity(rowCat(), 'voip.call', { data: { status: 'ended' } })).toBeNull()
    })

    it('is routine when the field is missing entirely', () => {
      // A payload shape that predates the declaration must not become a warning.
      expect(severity(rowCat(), 'voip.call', { data: {} })).toBeNull()
      expect(severity(rowCat(), 'voip.call', {})).toBeNull()
      expect(severity(rowCat(), 'voip.call')).toBeNull()
    })

    it('still refuses a level outside the vocabulary', () => {
      const c = build([plugin('x', {
        'x.a': { direction: 'in', severity: { from: 'data.s', map: { bad: 'critical' } } },
      })])
      expect(severity(c, 'x.a', { data: { s: 'bad' } })).toBeNull()
    })

    // severityTypes() is what the QUERY narrows on, and it cannot evaluate a
    // per-row severity — so the type has to be offered as a candidate and
    // severity() decides afterwards. If it were omitted here, the problems view
    // would never fetch the rows it then filters.
    it('is offered as a query candidate', () => {
      expect(severityTypes(rowCat()).types).toContain('voip.call')
    })
  })

  it('does not disturb direction or channel on the same declaration', () => {
    expect(direction(cat(), 'mail.failed')).toBe('out')
    expect(channel(cat(), 'mail.failed')).toBe('mail')
  })

  // Severity travels with a prefix declaration exactly as direction does — the
  // same longest-match dispatch, not a second lookup rule.
  it('follows a prefix declaration', () => {
    const c = build([plugin('job', { 'job.': { direction: 'internal', severity: 'warn' } })])
    expect(severity(c, 'job.anything')).toBe('warn')
  })

  // The set a QUERY needs. Filtering a page of recent rows afterwards cannot
  // answer "what went wrong in the last 30 minutes" on a busy board — the buffer
  // is under two minutes of it.
  it('enumerates the declarations that carry a severity', () => {
    const c = build([
      plugin('mail', {
        'mail.sent': 'out',
        'mail.failed': { direction: 'out', severity: 'error' },
        'mail.bounced': { direction: 'out', severity: 'warn' },
      }),
      plugin('job', { 'job.': { direction: 'internal', severity: 'warn' } }),
    ])
    const { types, prefixes } = severityTypes(c)
    expect(types).toEqual(expect.arrayContaining(['mail.failed', 'mail.bounced']))
    expect(types).not.toContain('mail.sent')
    expect(prefixes).toEqual(['job.'])
  })

  // Empty, not everything. A caller turning this into `WHERE type IN (…)` would
  // otherwise narrow nothing and return the whole feed labelled "problems".
  it('enumerates nothing when no plugin declares a severity', () => {
    const c = build([plugin('mail', { 'mail.sent': 'out' })])
    expect(severityTypes(c)).toEqual({ types: [], prefixes: [] })
    expect(severityTypes(null)).toEqual({ types: [], prefixes: [] })
  })

  it('reads a per-row level out of the payload when declared that way', () => {
    const c = build([plugin('x', {
      'x.done': { direction: 'out', severity: { from: 'data.outcome', map: { broke: 'error' } } },
    })])
    expect(severity(c, 'x.done', { data: { outcome: 'broke' } })).toBe('error')
    // an outcome the map does not cover is not guessed
    expect(severity(c, 'x.done', { data: { outcome: 'fine' } })).toBeNull()
  })
})

describe('detail() dispatch', () => {
  const PLUGINS = [{
    name: 'mail',
    events: { 'mail.sent': 'out', 'mail.bulk.queued': 'out' },
    detail: { 'mail.': (d) => d.to ?? null, 'mail.bulk.': (d) => `${d.accepted} recipients` },
  }]

  it('routes to the declaring module, most specific first', () => {
    const cat = build(PLUGINS)
    expect(detail(cat, 'mail.sent', { data: { to: 'a@b.c' } })).toBe('a@b.c')
    expect(detail(cat, 'mail.bulk.queued', { data: { accepted: 9 } })).toBe('9 recipients')
  })

  // Applied here rather than by every declaration, so the cap lives in one place
  // and a plugin can't forget it.
  it('applies the length cap for the declaration', () => {
    const cat = build([{ name: 'x', events: { 'x.y': 'in' }, detail: { 'x.y': () => 'z'.repeat(5000) } }])
    expect(detail(cat, 'x.y', {}).length).toBeLessThanOrEqual(200)
  })

  it('is null for an event with no detail declared, and with no catalog', () => {
    expect(detail(build([{ name: 'q', events: { 'q.r': 'in' } }]), 'q.r', {})).toBeNull()
    expect(detail(null, 'mail.sent', {})).toBeNull()
  })

  // A detail function runs over arbitrary HISTORICAL payloads, including rows
  // written before a field existed. One row failing to describe itself must never
  // be the thing that breaks the board.
  it('contains a throwing declaration instead of propagating it', () => {
    const warn = vi.fn()
    const cat = build([{ name: 'boom', events: { 'boom.x': 'in' }, detail: { 'boom.x': () => { throw new Error('nope') } } }])
    expect(detail(cat, 'boom.x', {}, { logger: { warn } })).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  // The drift the two maps make possible, and the exact failure that made live's
  // old map untrustworthy: a branch that never runs looks identical to a correct
  // one.
  it('reports a detail key no declared event can match', () => {
    const warn = vi.fn()
    const cat = build([{
      name: 'typo',
      events: { 'conversion.': 'in' },
      detail: { 'conversions.': () => 'never runs' },   // plural — matches nothing
    }], { logger: { warn } })
    expect(cat.orphanDetail).toEqual([{ key: 'conversions.', module: 'typo' }])
    expect(warn).toHaveBeenCalled()
  })

  it('accepts a detail key covered by a prefix declaration', () => {
    const cat = build([{
      name: 'mail',
      events: { 'mail.sent': 'out' },
      detail: { 'mail.': (d) => d.to },
    }])
    expect(cat.orphanDetail).toEqual([])
  })
})

describe("core's own event detail", () => {
  const cat = build([])
  const d = (type, data) => detail(cat, type, { data })

  it('names a new visitor and attributes a new session', () => {
    expect(d('passport.created', {})).toBe('new visitor')
    expect(d('session.started', { utm_source: 'google', utm_campaign: 'brand' })).toBe('google / brand')
    expect(d('session.started', { utm_source: 'google' })).toBe('google')
    expect(d('session.started', { referrer: 'https://ref.com/x' })).toBe('ref /x')
    // Attribution is the reason anyone looks at a new session; saying so plainly
    // beats an empty column.
    expect(d('session.started', {})).toBe('direct')
  })

  it('shows the real (redacted) text when core carries a preview', () => {
    // "text · verify-text-1" told an operator nothing — an internal identifier
    // where the sentence the person actually read was available.
    expect(d('awareness.recorded', { source: 'text', preview: 'Как работи лазерната епилация' }))
      .toBe('text · Как работи лазерната епилация')
  })

  it('flattens newlines and whitespace runs out of real page text', () => {
    expect(d('awareness.recorded', { source: 'text', preview: 'one\n\n  two   three' }))
      .toBe('text · one two three')
  })

  // Producers compose "<their own label> — <the real content>". That first segment
  // restates the type column one place to the left AND eats the row's width before
  // the content gets a chance.
  it('ignores a preview that only restates the event type', () => {
    expect(d('awareness.recorded', {
      source: 'text',
      content_id: 'conversion:view_content:abc',
      content_url: 'https://gpoint.bg/studios',
      preview: 'Conversion: view content',
    })).toBe('text · /studios')
  })

  it('still shows a preview that is genuinely different from the type', () => {
    expect(d('awareness.recorded', {
      source: 'text',
      content_id: 'conversion:view_content:abc',
      preview: 'Conversion: view content — Защо не използваме лазер',
    })).toBe('text · Защо не използваме лазер')
  })

  // `source` carries WHAT was consumed and is the only place that distinction
  // survives — there is no engagement.* event type, on purpose: it would
  // double-count one touch as two events in the traffic totals.
  it('names the content kind, which is the only place it survives', () => {
    expect(d('awareness.recorded', { source: 'video', content_url: 'https://a.bg/watch/1' }))
      .toBe('video · /watch/1')
    expect(d('awareness.recorded', { source: 'image', content_id: 'hero-1' })).toBe('image · hero-1')
  })

  it('percent-decodes a non-ASCII content path for display', () => {
    expect(d('awareness.recorded', { source: 'text', content_url: 'https://gpoint.bg/%D0%BA%D0%BB%D1%83%D0%B1' }))
      .toBe('text · /клуб')
  })

  it('says which passport was forgotten, without printing the whole id', () => {
    expect(d('awareness.forgotten', { passport_id: 'abcdef1234567890' })).toBe('forgot abcdef12')
    expect(d('awareness.forgotten', {})).toBe('forgot a passport')
  })
})
