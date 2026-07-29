# 01 · Overview

## What WhiteBox is

WhiteBox is a **channel backend with memory**. It owns the customer touchpoints
your product creates — outbound email and SMS, inbound replies and form
submissions, voice calls, web reading/viewing behaviour, CRM records, ad
conversions — and it remembers all of them against **one person**, however many
identities that person turns out to have. That memory is embedded into a
semantic store you can query in plain language.

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
        │  passports         │  one person, many identities
        │  sessions          │  time-boxed visits
        │  awareness  ◄───────  every touch, embedded + searchable
        │  facts             │  structured state, valid-time
        │                    │
        │  channel plugins:  │
        │   mail  sms  voip  │  ─► send / receive, write to awareness
        │   engagement  crm  │
        │   conversions      │
        │   geolocation      │
        │   shortener        │
        │                    │
        │  surface plugins:  │
        │   analytics        │  ─► ask / recall over the memory
        │   audiences        │  ─► fan out to ad platforms
        │   campaigns        │  ─► one send to an audience
        │   journeys         │  ─► multi-step automation
        │   people           │  ─► look one customer up
        │   oauth            │  ─► login for the console + MCP
        └─────────┬──────────┘
                  │
        Postgres + pgvector  ·  Redis (BullMQ)  ·  OpenAI (embeddings + LLM)
```

Channel plugins put touches *into* the memory; surface plugins read it and act.
Nothing enforces the split — it's the same `ctx` registration either way — but it
is the useful way to think about which plugin you reach for.

## The four ideas

1. **One person across channels.** A person is one **passport** holding *many*
   identities — every email, phone, browser fingerprint and login they've ever
   been seen by. The four strong types (`fingerprint`, `phone`, `email`, `user`)
   are globally unique, so when one of them shows up on a second passport the two
   **merge** — a call, a click and an email reply end up on the same person
   automatically. See [Concepts](02-concepts.md#passports--identity).

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
| Core | `whitebox-pro-server` | HTTP server, passports, sessions, awareness, facts, the query/selector engine, event registry, MCP, plugin loader |
| Channels | `whitebox-pro-server-plugin-*` | mail, sms, voip, engagement, crm, conversions, geolocation, shortener |
| Surfaces | `whitebox-pro-server-plugin-*` | analytics, audiences, campaigns, journeys, people, oauth |
| Admin console | `whitebox-pro-ui` | Vue 3 + PrimeVue SPA over the surface plugins (not an npm workspace — installed separately) |
| Browser SDK | `whitebox-pro-client` + `whitebox-pro-client-plugin-*` | identity, consent, engagement/voip/mail/conversions/crm/geolocation/shortener |
| Providers | `whitebox-pro-mail-*`, `whitebox-pro-sms-*`, `whitebox-pro-adnetworks-*`, `whitebox-pro-auth-auth0`, `whitebox-geolocation-maxmind` | transport adapters, in their own repos |

## Runtime dependencies

- **PostgreSQL** with the **pgvector** extension (semantic store).
- **Redis** (BullMQ — background workers for sending, embedding, transcription).
- **OpenAI API key** (embeddings + the LLM behind `ask`, plus Whisper/Vision where
  voip/engagement use them).

Next: **[02 · Concepts](02-concepts.md)**.
