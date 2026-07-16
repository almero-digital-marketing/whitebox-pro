# 08 · Integrations

A **channel** owns plumbing (queue, retries, awareness, webhooks routing); a
**provider** owns the outside-world specifics (transport, signature verification,
payload shapes). Providers are composed into a channel the same way plugins are
composed into the server — by calling a factory and passing the result in.

```js
mail({ provider: mailgun({ … }) })                 // one provider
sms({ provider: twilio({ … }), routes: { '+359': mobica({ … }) } })  // routed providers
conversions({ networks: [ meta({ … }), tiktok({ … }) ] })            // a set of networks
mcp: { auth: auth0({ … }) }                        // an auth verifier
```

## Where providers live

Providers are **not** in this monorepo. Each is its own git repo, in a sibling
folder outside the tree:

```
~/Projects/whitebox/
  ├── whitebox-pro/                 ← this monorepo
  └── whitebox-pro-integrations/    ← provider repos, one per package
        whitebox-pro-mail-mailgun/        whitebox-pro-mail-postmark/
        whitebox-pro-sms-twilio/          whitebox-pro-sms-mobica/
        whitebox-pro-adnetworks-meta/     whitebox-pro-adnetworks-google/
        whitebox-pro-adnetworks-tiktok/   whitebox-pro-auth-auth0/
```

Why outside the tree: the monorepo can be shared/public while individual provider
repos stay independent (and some deployments add private, client-specific
providers that must never appear in the monorepo's files). Keeping them external
means the core stays provider-agnostic and nothing about a private adapter leaks
into tracked files.

## Linking them in

`scripts/link-integrations.sh` (run via `npm run link:integrations`, also a
`postinstall` hook) symlinks each present provider repo into the monorepo's
`node_modules` under its package name, so `import { mailgun } from
'whitebox-pro-mail-mailgun'` resolves.

```bash
# default: looks in ../whitebox-pro-integrations
npm run link:integrations
# or point elsewhere:
WB_INTEGRATIONS_DIR=/path/to/integrations npm run link:integrations
```

It's idempotent and a no-op when the folder is absent — a clone with **no**
providers still builds and tests; you only need a provider present when your config
imports it. Ad-network packages additionally get the in-monorepo
`whitebox-pro-adnetworks` kernel symlinked in (their only unpublished dependency).

## The providers that ship today

| channel | providers | notes |
|---|---|---|
| mail | `whitebox-pro-mail-mailgun`, `whitebox-pro-mail-postmark` | send + transport, inbound/tracking webhook parsing + signature verification, native batch |
| sms | `whitebox-pro-sms-twilio`, `whitebox-pro-sms-mobica` | send + DLR/inbound parsing + signature verification; routed per destination prefix |
| conversions / audiences | `whitebox-pro-adnetworks-meta`, `-google`, `-tiktok` | server CAPI/MP/Events fan-out (`.`) + browser pixel (`/client`), deduped by `event_id` |
| MCP auth | `whitebox-pro-auth-auth0` | OAuth resource-server verifier + RFC 9728 discovery |

Each provider repo has its own README with credential setup and webhook wiring.

> A self-hosted alternative to Auth0 also exists — `whitebox-pro-server-plugin-oauth`
> ships **in this monorepo** (not as an external provider; it's first-party
> WhiteBox functionality, the same class of thing as `server-plugin-audiences`),
> and is verified with the *same* `jwt({ issuer, audience, scope })` verifier
> `whitebox-pro-auth-auth0` exports above, since that verifier already accepts
> any OIDC-compliant issuer. See [06 · MCP](06-mcp.md#authentication).

## The provider contracts (for writing your own)

Adding a provider means implementing a small contract and publishing it as a
package — no change to the core or the channel plugin.

**Mail provider** — `send`, `sendBatch` + `maxBatchSize`, `verifySignature(req,
kind)`, `parseInbound`, `parseTracking`, `classifyError`.

**SMS provider** — `send`, `verifySignature(req, kind)`, `parseInbound` (omit for
send-only gateways), `parseStatus`, `classifyError`.

**Ad network** — a factory returning `{ name, signals, eligible, transport,
acceptedKeys, sendEvent(canonical, ids) }`; a `/client` entry for the browser pixel
and a `/spec` entry for the canonical→network event map. The shared kernel
`whitebox-pro-adnetworks` provides schemas, hashing and browser helpers.

**MCP auth** — a verifier returning `{ middleware, authorizationServers?, resource?,
scopesSupported? }`; if it advertises `authorizationServers`, the core serves the
RFC 9728 discovery document automatically.

A provider is "eligible" only when its credentials are present, so an unconfigured
network simply doesn't fire — you can wire several and let env decide which run.

## Renaming / repos

Package, folder and repo names share the `whitebox-pro-*` namespace (the bare
`whitebox` npm name was taken; the **WhiteBox** brand is unchanged). The provider
repos are renamed in lockstep with the monorepo.

Next: **[09 · Deployment](09-deployment.md)**.
