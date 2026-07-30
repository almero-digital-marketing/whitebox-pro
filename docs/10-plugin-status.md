# The `status()` contract

A plugin that can say something about its own health exposes `status()` on its
service. Monitoring surfaces discover it and render whatever comes back — they
hold no per-plugin knowledge.

## Why

The Live board originally hard-coded it: `service.js` knew mail and sms return
`{queued,sent,delivered,failed}`, that voip returns `{ringing,active,ended,missed}`,
and that the number pool has a shape of its own — and `Live.vue` carried a
template per channel. Adding a seventh plugin meant editing the board **and** the
UI, and the two could disagree about a plugin neither of them owns.

That is backwards. A plugin knows what its own numbers are called and which of
them is bad news; the board's job is to lay them out. So the plugin describes
itself and the board stays generic.

## Shape

```js
return {
  service: {
    // … the plugin's own API …
    async status({ since }) {
      return {
        label: 'mail',            // optional; defaults to the plugin name
        metrics: [
          { key: 'queued',    value: 12 },
          { key: 'sent',      value: 340 },
          { key: 'delivered', value: 331 },
          // `severity: 'bad'` means "when this is non-zero, it's a problem".
          // The surface decides how to show it (icon + word, never colour alone).
          { key: 'failed',    value: 2, severity: 'bad' },
          // `live` — current state, NOT windowed. `of` — a denominator, when the
          // ratio is the claim and either number alone says nothing.
          { key: 'web', value: 3, of: 8, live: true },
        ],
        note: null,               // optional one-liner, behind an info icon
      }
    },
  },
}
```

### `metrics`

Ordered — the surface renders them in the order given, so put the number an
operator reads first, first. `key` is shown verbatim, so it's a label, not an
identifier: `'delivered'`, not `'delivered_count'`.

Mark a metric `severity: 'bad'` when a non-zero value means something is wrong
(`failed`, `bounced`, `missed`). Don't mark counts that are merely large.

### `of`

A denominator, for when the ratio is the claim and either number alone says
nothing: voip's "3 of 8 numbers held", audiences' "meta 1 of 5 delivering".

There used to be a parallel `gauges` array for this — `{label, used, total,
exhausted}` — on the theory that a bounded resource is a different kind of thing
from a count. It isn't, or at least not differently enough: the array only existed
because the board drew a progress track for it, and once the track was dropped a
gauge and a metric-with-a-denominator rendered identically. `exhausted` collapsed
into `severity`, which always meant the same thing ("the plugin's own judgement
that this is a problem"). Two producers ever used it, voip and audiences, and only
voip's was a bounded resource at all.

One trap when marking a ratio `bad`: `severity` means **non-zero is a problem**, so
a metric whose failure state is `value === 0` will never fire. Audiences hits this
— "every audience on this network is dark" means `enabled - dry_run === 0` — and
the answer is to put the severity on the metric that does go non-zero
(`not delivering`) rather than to invent an inverted rule.

## Windowing

`since` is a `Date`. Metrics are expected to be windowed by it.

**Live state may ignore it, and must then say so with `live: true`.** Roughly half
the numbers on the board are current state — `0 drafts`, `1 segments`, `0 enrolled`,
`0/8 web` — and a plugin that ignores `since` is making a different claim from one
that windowed and found nothing.

Set it truthfully, but don't expect a surface to draw it. **The Live board
deliberately renders windowed and current-state figures identically.** Three
per-figure cues were tried and dropped — a `now` chip, accent colour, then
bold-vs-regular — each one spending row clarity on a distinction nobody opens the
card to ask about. What you go there for is whether a number is *wrong*, and
`severity` answers that. The flag is worth setting anyway: it is cheap, it is
tested, and working out which of your metrics are windowed is the expensive part.

If a surface does render it one day, note that metric ORDER is the plugin's (see
`metrics` above) — grouping by `live` overrides that ordering, which is why the
board stopped doing it.

