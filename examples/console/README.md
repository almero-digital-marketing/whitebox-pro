# Console

Ask grounded questions about a customer and inspect their memory — **with no external Claude/OpenAI client**. Every call hits the server's own `/analytics/*` routes; the server does the LLM synthesis. It's the "now query it" companion to the [integration demo](../integration).

## Run

```bash
cd examples/console
node serve.mjs            # starts/reuses whitebox-server, serves on :5173
```

`serve.mjs` reuses a running whitebox-server (or starts one), proxies `/analytics/*` same-origin, and hands the page the analytics token from `whitebox-server/.env` so you don't have to paste it (local-only; the field stays editable).

## Use it

1. Open the integration demo, generate some activity for a visitor, and copy its **passport id** from the header.
2. Paste that id into the console's **passport** field (the **token** auto-fills from `.env`).
3. Click a **predefined question** chip — or type your own — and read the grounded answer. Expand **evidence** to see the cited chunks.
4. **Inspect** the raw memory: `Timeline` (all exposures), `Context` (current CRM state), `Recall` (semantic search), `Population` (cohort by concept).

Predefined questions include:
- *What do we know about this customer, and what have they done?*
- *Summarize their journey across mail, web, voip and CRM.*
- *Have they shown buying intent? What signals?*
- *Did they contact sales or request a callback?*

## What it is (and isn't)

This is an **ask + inspect console**, not a tool-calling agent — each question is one grounded `/analytics/ask` call (recall + registered context → the server's LLM), plus direct inspection of the retrieval primitives. A true agentic loop (chaining tools across passports) would be a server-side endpoint over the same `awareness.*` functions — a natural next step.

## Notes
- **Dev tool, not a prod surface.** It queries a customer's full memory, so it's gated by the analytics bearer token. Don't expose it publicly.
- It rides the server's AI (the `ai` facade), so answers are only as available as that provider key — same as `/analytics/ask`.
