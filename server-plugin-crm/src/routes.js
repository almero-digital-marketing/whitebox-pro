// HTTP routes for the crm plugin. Two write endpoints (records → facts, facts →
// awareness notes), one client-observe endpoint, and one read endpoint (a
// passport's current structured state, read back from facts). All auth-gated
// except /observe. Schemas live here because they're only used by these routes.

import express from 'express'
import { z } from 'zod'
import { CORE_EVENTS } from 'whitebox-pro-server/event-catalog'

// Customer block — shared between records and facts. At least one of
// email / phone / external_id must resolve to an identity at ingest time,
// or the request is dropped with `202 no_identity`.
const customerSchema = z.object({
  email:       z.string().email().optional(),
  phone:       z.string().optional(),
  country:     z.string().length(2).optional(),
  external_id: z.union([z.string(), z.number()]).optional(),
})

// Structured state — upserted by (source, kind, external_id) into whitebox_crm_records.
const recordSchema = z.object({
  kind:        z.string().min(1).max(64),
  external_id: z.union([z.string(), z.number()]),
  status:      z.string().max(64).optional().nullable(),
  starts_at:   z.string().datetime().optional().nullable(),
  data:        z.record(z.any()).optional(),
})

const recordsRequestSchema = z.object({
  source:   z.string().min(1).max(64),
  customer: customerSchema,
  records:  z.array(recordSchema).min(1),
})

// Free-form things we know about the customer — fed to awareness as observations.
// May reference a record via `ref`, or stand alone for customer-level facts
// (tags, lifetime notes, preferences).
const factSchema = z.object({
  id:   z.union([z.string(), z.number()]),
  kind: z.string().min(1).max(64),
  body: z.string().min(1),
  ts:   z.string().datetime().optional(),
  ref:  z.object({
    kind:        z.string().min(1).max(64),
    external_id: z.union([z.string(), z.number()]),
  }).optional().nullable(),
})

const factsRequestSchema = z.object({
  source:   z.string().min(1).max(64),
  customer: customerSchema,
  facts:    z.array(factSchema).min(1),
})

// Occurrences over time — one row per thing that happened, fed to awareness as
// events rather than facts. Use this when a customer can have MANY of something
// (each service they have had, each visit): a fact is single-valued per key, so
// the same key written twice keeps only the later value.
//
// `external_id` is the dedupe handle, not a reference: it becomes the exposure's
// content_id, and `replace` deletes by prefix over it before inserting. A batch
// sending `replace: "gpoint:service:"` therefore declares "these are now all of
// this customer's service events from this source", which is what makes a
// backfill safe to re-run — exposures have no unique constraint of their own.
// `direction` is CORE's vocabulary, not a free string, and it is READ FROM CORE
// rather than restated here.
//
// It is the spine of a person's history — whether we reached out, they acted, the
// two sides talked, or money changed hands — and two consumers depend on it: the
// console renders the icon and the filter chips from it, and event-catalog.js maps
// it to the live board's in/out/internal via `map[raw] ?? 'unknown'`, explicitly
// refusing to infer. A word outside the set is therefore not a new category, it is
// an invisible row. This endpoint shipped with a made-up 'activity' and produced
// 71,596 of them before anyone saw one on a screen two modules away.
//
// Derived, because a copy is how that happens twice. The first draft of this fix
// hardcoded four values and silently omitted `observation` — wrong on the same day
// it was written, in the same way, for the same reason. classify.js already tells
// this story about itself: a local map of another module's vocabulary "was wrong
// in five ways at once and none of them were visible from inside this file."
const DIRECTIONS = Object.keys(CORE_EVENTS['awareness.recorded'].direction.map)

const eventSchema = z.object({
  event:       z.string().min(1).max(64),
  external_id: z.union([z.string(), z.number()]).optional(),
  text:        z.string().min(1).optional(),
  ts:          z.string().datetime().optional(),
  direction:   z.enum(DIRECTIONS).optional(),
  attrs:       z.record(z.any()).optional(),
})

const eventsRequestSchema = z.object({
  source:   z.string().min(1).max(64),
  customer: customerSchema,
  events:   z.array(eventSchema).min(1),
  replace:  z.string().min(1).max(128).optional(),
})

// Client-reported observations (browser SDK). Passport-scoped, low-trust — no
// customer block (identity is the current passport), no bearer secret.
const observationSchema = z.object({
  id:   z.union([z.string(), z.number()]),
  kind: z.string().min(1).max(64),
  body: z.string().min(1),
  ts:   z.string().datetime().optional(),
  meta: z.record(z.any()).optional(),
})

export const observeSchema = z.object({
  observations: z.array(observationSchema).min(1),
})

export function mountRoutes(app, { requireAuth, state, ingest, logger }) {
  const router = express.Router()

  // `reason: no_identity` means well-formed payload, intentionally dropped at
  // ingest — sender bug, no retry. We surface that as 202 so the sender
  // doesn't queue retries for what is in fact a permanent decision.
  function respond(res, result) {
    if (result.reason === 'no_identity') return res.status(202).json(result)
    return res.json(result)
  }

  router.post('/records', requireAuth, async (req, res) => {
    const parsed = recordsRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestRecords(parsed.data))
    } catch (err) {
      logger.error({ err }, 'CRM records ingest failed')
      res.status(500).json({ error: 'CRM records ingest failed' })
    }
  })

  router.post('/facts', requireAuth, async (req, res) => {
    const parsed = factsRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestFacts(parsed.data))
    } catch (err) {
      logger.error({ err }, 'CRM facts ingest failed')
      res.status(500).json({ error: 'CRM facts ingest failed' })
    }
  })

  router.post('/events', requireAuth, async (req, res) => {
    const parsed = eventsRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestEvents(parsed.data))
    } catch (err) {
      logger.error({ err }, 'CRM events ingest failed')
      res.status(500).json({ error: 'CRM events ingest failed' })
    }
  })

  // Client-reported observations. NOT bearer-authed — a browser can't hold the
  // secret. Identity is the explicit passport_id (same trust model as the
  // engagement events fallback); the socket path in index.js is preferred since
  // it takes the passport from the authenticated connection. Recorded low-trust.
  router.post('/observe', async (req, res) => {
    const parsed = observeSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestObservations({
        passport_id: req.body?.passport_id,
        observations: parsed.data.observations,
      }))
    } catch (err) {
      logger.error({ err }, 'CRM observe ingest failed')
      res.status(500).json({ error: 'CRM observe ingest failed' })
    }
  })

  // A passport's current structured state, read back from core facts as
  // { key: value }. (The records table is gone; this is a convenience read — the
  // full query surface is core /query + /ask.)
  router.get('/records/:passport_id', requireAuth, async (req, res) => {
    try {
      res.json({ data: await state.current(req.params.passport_id) })
    } catch (err) {
      logger.error({ err }, 'CRM state read failed')
      res.status(500).json({ error: 'CRM state read failed' })
    }
  })

  app.use('/crm', router)
}
