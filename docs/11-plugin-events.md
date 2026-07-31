# The `events` manifest

A plugin that emits events declares what they **mean** — the direction they flow,
the channel they belong to, and what one looks like in a feed row. Core aggregates
every declaration into one catalog; monitoring surfaces read it and hold no
per-plugin knowledge.

This is the sibling of [the `status()` contract](10-plugin-status.md), and for the
same reason: a plugin knows its own vocabulary, and anything else guessing at it
will be wrong eventually.

## Why

Classification used to live in `server-plugin-live/src/classify.js` — one map,
maintained by the monitoring plugin, describing the event namespaces of sixteen
other modules. It was wrong in five ways at once, and **none of them were visible
from the file that contained them**:

| what was wrong | effect |
| --- | --- |
| `voip.click` missing (`call`/`ring`/`pick` were there) | click-to-call classified `unknown`, counted in neither direction — for as long as the feature had existed |
| `'conversions.'` declared, plural | the emitter produces `conversion.${name}`; every conversion classified `unknown` |
| `mail.clicked` declared | never emitted — the tracked status is `engaged` |
| `adnetwork.skipped` declared | never emitted — an ineligible network returns before the `notify()` |
| `webhook.` `queue.` `engagement.` `audiences.` declared | emitted by **nobody**; three then appeared as channel filter options that could never match a row |

Every one of those is a statement about somebody else's plugin that only that
plugin could have got right. Two of them were found by a user noticing a blank
column in the UI, which is the wrong way to find out.

## Shape

`events` is a **static** field on the factory's return value — no `register()`
call needed to read it, exactly like `permissions`:

```js
export function voip(options = {}) {
  return {
    name: 'voip',

    events: {
      'voip.ring':  'in',
      'voip.click': 'in',
      'voip.call':  'in',
      'voip.pick':  'internal',
    },

    register(app, ctx) { /* … */ },
  }
}
```

### Keys

An exact event type, or a **prefix** if it ends in a dot:

```js
events: {
  'crm.': 'in',            // covers crm.booking, crm.deal, crm.<anything>
}
```

A prefix is the only way to declare an event whose suffix is chosen at runtime
(`crm.${kind}`, `conversion.${name}`) — the vocabulary belongs to the system on
the other side. Where the set *is* closed, enumerate it: a prefix silently
swallows a new event type, and an unclassified one showing up as `unknown` is the
signal that it needs a decision.

Longest match wins, so `'mail.'` and `'mail.bulk.cancelled'` can disagree and the
order you write them in doesn't matter.

### Values

A direction:

| | |
| --- | --- |
| `'in'` | something arrived from the outside world |
| `'out'` | whitebox reached out |
| `'internal'` | orchestration that touched nobody outside |

`internal` is not a shrug — it's what stops the numbers lying. A journey
enrollment is not traffic. `campaigns.sent` is `internal` too, because a campaign
never delivers anything itself: it hands the send to mail or sms, and *they* emit
the outbound events, one per message. Classifying it as `out` as well would count
the same send twice and make the outbound figure impossible to reconcile against
the outbox.

Or an object, when the answer isn't fixed at declaration time:

```js
events: {
  'invoice.raised': { direction: 'out', channel: 'billing' },   // channel ≠ prefix

  'awareness.recorded': {
    direction: { from: 'data.direction', map: { exposure: 'out', expression: 'in' } },
    channel:   { from: 'data.channel' },
  },
}
```

`{ from, map }` reads the answer out of the payload, for an event that carries its
own classification recorded at the point it happened. It exists so that staying
declarative doesn't cost accuracy — re-deriving a direction the emitter already
decided would be a second source of truth for the same fact. A value the `map`
doesn't cover classifies as `unknown` rather than being guessed.

## Channels

A channel defaults to the type's **first segment**, which is how these names are
built. Declare `channels: [...]` for a channel no type reveals:

```js
channels: ['web'],   // arrives as awareness.recorded with the channel in the payload
```

The union of every declared channel **is** the channel filter list, and that's why
it's a declaration rather than a query over recent traffic: a filter list is not a
report. Options derived from "what happened lately" mean a quiet window offers
nothing to filter by — you could switch a channel off after it got busy, never
before. A channel is a thing the system *has*.

One invariant worth knowing: a namespace whose channel is **per-row** is not
itself a channel. A module reporting a different channel on every row can't also
be one — `awareness` is the instance, and it's why that prefix never appears as a
filter option even though `awareness.forgotten` declares no channel of its own.

