# 06 · MCP

WhiteBox exposes its data and actions over the **Model Context Protocol** so an LLM
or agent (Claude, a custom agent, an IDE) can read customer memory and act through
WhiteBox's tools — with the same auth and rules as the HTTP API.

## The endpoint

One endpoint, mounted by the core after all plugins have registered their tools:

```
POST /mcp        (also GET, DELETE — streamable HTTP, stateless)
```

Configured under the top-level `mcp` key:

```js
mcp: {
  path: '/mcp',
  auth: process.env.WB_MCP_TOKEN,   // static bearer token (string), or a composed verifier
}
```

## Authentication

`mcp.auth` is a **pluggable verifier**. Four options:

1. **Static bearer token** — set `auth` to a string (or `{ secret }`). Clients send
   `Authorization: Bearer <token>`. Simplest; good for server-to-server.
2. **Auth0 (OAuth)** — compose the `whitebox-pro-auth-auth0` verifier so MCP clients
   can log in themselves:
   ```js
   import { auth0 } from 'whitebox-pro-auth-auth0'
   mcp: {
     path: '/mcp',
     auth: auth0({ domain: process.env.AUTH0_DOMAIN,
                   audience: 'https://whitebox/mcp', scope: 'mcp:use' }),
   }
   ```
   This also serves `GET /.well-known/oauth-protected-resource` (RFC 9728) so a
   client can discover the authorization server and run the OAuth flow without
   pre-shared secrets.
3. **Built-in (OAuth, self-hosted)** — `whitebox-pro-server-plugin-oauth` is a
   complete OAuth 2.1 authorization server (authorization + token endpoints, JWKS,
   RFC 8414 discovery) that ships *in this monorepo* — a first-party plugin, not
   an external provider, so no external identity provider account is needed.
   Register it as a plugin, then verify with the same generic `jwt()` verifier the
   Auth0 package exports (any OIDC-compliant issuer works with it):
   ```js
   import { oauth } from 'whitebox-pro-server-plugin-oauth'
   import { jwt } from 'whitebox-pro-auth-auth0'

   const ISSUER = 'https://your-host/oauth'
   const AUDIENCE = 'https://whitebox/api'

   plugins: [
     oauth({ issuer: ISSUER, audience: AUDIENCE }),
     // …
   ],
   mcp: {
     path: '/mcp',
     auth: jwt({ issuer: ISSUER, audience: AUDIENCE, scope: 'mcp:use' }),
   }
   ```
   `basePath` (where `/authorize`, `/token`, `/.well-known/*` mount) is *derived*
   from `issuer`'s own path, so the two can never drift apart. Bootstrap the first
   user and register each OAuth client (an admin-only, one-off step — no Dynamic
   Client Registration) with the package's CLI scripts:
   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/create-admin.mjs
   node scripts/create-client.mjs --name="Claude Desktop" --redirect-uri="http://localhost:PORT/callback"
   ```
   Clients are public (PKCE/S256, no `client_secret`) — the right shape for MCP
   and browser-based apps, which can't hold a secret safely.
4. **None** — omit `auth` (development only).

Any OAuth resource-server verifier can be dropped in the same way; Auth0 is an
external-provider example, the built-in server a first-party one. See
[Integrations](08-integrations.md).

### Two layers: `mcp:use`, then per-tool scopes

`mcp:use` above gates only **whether a client may speak MCP at all**. Which
capabilities it can then invoke is a separate check: `tool()` and `resource()` take
their own `scope`, verified against the same token's `scope` claim. So
`server-plugin-people` registers its erase tool under `people:erase`, and an agent
that reached the endpoint still cannot erase anyone unless the token carries it.

An agent's reach is therefore the **intersection of the human's own permissions**
with what MCP exposes — not a second, parallel authorization system to keep in sync.
A tool registered with no `scope` is `mcp:use`-only.

`mcp:use` must be **granted**, not merely configured. Core declares it into the
permission catalog (`PERMISSIONS` in `server/src/mcp.js`, folded in by the loader
alongside each plugin's), which is what makes it appear in the console's user editor
and what the `'*'` bootstrap admin expands into. Gate the endpoint on a scope that
isn't in the catalog and every caller gets a 403 that looks like a broken
deployment — there would be no way to hand the scope to anyone.

With the built-in server, grant it per user in the console (**Users → permissions**);
the bootstrap admin created by `create-admin.mjs` holds `'*'` and so already has it.
With Auth0 or another external issuer, `mcp:use` has to be in the scopes that issuer
puts in the token — the catalog governs WhiteBox's own server, not a third party's.

## Connecting a client

- **With a static token:** point your MCP client at `https://your-host/mcp` and
  configure the bearer token.
- **With Auth0 or the built-in server:** point the client at `https://your-host/mcp`;
  on a `401` it reads the `/.well-known/oauth-protected-resource` metadata, runs
  the OAuth flow against whichever authorization server is configured, and
  retries with the issued token. The flow itself is identical either way — only
  where the login page lives (Auth0's hosted page vs. WhiteBox's own) differs.

The server advertises its tool/resource/prompt catalog on connect.

## Tool catalog

The **core QUERY** tools are always present (core exposes the selector engine
directly); everything else is contributed by the plugins you enable. Naming: the
core query and analytics tools are the headline `whitebox.*` set; each channel
namespaces its own.

### Core QUERY — the selector (from core)

