# WhiteBox — documentation

A guide to running, configuring, and using WhiteBox, written for the person who
operates and integrates it — not the person who works on its internals.

**WhiteBox is a channel backend with memory.** It records every customer touch —
email, SMS, voice call, web engagement, CRM event, conversion — against one
identity, embeds it into a per-customer semantic store, and lets you ask grounded
questions about it in natural language, over HTTP or MCP.

## The 60-second mental model

1. A visitor becomes a **passport** — one *person*, holding as many identities
   (emails, phones, logins, fingerprints) as they've been seen by. A strong
   identity appearing on a second passport merges the two.
2. A **session** is a time-boxed visit (with UTMs/referrer) attached to a passport —
   closed by 30 minutes of inactivity or by a change of campaign.
3. Every touch is recorded into **awareness**: a row with a `channel`, a
   `direction` (did we reach them, or did they act?), and `text`. The text is
   chunked and embedded so it's semantically searchable. Structured state lives
   beside it in **facts** (valid-time, append-only).
4. **Everything else is a plugin.** Channels write to the memory — mail, SMS,
   voip, engagement, crm, conversions, geolocation, shortener. Surfaces read it
   and act — analytics, audiences, campaigns, journeys, people, oauth. Each owns
   its endpoints; none import each other.
5. You **query** the memory through the core **QUERY** surface — REST `POST /query`,
   `/preview`, `/ask`, `/funnel` and MCP `whitebox.query`, `whitebox.preview`,
   `whitebox.funnel` (a selector engine over both memories) — with the analytics
   plugin (`/analytics/ask`, `recall`, `timeline`) as a higher-level convenience.
   Either way an LLM/agent reads and acts directly over **MCP**.

Your app stays separate and reaches in over HTTP or MCP — it never imports
WhiteBox internals.

## Read in order

1. **[01 · Overview](01-overview.md)** — what WhiteBox is, where it fits, and the
   shape of the system.
2. **[02 · Concepts](02-concepts.md)** — passports & identity merging, sessions,
   the two memories (awareness + facts), the `direction` vocabulary, the selector,
   channels, the context registry.
3. **[03 · Getting started](03-getting-started.md)** — prerequisites, install,
   `.env`, the config file, first run, first requests end-to-end.
4. **[04 · Configuration](04-configuration.md)** — the config factory, every
   top-level key, the plugin pattern, and the full `WB_*` environment reference.
5. **[05 · Awareness & querying](05-awareness-and-querying.md)** — reading the two
   memories: the core QUERY surface (the selector, `/query` · `/preview` · `/ask` ·
   `/funnel`), plus the `/analytics/*` conveniences (`recall`, `population`,
   `timeline`, `ask`).
6. **[06 · MCP](06-mcp.md)** — the `/mcp` endpoint, auth (static token or Auth0),
   connecting a client, and the full tool catalog across plugins.
7. **[07 · Channels](07-channels.md)** — per-channel usage: mail, sms, engagement,
   crm, voip, conversions, geolocation, shortener.
8. **[08 · Integrations](08-integrations.md)** — the provider model, the sibling
   integrations repo, the link script, and swapping or adding a provider.
9. **[09 · Deployment](09-deployment.md)** — production setup, webhooks, scaling,
   migrations, and data/GDPR operations.

### The query language, in full

[**query-language.md**](../server/docs/query-language.md) is the complete reference for
what you can write: every operator, aggregate, bucket, window key and response shape, the
words that mean several things (`last` means four, depending on where it sits), and a table
of the mistakes the language invites paired with what to write instead. Chapter 05 is the
tour; this is the reference.

Over MCP, `analytics_grammar` returns the same thing **generated from the engine's own
constants**, so it cannot describe a language the engine does not accept — and
`analytics_schema` is its companion, returning the vocabulary (which fact keys exist here,
which event actions, which channels) rather than the syntax.

### When behaviour changes

[**CHANGELOG.md**](../CHANGELOG.md) records the notable and especially the **breaking**
changes, newest first — what moved, why, and what a caller written against the old
behaviour gets. Worth reading before pinning an API contract or debugging a number that
changed: the response envelope, the booking data moving from facts to event attributes, and
the window-anchor default are all in there.

The two contracts a plugin implements so that generic surfaces can render it
without knowing anything about it — read these before adding a plugin, or before
adding per-plugin knowledge to something that shouldn't have any:

10. **[10 · The `status()` contract](10-plugin-status.md)** — how a plugin reports
    its own health counters, and how monitoring discovers them generically.
11. **[11 · The `events` manifest](11-plugin-events.md)** — how a plugin declares
    what its events mean (direction, channel), and why that can't live in the
    plugin doing the reading.

The **surface** plugins each document themselves in their own package, because
each is a product area rather than a transport:
[audiences](../server-plugin-audiences/docs/) ·
[campaigns](../server-plugin-campaigns/README.md) ·
[journeys](../server-plugin-journeys/README.md) ·
[people](../server-plugin-people/README.md) ·
[oauth](../server-plugin-oauth/README.md) ·
[analytics](../server-plugin-analytics/README.md). The operator UI over them is
[`ui/`](../ui/README.md).

## Conventions used here

- `WhiteBox` is the product; `whitebox-pro-*` are the npm package / repo / folder
  names (the bare `whitebox` npm name was taken).
- All credentials come from the **environment** (`WB_*`); the config file holds no
  secrets.
- Endpoints are written `METHOD /path`. "Bearer" means
  `Authorization: Bearer <token>` with the plugin's token.
