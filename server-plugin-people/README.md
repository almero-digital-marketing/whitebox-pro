# whitebox-pro-server-plugin-people

The **people browser** — the only place in WhiteBox where you look a customer
*up*, rather than arriving at them as the result of something else. Search, see
every identity and fact held about one person, fix a wrong identity, merge
duplicates, put a cohort on a list, and honour a right-to-be-forgotten erasure.

## It owns no tables

There are no migrations in this package, and that's the point. A person already
exists as a core primitive — `whitebox_passports`, with identities and facts
hanging off it. What was missing was never storage; it was the query that
assembles those joins and a surface over it. Everything here reads and writes
through `ctx.passports`, `ctx.facts` and `ctx.awareness`.

It's a plugin rather than core for a concrete reason: the permission catalog is
aggregated from *registered plugins* (`server/src/plugins.js`), so a browser
mounted in core would have no key for the UI's module gate to read.

## Two constraints that shape the whole thing

1. **A person is one passport with MANY identities.** `whitebox_passports_identities`
   is unique on `(passport_id, type, name, value)` — many rows per person. Only
   the four *strong* types (`fingerprint`, `phone`, `email`, `user`) are globally
   unique, via a partial index, which is what makes a merge happen at all.
2. **Facts have no fixed vocabulary.** Nothing here assumes `full_name` or any
   other key exists; keys are whatever the deployment happens to record. Search
   is key-agnostic, and the fact-key field suggests from what's already in use
   (`GET /people/fact-keys`) rather than from a hardcoded list.

## Install & register

```js
import { people } from 'whitebox-pro-server-plugin-people'

people({
  // read/write as usual, PLUS an optional third `erase` verifier — deleting
  // someone forever is a different authority from correcting their email.
  // Omit it and it falls back to `write`, never to `read`.
  auth: {
    read:  jwt({ issuer, audience, scope: 'people:read' }),
    write: jwt({ issuer, audience, scope: 'people:write' }),
    erase: jwt({ issuer, audience, scope: 'people:erase' }),
  },
  // both optional; default to ctx.plugins.<name>.service
  journeys: undefined,   // present → the profile shows journey enrollments
  audiences: undefined,  // present → suppression status, and static lists work
})
```

`ctx.passports` and `ctx.facts` are **required** — registration throws without
them. `journeys` and `audiences` are soft: absent, the corresponding section is
omitted rather than erroring.

### Permissions

| key | grants |
|---|---|
| `people:read` | Search people and view their identities, facts and history |
| `people:write` | Link/unlink identities, record facts, merge duplicates, list membership |
| `people:erase` | Permanently delete a person and every row referencing them |

`defaults: []` — none are granted to a new user automatically.

## HTTP

| method | path | auth |
|---|---|---|
| `GET` | `/people` | read |
| `GET` | `/people/lists` | read |
| `GET` | `/people/fact-keys` | read |
| `GET` | `/people/:id` | read |
| `GET` | `/people/:id/activity` | read |
| `POST` | `/people/:id/identities` | write |
| `DELETE` | `/people/:id/identities/:identityId` | write |
| `POST` | `/people/:id/facts` | write |
| `POST` | `/people/lists` | write |
| `POST` | `/people/:id/lists` | write |
| `DELETE` | `/people/:id/lists/:segmentId` | write |
| `POST` | `/people/:id/merge` | write |
| `POST` | `/people/lists/:segmentId/members` | write (bulk) |
| `POST` | `/people/facts` | write (bulk) |
| `POST` | `/people/erase` | **erase** (bulk) |
| `DELETE` | `/people/:id` | **erase** |

Routes on a literal segment (`/lists`, `/fact-keys`, `/facts`, `/erase`) are
declared **before** the `/:id` ones, or Express reads "lists" as a passport id.

### Search — `GET /people`

`?q=&fields=&include_anonymous=&limit=&offset=` → `{ total, people[] }`.

- `q` matches identity values, **any fact value** (key-agnostic), and a passport
  id or a *prefix* of one — the rail labels anonymous people by the first 8 hex
  characters, so what's on screen has to be pasteable back in.
- `fields` is CSV (`identities,facts,id`) — an empty or unrecognised selection
  falls back to all, because a filter typo that silently matches nothing is worse
  than one that over-matches.
- `include_anonymous` defaults to **false**. Most passports are anonymous web
  visitors, so the default list is the identified ones.
- Rows carry `event_count` — how much history each person has — unless awareness
  isn't running, in which case the field is absent (distinct from `0`).
- Never returns a merged-away id.

### The bulk envelope

Three verbs act on a whole selection and all take the same body:

```jsonc
{ "passport_ids": ["…"] }                       // an explicit set
{ "query": { "q": "…", "fields": […], "includeAnonymous": false } }  // re-run the search
```

The second is the point: the client has seen one page of twenty-five and cannot
enumerate "everyone matching". The server re-runs the query.

| endpoint | does | cap |
|---|---|---|
| `POST /people/lists/:segmentId/members` | add the selection to a static list | 5000 |
| `POST /people/facts` | record one fact on everyone (`{key, value}`) | 5000 |
| `POST /people/erase` | erase everyone | **200** |

Erase gets its own, far lower cap: every other bulk verb is *one* statement,
while erase is a lock plus a transaction across the 17 tables that reference a
passport, **per person**. Five thousand of those will not finish inside an HTTP
request. Truncation is always
**reported** (`truncated: true`), never silent — a half-done right-to-be-forgotten
that claimed success would be a false compliance claim.

Counts can come back lower than requested, and that's real rather than an error:
merged passports resolve to one id, so `recorded`/`added`/`erased` may trail
`requested`.

## MCP

`people_search` · `people_get` · `people_activity` · `people_link_identity` ·
`people_unlink_identity` · `people_record_fact` · `people_merge` · `people_erase`

The bulk verbs are deliberately **not** exposed over MCP — they're a UI
affordance for a selection you can see; an agent loops the per-person tool.

## Merge vs erase

- **Merge** keeps the data: two passports become one, and core re-points every
  referencing row it finds through the Postgres FK catalog.
- **Erase** is the only irreversible action in WhiteBox. It deletes across every
  referencing table, drops the merge aliases, and removes the passport itself —
  including any passports previously merged *into* it, since those ids still
  identify someone who asked to be forgotten. It returns per-table row counts, so
  an erasure can be **evidenced** rather than assumed.

`whitebox_event_registry` is excluded by design: its `passport_id` is a
denormalised string lifted from an event payload, not a reference.

## Tests

```bash
npm test --workspace=whitebox-pro-server-plugin-people
```

Service-level, against mocked core primitives: search paging and scope, detail
assembly, soft-dependency omission when journeys/audiences aren't wired, the
bulk envelope for each verb, the caps, and the merge-collapse counts.
