<p align="center">
  <img src="whitebox.svg" alt="Whitebox" width="280">
</p>

<p align="center">
  A unified backend for customer-facing communication channels, with a per-passport
  semantic memory you can query in natural language.
</p>

---

Whitebox records every customer touch — email, voice call, web engagement, CRM event — against a single **passport** identity, embeds the content into a per-customer **awareness** store, and answers grounded natural-language questions about it (`/analytics/ask`). It's also reachable over **MCP**, so an LLM client can drive it directly.

This is a monorepo (npm workspaces). Each package publishes independently; channels are plugins that register against the core via a shared `ctx`.

## Packages

### Server (Node.js · Express · BullMQ · Postgres + pgvector)

| package | what it does |
|---|---|
| [`whitebox-server`](whitebox-server) | Core: HTTP server, awareness, passports, sessions, MCP, plugin loader |
| [`whitebox-server-plugin-mail`](whitebox-server-plugin-mail) | Outbound (transactional + bulk), inbound (form + Mailgun), tracking, suppressions |
| [`whitebox-server-plugin-voip`](whitebox-server-plugin-voip) | Asterisk ARI observer, recording, Whisper transcription, trackable-number pool |
| [`whitebox-server-plugin-crm`](whitebox-server-plugin-crm) | Webhook ingestion of records + facts from external systems |
| [`whitebox-server-plugin-engagement`](whitebox-server-plugin-engagement) | Text / image / video engagement fed into awareness |
| [`whitebox-server-plugin-analytics`](whitebox-server-plugin-analytics) | Recall, population, timeline, grounded `ask`, context inspection |

### Client (browser SDK · tsup · vitest)

| package | what it does |
|---|---|
| [`whitebox-client`](whitebox-client) | Core: transport, identity, consent, event emitter, plugin host |
| [`whitebox-client-plugin-mail`](whitebox-client-plugin-mail) | Contact-form submission |
| [`whitebox-client-plugin-voip`](whitebox-client-plugin-voip) | Trackable phone-number swap-in |
| [`whitebox-client-plugin-engagement`](whitebox-client-plugin-engagement) | Reading / viewing / watching trackers |
| [`whitebox-client-plugin-conversions`](whitebox-client-plugin-conversions) | Conversion events |

## Develop

```bash
npm install          # one install wires every workspace (no npm link)
npm test             # run all package suites
npm test --workspace=whitebox-server-plugin-mail   # one package
```

Tests spin up a throwaway Neon branch per run — copy `.env.test.example` to `.env.test` and fill in your Neon credentials. Server runtime config lives in `whitebox-server/whitebox.config.js` (copy from `whitebox.config.example.js`). Both are gitignored — never commit real secrets.

## Architecture in one breath

- **Passport** = one customer's identity, merged across strong identities (email, phone, fingerprint, user).
- **Awareness** = content-addressable semantic memory; identical content embeds once (`content_hash`) and is shared across passports at query time.
- **Plugins** never import each other — they communicate through the core `ctx` (event bus, context registry, MCP registry). Adding a channel is a new package, not a core change.

## License

UNLICENSED — © Almero Digital Marketing.