The voip pool is the clearest case and worth understanding, because the difference
runs deeper than the flag: the call counts are a SQL aggregate over `started_at`,
while the pool is a read of that process's in-memory assignment map. There is no
history of it to query, it does not survive a restart, and it does not extend to a
second instance. `since` cannot apply to it — not because nobody implemented it,
but because the data does not exist.

## Failure

`status()` must never take the board down. Surfaces call it defensively, but the
plugin should still prefer returning a partial answer over throwing.

A plugin with no `status()` is simply absent from the monitoring surface — which
is different from, and must not be rendered as, a plugin reporting zeros. Zero
means "nothing happened"; absent means "nobody is watching this".

## Implemented by

`mail`, `sms`, `voip`, `shortener`, `geolocation`, `engagement`, `oauth`,
`conversions`, `crm`, `audiences`, `campaigns`, `journeys`. Any plugin may add
it; nothing needs to be told.

Some of those are worth reading as examples of the awkward cases:

- **`shortener`** has a gap it can't close — hits on unknown/expired codes leave no
  row anywhere — and reports that gap as a `note` rather than as a zero metric.
- **`geolocation`** owns no tables at all. Everything it reports is live state
  (process-lifetime counts, and the age of the MaxMind database file), so it
  ignores `since` and says so. The database age is the case that motivated the
  design: a stale GeoIP file keeps answering plausibly for months without ever
  raising an error, so the plugin turns its own judgement into a
  `stale database` metric — a 0/1 count, which is what "non-zero means something
  is wrong" wants, since the age itself is always non-zero and always fine until
  it isn't.
- **`crm`** owns no table either — records land in core facts, notes in awareness —
  and its one real failure has no counter behind it: a payload dropped with
  `202 no_identity` exists only in the log. So it reports the counts it can
  attribute, marks nothing `bad` (every number it can count is a success), and
  names the blind spot in `note` instead of a zero that would read as "nothing was
  dropped".
- **`audiences`** has no history to window at all: an audience is a standing rule,
  and the per-event delivery log it once had was dropped with the rule system
  (its migration 011). So every number it reports is current state, and the one
  that matters is read out of each audience's own `delivery` jsonb — an audience
  activated for a network with no eligible adapter is stamped `dry_run`, which
  means delivery reads as ON in the UI and nothing ever reaches the platform.
  That count is the `bad` one, and the per-network `used of total` is a gauge
  because the ratio is what an operator acts on.
- **`campaigns`** is the case for NOT marking something bad: `dryRun` defaults on,
  so on a deployment that hasn't gone live every send is a dry run. Flagging it
  would paint the card red for a system doing exactly what it was configured to
  do, so the count is reported plainly and the `note` explains the mode. What IS
  bad is a campaign past its `scheduled_at` and still `scheduled` — nothing in
  the plugin will ever deliver it.
- **`journeys`** reports both kinds of number side by side (active journeys and
  in-flight enrollments are live state; started/completed/failed are windowed on
  their own timestamps), and distinguishes two ways a person gets stranded: an
  enrollment marked `failed`, and one still `waiting` long past its own
  `next_action_at` — the delayed step job never fired, and nothing else in the
  system would ever notice.

## Deliberately not implemented

Adding nothing is a legitimate answer, and sometimes the only honest one. A
metric that only counts inventory — or that can only ever read zero — dilutes the
numbers next to it, and the `silent` list already renders "nobody is watching
this" correctly (see server-plugin-live's `collectStatus`).

- **`analytics`** is a reports/widgets composition store. How many reports exist
  is inventory. Nothing failable is persisted: a widget whose saved query stopped
  resolving is discovered at resolve time and returned per request, compose/
  describe failures 502 and are logged, and there is no error column or attempt
  counter anywhere in its schema. Re-running every saved query on each poll to
  find the broken ones would be a job, not a status call.
- **`people`** owns no tables. It reads core passports/identities/facts and writes
  through them, so the only numbers available to it are core's inventory — a
  passport count is not people's health.
