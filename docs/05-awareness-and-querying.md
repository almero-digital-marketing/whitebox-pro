# 05 · Awareness & querying

Awareness is the point of WhiteBox: a per-customer memory you can read back in
plain language. This chapter is about **reading** it — the `analytics` plugin's
surface. (How records get *written* is covered per channel in
[07 · Channels](07-channels.md); the record shape is in
[Concepts](02-concepts.md#awareness).)

All endpoints below are mounted by `whitebox-pro-server-plugin-analytics` and
require `Authorization: Bearer $WB_ANALYTICS_TOKEN`. Every one has an MCP
equivalent — see [MCP](06-mcp.md).

## ask — grounded answer about one customer

The headline capability. Give a passport and a natural-language question; WhiteBox
recalls the most relevant awareness chunks, assembles registered context (CRM
facts, etc.), and has the LLM answer **grounded in that evidence**, with citations.

```
POST /analytics/ask
{ "passport_id": "…", "question": "Has this customer asked about pricing?", "limit": 20 }
→ { "answer": "…", "citations": [ { "text": "…", "channel": "mail", "ts": "…" } ] }
```

Use it for "what does this person care about / has been told / has done."

## ask-population — answer about the whole base (or a cohort)

The same idea across all customers. WhiteBox finds the content matching the
question, weights it by reach, and answers about the population.

```
POST /analytics/ask-population
{ "question": "What are customers most confused about in onboarding?" }
→ { "answer": "…", "citations": [ … ] }
```

## recall — semantic search for one customer

Lower-level than `ask`: returns the ranked awareness chunks themselves (no LLM), so
you can build your own UI or logic on top.

```
POST /analytics/recall
{ "passport_id": "…", "query": "refund policy", "limit": 10, "min_similarity": 0.2 }
→ { data: [ { chunk_text, similarity, channel, direction, source, ts, … } ], limit, offset, has_more }
```

Ranking blends vector similarity with engagement depth (a fully-read paragraph
outranks a skimmed heading).

## population — cohort sizing

"How many customers match this idea?" Returns distinct passport count plus the
matching passports and their hits.

```
POST /analytics/population
{ "query": "interested in enterprise SSO", "similarity": 0.75, "min_engagement": 0 }
→ { count: 137, passports: [ { passport_id, hits: [ … ] }, … ] }
```

This is the read-side of audience thinking; the [audiences](07-channels.md#audiences)
plugin turns the same matching into ad-platform events.

## timeline — raw chronology

A flat, newest-first list of a passport's exposures, no embedding work. Filter by
channel, direction, and date range.

```
GET /analytics/timeline/:passport_id?channels=mail,voip&directions=expression&from=2026-01-01
→ { data: [ … exposures with session context … ], limit, offset, has_more }
```

Good for an audit trail or a customer-history view.

## context — what the plugins know (debug)

Inspect the **structured** side: what every registered context provider currently
reports for a passport (CRM records, etc.), before the LLM step. Optionally filter
by provider.

```
GET /analytics/context/:passport_id?providers=crm
```

## forget — GDPR deletion

Irreversibly delete all awareness for a passport (and garbage-collect orphaned
chunks).

```
DELETE /analytics/passport/:passport_id
```

See [Deployment → data & GDPR](09-deployment.md#data--gdpr).

## Pagination

Collection endpoints return a consistent envelope:

```json
{ "data": [ … ], "limit": 50, "offset": 0, "has_more": true }
```

Pass `?limit=` and `?offset=` (each endpoint caps `limit`).

## How recall stays cheap and honest

- **Embed once, share everywhere.** Identical content (same `content_hash`) is
  embedded a single time and shared across every customer who saw it, so a
  broadcast email isn't embedded 10,000 times.
- **Engagement-weighted.** A chunk's score is `similarity × (0.4 + 0.6 ×
  engagement)`, where engagement comes from how deeply they actually consumed it —
  so "read to the end" beats "scrolled past."
- **Deduped at query time.** Recall keeps the most recent exposure per chunk, so
  repeated sends of the same content don't flood the results.

Next: **[06 · MCP](06-mcp.md)**.
