# 02 · Concepts

Five things to understand before anything else: **passport**, **session**,
**awareness**, **direction**, and the **context registry**.

## Passports & identity

A **passport** is one person. It has a UUID and a set of **identities** attached
to it. An identity is a triple:

```
{ type: 'email', name: 'primary', value: 'ada@example.com' }
{ type: 'phone', name: 'e164',    value: '+359888123456' }
{ type: 'fingerprint', name: 'browser', value: 'a1b2c3…' }
{ type: 'user',  name: 'app',     value: 'user_42' }
```

**Strong identities** (`fingerprint`, `phone`, `email`, `user`) are globally
unique — one passport per value. **Weak identities** (any other `type`, e.g. a CRM
contact id) are unique only within a passport.

### Merging

When a strong identity is linked to a passport but already belongs to another
(still within its lifespan), the two passports **merge**: one absorbs the other,
all references repoint to the survivor, and the absorbed id is kept as a tombstone
so future lookups forward to the survivor. This is how a person who first arrived
as an anonymous browser fingerprint, then gave an email, then called from a phone,
ends up as **one** customer with one memory.

Identity **lifespans** (how long an identity stays "fresh" enough to trigger a
merge) are configurable per type — defaults: `fingerprint` 7 days, `phone` 30,
`email` 365, `user` forever. See [Configuration](04-configuration.md).

You rarely link identities by hand — channels do it for you (a mail send links the
recipient's email; an inbound SMS links the sender's phone; the browser SDK links
the fingerprint). The CRM plugin links from your external customer ids.

## Sessions

A **session** is a time-boxed visit attached to a passport, carrying `utm_source`,
`utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and `referrer`. The
browser SDK opens one at page load via `POST /sessions/resolve`, which mints a
passport if needed and returns `{ passportId, sessionId }`. Awareness records can
reference the session, so you can attribute a later conversion back to the
campaign that started the visit.

## Awareness

**Awareness** is the per-passport semantic memory. Every meaningful touch is one
`record(...)` call (channels do this for you):

```js
awareness.record({
  passport_id,          // who (merged passports auto-resolve to the survivor)
  session_id,           // optional, for attribution
  ts,                   // when (defaults to now)
  channel: 'mail',      // mail | sms | web | voip | crm | …
  direction: 'exposure',// see below
  source: 'email',      // sub-type within the channel
  content_id: 'outbox:42', // stable id → repeated webhooks dedupe
  text: 'Subject: …',   // the actual content (PII-redacted by default)
  meta: { … },          // channel-specific extras
})
```

What happens to it:

- The `text` is **PII-redacted** (configurable), then hashed (`content_hash`).
- An **exposure** row is written immediately.
- A background worker splits the text into **chunks** (~200 words) and embeds each
  with OpenAI (`text-embedding-3-small`, 1536-dim). Identical content is embedded
  **once** and shared across every customer who saw it.
- Chunks are vector-indexed (HNSW) for fast semantic recall.

So "record" is cheap and synchronous; embedding is async and deduplicated.

## Direction — the most important field

`direction` captures **who acted and how strong the signal is**. It's the axis you
filter and reason over.

| direction | meaning | examples |
|---|---|---|
| `exposure` | We put content in front of them (passive receipt) | a sent email, an SMS, an article paragraph they read, an email **open** |
| `expression` | *They* acted (active signal) | an inbound reply, a form submission, a link/CTA click, an SMS `STOP`/`START` |
| `conversation` | Two-way live interaction | a voice call transcript |
| `conversion` | A business outcome | purchase, lead, add-to-cart |
| `observation` | A fact recorded about them, no interaction | a CRM note, an imported tag, a client-reported UI event |

Paired with `channel` and `source`, this lets you ask precise questions — *"what
have we told this customer about pricing"* (exposure) vs *"what has this customer
told us"* (expression).

> Note: email **opens** are recorded as `exposure` (they were exposed to the body),
> while a **click** is an `expression`. The send itself records only the subject as
> exposure; the body enters memory when they actually open it.

## Channels

A **channel** is a class of touchpoint — `mail`, `sms`, `web`, `voip`, `crm`. Each
is implemented by a plugin that owns its HTTP endpoints, its background work, and
the awareness it writes. Plugins are independent: they communicate only through the
shared `ctx` (database, queue, events, passports, awareness, …), never by importing
one another. See [07 · Channels](07-channels.md).

## The context registry

Awareness is unstructured memory (text). The **context registry** is the
structured counterpart: a plugin can register a provider that returns typed facts
about a passport (e.g. CRM's `plan_tier`, `mrr`, subscription status). When you
`ask` a question about a customer, WhiteBox assembles both — recalled awareness
chunks **and** registered context — and grounds the LLM's answer in them. The
audiences plugin uses the same context for its `crm` rule conditions.

Next: **[03 · Getting started](03-getting-started.md)**.
