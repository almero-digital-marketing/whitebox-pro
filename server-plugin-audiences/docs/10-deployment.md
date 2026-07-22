# 10 · Deployment

## 1. Install + enable

In this monorepo the package is workspace-linked. Add it to your config's `plugins`:

```js
// whitebox.config.js
plugins: ['engagement', 'analytics', 'audiences']
```

On boot the host calls `plugin.migrate(db)` (creates/updates the `whitebox_audience_*` tables) then
`plugin.register(app, ctx)`.

## 2. Config

Merge [`whitebox.config.example.js`](../whitebox.config.example.js). Key blocks:

```js
mcp:   { path: '/mcp', auth: { secret: process.env.WB_MCP_TOKEN } },   // gates the MCP tools
audiences: {
  auth: { secret: process.env.WB_AUDIENCES_TOKEN },                    // gates REST /audiences/*
  networks: { meta:{…}, tiktok:{…}, google:{…} },                      // composed adapter factories
  privacy:  { requireConsentCategory: 'marketing' },                   // see 08 · Consent & privacy
}
```

There's no plugin-owned evaluation-cost config anymore (no `candidateLimit` / `candidateSimilarity` /
`debounceMs` / `keepWarmDays`) — selection-cost knobs live in the core selector engine's own config, not
here (see [04 · Evaluator](04-evaluator.md)).

## 3. Environment variables

All secrets come from `process.env` (keep them out of the repo — a gitignored `.env`).

| var | purpose |
|---|---|
| `WB_MCP_TOKEN` | bearer for `/mcp` (the MCP tools) |
| `WB_AUDIENCES_TOKEN` | bearer for the REST management API |
| `WB_META_PIXEL_ID`, `WB_META_CAPI_TOKEN` | Meta CAPI |
| `WB_TIKTOK_PIXEL_CODE`, `WB_TIKTOK_EVENTS_TOKEN` | TikTok Events API |
| `WB_GA4_MEASUREMENT_ID`, `WB_GA4_API_SECRET` | GA4 Measurement Protocol |

A network is only **eligible** when its vars are set — check `GET /audiences/networks`. When a network
isn't eligible, `setDelivery` dry-runs automatically rather than failing.

## 4. Infrastructure dependencies

Provided by the WhiteBox host via `ctx` — you don't configure them here, but they must be running:

- **Postgres + pgvector** — awareness embeddings (the selector engine's semantic stage) and this
  plugin's own tables (`whitebox_audience_segments`, `whitebox_audiences`, `whitebox_audience_suppression`,
  `whitebox_audience_identities`).
- **OpenAI (or your AI SDK provider)** — the selector engine's judge, and this plugin's segment/audience
  naming (`ai.object`).

This plugin has **no background processing of its own** — no queue, no worker, no scheduler. (An
earlier `Rule` entity had a BullMQ dirty-eval worker and a daily keep-warm scheduler sweep; both were
dropped along with that entity — see [01 · Architecture](01-architecture.md).) Segments and audiences
resolve live on every read; delivery is an explicit sync you trigger via REST/MCP (see
[02 · Concepts](02-concepts.md)). If you want a recurring re-sync (to refresh a platform's recency
window), schedule a call to `setDelivery` / `POST /audiences/:id/delivery` yourself — it isn't built in.

## 5. Per-audience platform step (manual, once)

For each audience you deliver, create the Custom Audience on each network keyed on its `activation_id`
event, with a lookback window generous enough to cover your re-sync cadence. See
[05 · Networks](05-networks.md) and the per-network docs.

## 6. Client capture shim

Scaffold `whitebox-pro-client-plugin-ads-capture` separately (see [06 · Identity](06-identity.md)) and
add it to the browser SDK's `plugins`. It reads the manifest and posts collected ad signals to
`POST /audiences/identity` (you wire this route — see [09 · API](09-api.md)). Without it, server
CAPI/Events have weaker match rates and GA4 has no `client_id`.

## 7. Production checklist

- [ ] `WB_AUDIENCES_TOKEN` and `WB_MCP_TOKEN` set (no open management surface).
- [ ] Consent wired (`passports.hasConsent`) and `requireConsentCategory` set if you need the gate —
  see [08](08-consent-privacy.md).
- [ ] Decide whether you need a sensitive-category guard for AI-inferred segments — there isn't one
  built in today.
- [ ] Per-network audiences created with the right lookback window.
- [ ] A re-sync cadence chosen and scheduled — delivery doesn't refresh itself.

## 8. Verify end-to-end

```bash
# networks eligible?
curl -s localhost:3000/audiences/networks -H "authorization: Bearer $WB_AUDIENCES_TOKEN"
# what CRM facts do we have?
curl -s localhost:3000/audiences/facts -H "authorization: Bearer $WB_AUDIENCES_TOKEN"
# preview an unsaved segment, without persisting anything
curl -s -X POST localhost:3000/audiences/segments/preview -H "authorization: Bearer $WB_AUDIENCES_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"select": {"filter": {"fact": {"plan_tier": {"eq": "pro"}}}}}'
```

Then use Meta Test Events / GA4 DebugView to confirm events arrive **before** creating the audiences.