The core query surface over both memories (semantic **awareness** + structured
**facts**), exposed as MCP tools that mirror the REST endpoints in
[05 · Querying](05-awareness-and-querying.md#core-query--the-selector):

| tool | purpose |
|---|---|
| `whitebox.query` | resolve a selector `{ about, filter, judge }` into a projection — `knowledge` (ranked evidence) or `people` (a cohort `{ count, passports }`); `asOf` time-travels, `group: { by }` returns a `[{ bucket, value }]` series for charts |
| `whitebox.preview` | cost-gate a `people` selector *before* running/saving — about-cohort size, filter survivors (= the judge-call count), full-scan flag, and a sampled judge rate when a judge is present |
| `whitebox.funnel` | resolve ordered, windowed steps → a drop-off report plus per-step (`step:N`) and gap (`gap:N→M`, `pending`/`dropped`) cohorts |

> **No MCP `ask` by design.** Answering is *generation*, and an MCP client is
> already an LLM agent — so it queries `whitebox.query` for `knowledge` and
> synthesizes the answer in its own context. The natural-language `/ask` layer is
> REST-only (for non-agent callers like a dashboard); see
> [05 · ask](05-awareness-and-querying.md#ask--a-natural-language-answer-rest-only).
> For a `people` query, run `whitebox.preview` first to see the judge cost.

### Analytics — read & reason (from `analytics`)

The higher-level, awareness-focused conveniences (callers of the core engine):

| tool | purpose |
|---|---|
| `whitebox.ask` | grounded answer about one customer |
| `whitebox.ask_population` | grounded answer about the whole base / a cohort |
| `whitebox.recall` | semantic search of a passport's memory (ranked chunks) |
| `whitebox.population` | count distinct customers matching a query |
| `whitebox.timeline` | flat chronological exposures for a passport |
| `whitebox.context` | inspect structured context providers for a passport |
| `whitebox.forget` | GDPR-delete a passport's awareness |

### Channels — act

Channel plugins namespace with a **dot**:

| plugin | tools |
|---|---|
| mail | `mail.send` · `mail.outbox_get` · `mail.inbox_list` · `mail.inbox_get` · `mail.suppress` · `mail.unsuppress` |
| sms | `sms.send` · `sms.outbox_get` · `sms.inbox_list` · `sms.suppress` · `sms.unsuppress` |
| crm | `crm.upsert_record` · `crm.add_fact` · `crm.get_state` |
| engagement | `engagement.list_content` · `engagement.get_content` · `engagement.invalidate_content` |
| conversions | `conversions.list_events` |
| shortener | `shortener.create_link` · `shortener.list_links` · `shortener.link_stats` |
| voip | `voip.list_calls` · `voip.get_call` · `voip.get_transcript` |

### Surfaces — target, send, automate, look someone up

The surface plugins namespace with an **underscore** (`audiences_…`, not
`audiences.…`). The inconsistency with the channel tools above is historical, not
meaningful — match whichever the plugin actually registers.

**audiences** — segments (a saved query) and audiences (a boolean composition of
segments), plus hand-built static lists and suppression:

| group | tools |
|---|---|
| segments | `audiences_list_segments` · `audiences_get_segment` · `audiences_create_segment` · `audiences_preview_segment` · `audiences_rename_segment` · `audiences_name_segment` · `audiences_delete_segment` · `audiences_segment_members` |
| audiences | `audiences_list_audiences` · `audiences_get_audience` · `audiences_create_audience` · `audiences_preview_audience` · `audiences_name_audience` · `audiences_delete_audience` · `audiences_audience_members` · `audiences_passport_audiences` |
| static lists | `audiences_lists` · `audiences_create_list` · `audiences_add_to_list` · `audiences_remove_from_list` |
| delivery & networks | `audiences_set_delivery` · `audiences_set_client_side` · `audiences_set_campaigns` · `audiences_delivery_preview` · `audiences_network_status` |
| suppression & facts | `audiences_suppress` · `audiences_unsuppress` · `audiences_list_suppression` · `audiences_list_facts` |

**campaigns** — one send to one or more audiences:

`campaigns_list` · `campaigns_get` · `campaigns_create` · `campaigns_update` ·
`campaigns_delete` · `campaigns_attach_audience` · `campaigns_detach_audience` ·
`campaigns_delivery_preview` · `campaigns_schedule` · `campaigns_send_manual` ·
`campaigns_unlock` · `campaigns_set_report` · `campaigns_activate_for_passport`

**journeys** — multi-step automation and its enrollments:

`journeys_list` · `journeys_get` · `journeys_create` · `journeys_update` ·
`journeys_delete` · `journeys_activate` · `journeys_pause` · `journeys_enroll` ·
`journeys_list_enrollments` · `journeys_enrollment_status` · `journeys_exit_enrollment`

**people** — one customer, in full:

`people_search` · `people_get` · `people_activity` · `people_link_identity` ·
`people_unlink_identity` · `people_record_fact` · `people_merge` · `people_erase`

> `people_erase` is gated on its own `people:erase` permission, separate from
> `people:write` — deleting someone forever is a different authority from
> correcting their email. See [04 · Configuration](04-configuration.md).

Several plugins also expose read-only **resources** (e.g. recent conversion events,
recent voip calls) for browsing.

## A typical agent flow

1. `whitebox.query` (`knowledge`) — or `whitebox.recall` / `whitebox.timeline` — to
   understand a customer, then synthesize a summary in your own context.
2. `whitebox.query` (`people`, after `whitebox.preview`) to build a cohort over both
   memories, or `whitebox.funnel` for a windowed drop-off.
3. `mail.send` or `sms.send` to follow up — or `audiences_preview_segment` →
   `audiences_create_segment` → `audiences_create_audience` to build a cohort you
   can send to, then `campaigns_create` → `campaigns_attach_audience` →
   `campaigns_send_manual`.
4. `people_search` → `people_get` when the question is about one named customer
   rather than a cohort.

Because tools share the same identity, auth, and awareness as the HTTP API, an
agent acting over MCP is indistinguishable from your app acting over HTTP — every
action it takes is itself recorded.

Next: **[07 · Channels](07-channels.md)**.
