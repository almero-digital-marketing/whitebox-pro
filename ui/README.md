# whitebox-pro-ui — the operator console

A VS Code-style activity bar over the **surface plugins**. Seven modules, all
sharing one three-pane grammar: **left** a searchable, paged rail · **centre**
the thing you're looking at · **right** what you can do to it.

| module | over | needs |
|---|---|---|
| **Live** | `live` | `live:read` |
| **Analytics** | `analytics` | `analytics:read` / `analytics:write` |
| **Audiences** | `audiences` | `audiences:read` / `audiences:write` |
| **Campaigns** | `campaigns` | `campaigns:read` / `campaigns:write` |
| **Journeys** | `journeys` | `journeys:read` / `journeys:write` |
| **People** | `people` | `people:read` / `people:write` (+ `people:erase`) |
| **Users** | `oauth` | `users:manage` |

A module's icon only appears when the logged-in user holds one of its
permissions — which also means it disappears when the plugin isn't registered at
all, since the permission catalog is aggregated from *registered* plugins. One
gate covers both cases.

## Run

It is **not** an npm workspace (the root `workspaces` globs don't match `ui/`),
so it installs on its own.

```bash
# 1) the API, from the repo root
cd server && node --env-file-if-exists=.env scripts/serve-analytics.mjs   # :3000
```

```bash
# 2) this SPA — no env file, nothing to register
cd ui && npm install && npm run dev                                       # :5174
```

Vite proxies `/api` → the server (stripping the prefix) and `/socket.io` with
websockets, so the SPA is same-origin and live updates flow through. Point it at
a server on another port with `WB_API_PROXY=http://localhost:3100 npm run dev`.

### No env vars

There used to be one, `VITE_OAUTH_CLIENT_ID`, and getting rid of it fixed a real
bug. The client_id is now the fixed constant **`whitebox-console`**, which the
oauth plugin registers for `${WB_APP_URL}/callback` on every boot. Nothing to
create, nothing to paste.

That matters because Vite loads `.env.local` in **every** mode including
production, so a build-time client_id meant whoever built the tarball baked their
own database's id into it — which is exactly what shipped in `0.4.0`, breaking
every install with "Unknown client_id". `scripts/check-build.mjs` now fails the
publish if anything install-specific reaches `dist/`.

**The dev server's port must match the server's `WB_APP_URL`.** The console's
redirect_uri is `${location.origin}/callback` and OAuth matches it exactly, so
`:5174` here means `WB_APP_URL=http://localhost:5174` there. `strictPort` is on
so a busy port fails loudly instead of sliding to `:5175` and failing later at
`/authorize`, a long way from the cause.

`VITE_WB_API_BASE` exists as a build-time override for serving the console from a
different origin than the API. Leave it unset — the server serves both.

There is no static API token. Every module calls its plugin with the **logged-in
user's own session token**, and each plugin independently requires its own
scopes — which the server computes from that user's real grants at login rather
than trusting anything the client sends.

## Conventions

Three that are load-bearing, and worth reading before adding a module:

- **Save/discard** — [ADR 0001](docs/adr/0001-editor-save-discard-pattern.md).
  Every editor follows one fixed interaction: Discard + Save always rendered and
  *disabled* rather than hidden when clean, a fading "Unsaved changes" note,
  Discard reverting to the last-saved state. Don't invent a second one.
- **The rail is a component** — [`components/RailPane.vue`](src/components/RailPane.vue).
  Search at the top with the module's add button *inside* it, the list, then a
  foot with the match count and pager. Two paging modes: pass `items` and it
  pages them client-side, or pass `total` + `page` and handle `update:page` for a
  real server query. [`useRailPage.ts`](src/components/useRailPage.ts) owns the
  server-side half — debounce, reset-on-new-term, step-back-past-the-end.
- **Success is shown, not toasted.** The app confirms an action by rendering its
  result; only `notifyError` exists. A receipt line (what actually changed) beats
  a toast that says "Saved".

## Stack

Vue 3 + Vite · PrimeVue (styled mode) + PrimeIcons · Pinia · Vue Router ·
ECharts (`vue-echarts`) · Vue Flow (the journey canvas) · TinyMCE + CodeMirror
(campaign content) · socket.io-client (live report updates).

> **PrimeVue injects its theme CSS at runtime**, after the bundled stylesheets
> and at equal specificity. App CSS that has to win therefore doubles its class
> name — `.p-paginator.p-paginator { … }`. Applying that to only some of a
> block's selectors is worse than not at all, because the ones you missed lose.

## Demo data

The server's seed populates enough to exercise every module:

```bash
cd server && npm run seed:analytics
```
