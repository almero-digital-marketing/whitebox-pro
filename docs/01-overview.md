# 01 · Overview

## What WhiteBox is

WhiteBox is a **channel backend with memory**. It owns the customer touchpoints
your product creates — outbound email and SMS, inbound replies and form
submissions, voice calls, web reading/viewing behaviour, CRM records, ad
conversions — and it remembers all of them against a single identity per person.
That memory is embedded into a semantic store you can query in plain language.

It is deliberately **not** your whole backend. Your application logic lives
elsewhere and talks to WhiteBox over HTTP or MCP. WhiteBox never becomes a
dependency your app imports; it's a service with a defined surface.

## Where it fits

```
        your app / site / agent
                  │
        HTTP  ────┼──── MCP
                  │
        ┌─────────▼──────────┐
        │     WhiteBox       │
        │                    │
        │  passports         │  one identity per person
        │  sessions          │  time-boxed visits
        │  awareness  ◄───────  every touch, embedded + searchable
        │                    │
        │  channel plugins:  │
        │   mail  sms  voip  │  ─► send / receive, write to awareness
        │   engagement  crm  │
        │   conversions      │
        │   audiences        │  ─► fan out to ad platforms
        │   shortener        │
        └─────────┬──────────┘
                  │
        Postgres + pgvector  ·  Redis (BullMQ)  ·  OpenAI (embeddings + LLM)
```

## The four ideas

1. **One identity across channels.** Email, phone, browser fingerprint and login
   all link to a single **passport**. When a strong identity (e.g. a phone number)
   shows up on two passports, they **merge** — so a call, a click and an email
   reply belong to the same person automatically. See
   [Concepts](02-concepts.md#passports--identity).

2. **Memory you can query.** Every touch becomes an **awareness** record. The text
   is chunked and embedded (OpenAI), and identical content is embedded once and
   shared across customers at query time. You ask questions like *"has this
   customer seen our refund policy?"* and get an answer grounded in what actually
   happened, with citations. See [Awareness & querying](05-awareness-and-querying.md).

3. **LLM-native.** The same data and actions are exposed over **MCP**, so an agent
   can read a customer's timeline, recall context, send a message, or build an
   audience — through WhiteBox's tools, with auth. See [MCP](06-mcp.md).

4. **Channels are plugins.** Each channel is its own npm package that registers
   against the core context (`ctx`). Plugins never import each other; adding a
   channel is a new package, not a core change. Providers (Mailgun, Twilio, Meta…)
   are composed into a channel the same way. See
   [Channels](07-channels.md) and [Integrations](08-integrations.md).

## What's in the box

| Layer | Package | Role |
|---|---|---|
| Core | `whitebox-pro-server` | HTTP server, passports, sessions, awareness, MCP, plugin loader |
| Channels | `whitebox-pro-server-plugin-*` | mail, sms, voip, engagement, crm, conversions, audiences, shortener, analytics |
| Browser SDK | `whitebox-pro-client` + `whitebox-pro-client-plugin-*` | identity, consent, engagement/voip/mail/conversions trackers |
| Providers | `whitebox-pro-mail-*`, `whitebox-pro-sms-*`, `whitebox-pro-adnetworks-*`, `whitebox-pro-auth-auth0` | transport adapters, in their own repos |

## Runtime dependencies

- **PostgreSQL** with the **pgvector** extension (semantic store).
- **Redis** (BullMQ — background workers for sending, embedding, transcription).
- **OpenAI API key** (embeddings + the LLM behind `ask`, plus Whisper/Vision where
  voip/engagement use them).

Next: **[02 · Concepts](02-concepts.md)**.
