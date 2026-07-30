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
        ],
        // Optional. A bounded resource — something with a ceiling you can hit.
        gauges: [
          { label: 'web', used: 3, total: 8, exhausted: false },
        ],
        note: null,               // optional one-liner, shown under the row
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

### `gauges`

For a resource with a ceiling, where the ratio is the point rather than the
count — voip's number pool is the motivating case: "3 of 8 held" says something
"3" alone doesn't. `exhausted` is the plugin's own judgement, not `used === total`,
because only the plugin knows whether being full is actually a problem.

## Windowing

`since` is a `Date`. Metrics are expected to be windowed by it.

**Live state may ignore it**, and should say so. The voip pool is the current
assignment table, not a history — "how many numbers are free" has no `since`, and
there is no other source for it. Report it as a gauge and don't pretend it was
windowed.

## Failure

`status()` must never take the board down. Surfaces call it defensively, but the
plugin should still prefer returning a partial answer over throwing.

A plugin with no `status()` is simply absent from the monitoring surface — which
is different from, and must not be rendered as, a plugin reporting zeros. Zero
means "nothing happened"; absent means "nobody is watching this".

## Implemented by

`mail`, `sms`, `voip`. Any plugin may add it; nothing needs to be told.