## `detail` — what an event was about

A feed of type names answers "something happened" and nothing more: twenty rows
reading `awareness.recorded` are indistinguishable, so an operator has to open each
one to learn anything. The type is the verb; `detail` is the object.

```js
detail: {
  'mail.bulk.': (d) => (d.accepted != null ? `${d.accepted} recipients` : null),
  'mail.':      (d) => (d.to && d.subject ? `${d.to} · ${d.subject}` : d.to || null),
},
```

A **separate map** from `events`, keyed the same way (exact type, or a trailing-dot
prefix, longest match wins). Separate because the natural granularity differs: mail
declares eleven event types but needs two detail functions. `build()` warns about a
detail key that no declared event can match, so the two maps can't quietly drift.

The function receives the payload **body** (`payload.data`, unwrapped for you) and
returns a string or `null`.

Rules:

- **Never guess a shape.** Every field you read should be one you actually write.
  This is the rule live couldn't follow, because it was reading other people's
  payloads: it described journeys with `name || title || slug || id` and the
  payloads carry none of those four.
- **Return `null` rather than something vague.** "—" in the UI is honest; an
  invented summary is worse than no summary.
- **Don't truncate.** `detail()` applies the length cap for you, so it lives in one
  place and you can't forget it.
- **No PII beyond what your own surfaces already show.** sms deliberately never
  reads `body`: the event registry strips it at the write, so reading it would make
  a backfilled row describe itself differently from the same event arriving live.
- **A throw is contained**, yielding `null` and a warning. These functions run over
  arbitrary historical payloads, including rows written before a field existed, and
  one row failing to describe itself must never break the board. Don't rely on it.

Shared formatting helpers live in `whitebox-pro-server/event-format` — `trim`,
`money`, `pathOf`, `collapse`, `body`. Use them rather than reimplementing:
`pathOf` alone encodes two bug fixes (percent-decoding Cyrillic paths for display,
and surviving a malformed escape sequence), and a second copy would have one of
them.

```js
import { money, pathOf } from 'whitebox-pro-server/event-format'
```

## Declaring nothing

Perfectly normal, and correct for a plugin that emits no events — `analytics`,
`audiences`, `engagement`, `geolocation`, `oauth` and `people` all sit here.

`engagement` is the instructive one: it records **awareness** rather than emitting
its own events, so its traffic already arrives as `awareness.recorded` under
whatever channel the touch happened on. Declaring `'engagement.'` (as live once
did) classified nothing — it just added a filter option that could never match.

## Undeclared events

An event nobody declares classifies as `unknown` — deliberately, and never as
`internal`. A plugin added tomorrow shows up in the board's `unknown` bucket and
is visibly missing from its own manifest, which is a prompt to declare it. A
default would instead be a number quietly drifting wrong. This is exactly how
`voip.click` was eventually found.

## Test your own manifest

The declaration and the `notify()` calls now live in the same package, so they can
be checked against each other — and it's worth doing by **scanning your own
source** rather than against a hand-kept list, because a hand-kept list of "what
we emit" is just a second thing to forget to update. (The one in live's tests had
drifted too: it named `mail.clicked` and `mail.unsubscribed`, neither of which any
plugin emits.)

Core ships the check. Four lines:

```js
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { voip } from '../src/index.js'

manifestSuite({
  plugin: voip({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['voip.click'],       // guards the scanner itself
})
```

It asserts both directions — every type you emit is declared, and every
declaration is emitted — plus that no `detail` key is unreachable. `expectEmitted`
is a guard on the scan: if the regex ever stops matching, every other assertion
would pass vacuously.

For a namespace built with a template literal, you must account for it one of two
ways, and the suite fails if you do neither:

- **Open vocabulary** → declare a prefix. `crm.${kind}` is the CRM's vocabulary,
  not ours.
- **Closed vocabulary** → enumerate it, and pass it as `dynamicTypes`. mail emits
  `mail.${status}` from its own `statusMap`, so a prefix would swallow a sixth
  status silently — whatever direction it actually flows.

```js
manifestSuite({
  plugin: mail({}),
  srcDir: new URL('../src', import.meta.url),
  dynamicTypes: ['mail.delivered', 'mail.opened', 'mail.engaged', 'mail.bounced', 'mail.complained'],
})
```

Then test your `detail` functions directly — they're pure functions of a payload
body, so no fixtures are needed:

```js
const d = voip({}).detail['voip.']
expect(d({ number: '+35924374782', tag: 'web' })).toBe('+35924374782 (web)')
```
