import { randomUUID } from 'crypto'
import dayjs from 'dayjs'
import logger from './logger.js'

const PASSPORTS = 'whitebox_passports'
const IDENTITIES = 'whitebox_passports_identities'
const MERGES = 'whitebox_passports_merges'
// The audiences plugin's ad-signal rows. Core doesn't own the table and works
// fine without it, but it's the one other place where `passport_id` sits inside
// a unique constraint — `unique(passport_id, name)` — so a blind re-point on
// merge would collide. Named here so merge()/erase() can give it the same
// per-row dedupe identities get, instead of blowing up.
const SIGNALS = 'whitebox_audience_signals'

// Identity types used as merge keys — if two passports share one, they are the same person
const STRONG = new Set(['fingerprint', 'phone', 'email', 'user'])

const DEFAULT_LIFESPANS = {
  fingerprint: 7,
  phone: 30,
  email: 365,
  user: Infinity,
}

let db
let lock
let notify
let lifespans

export async function init(options) {
  db = options.db
  lock = options.lock
  // Optional: a deployment without it just doesn't emit lifecycle events.
  notify = options.notify || null
  lifespans = { ...DEFAULT_LIFESPANS, ...options.config?.passports?.lifespans }

  const passportsExists = await db.schema.hasTable(PASSPORTS)
  if (!passportsExists) {
    await db.schema.createTable(PASSPORTS, t => {
      t.uuid('id').primary()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('last_seen_at')
    })
    logger.info('Passports table created')
  }

  const identitiesExists = await db.schema.hasTable(IDENTITIES)
  if (!identitiesExists) {
    await db.schema.createTable(IDENTITIES, t => {
      t.increments('id')
      t.uuid('passport_id').notNullable().references('id').inTable(PASSPORTS).onDelete('CASCADE')
      t.string('type', 32).notNullable()
      t.string('name', 64).notNullable()
      t.string('value', 512).notNullable()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('last_seen_at').notNullable().defaultTo(db.fn.now())
      t.unique(['passport_id', 'type', 'name', 'value'])
      t.index('passport_id')
    })
    // Strong identity types must be globally unique — one passport per phone/email/fingerprint
    await db.raw(`
      CREATE UNIQUE INDEX ${IDENTITIES}_strong_unique ON ${IDENTITIES} (type, value)
      WHERE type IN ('fingerprint', 'phone', 'email', 'user')
    `)
    logger.info('Passports identities table created')
  }

  const mergesExists = await db.schema.hasTable(MERGES)
  if (!mergesExists) {
    await db.schema.createTable(MERGES, t => {
      t.increments('id')
      t.uuid('absorbed_id').notNullable()
      t.uuid('survivor_id').notNullable().references('id').inTable(PASSPORTS)
      t.timestamp('merged_at').notNullable().defaultTo(db.fn.now())
      t.index('absorbed_id')
    })
    logger.info('Passports merges table created')
  }
}

export async function resolve(passportId) {
  while (passportId) {
    const merge = await db(MERGES).where({ absorbed_id: passportId }).orderBy('merged_at', 'desc').first()
    if (!merge) break
    passportId = merge.survivor_id
  }
  return passportId
}

function isWithinLifespan(type, lastSeenAt) {
  const days = lifespans[type]
  if (!days) return false
  const within = dayjs().diff(dayjs(lastSeenAt), 'day') <= days
  return within
}

export async function identify(passportId) {
  passportId = await resolve(passportId)

  if (passportId) {
    const row = await db(PASSPORTS).where({ id: passportId }).first()
    if (!row) passportId = null
  }

  if (!passportId) {
    passportId = randomUUID()
    await db(PASSPORTS).insert({ id: passportId })
    // A person WhiteBox had never seen before. Emitted only on a genuine mint,
    // never when identify() resolves an id it already knew, so the volume is
    // new-visitors rather than page-views. Without this a visitor who arrives
    // and just browses is invisible to every observer — the monitoring view
    // showed an empty board while the passports table filled up.
    notify?.('passport.created', {
      type: 'passport.created',
      data: { passport_id: passportId },
    })?.catch?.(() => {})
  }

  await db(PASSPORTS).where({ id: passportId }).update({ last_seen_at: dayjs().toDate() })

  return passportId
}

export async function identities(passportId) {
  passportId = await resolve(passportId)
  const rows = await db(IDENTITIES).where({ passport_id: passportId })
  return rows
}

export async function findByIdentity(type, value) {
  const row = await db(IDENTITIES).where({ type, value }).first()
  if (!row) return null
  const passport = await db(PASSPORTS).where({ id: row.passport_id }).first()
  return passport
}

export async function link(passportId, items) {
  passportId = await resolve(passportId)
  const now = dayjs().toDate()
  // Only what was ACTUALLY attached for the first time. link() runs on nearly
  // every identify, inbound mail, and answered call, and the overwhelming
  // majority of those calls just bump last_seen_at on an identity we already
  // hold — announcing those would bury the one that matters in noise.
  const learned = []

  for (const item of items) {
    if (STRONG.has(item.type)) {
      // Strong identities are globally unique — find across all passports
      const existing = await db(IDENTITIES).where({ type: item.type, value: item.value }).first()

      if (!existing) {
        let inserted = true
        await db(IDENTITIES).insert({ passport_id: passportId, type: item.type, name: item.name, value: item.value, last_seen_at: now }).catch(err => {
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) throw err
          inserted = false   // lost a race to a concurrent link — not news
        })
        if (inserted) learned.push({ type: item.type, name: item.name })
        continue
      }

      await db(IDENTITIES).where({ id: existing.id }).update({ last_seen_at: now })

      if (existing.passport_id !== passportId && isWithinLifespan(item.type, existing.last_seen_at)) {
        await merge(passportId, existing.passport_id)
      }
    } else {
      // Weak identities are per passport — update last_seen_at if exists, insert if not
      const existing = await db(IDENTITIES).where({ passport_id: passportId, type: item.type, name: item.name, value: item.value }).first()

      if (existing) {
        await db(IDENTITIES).where({ id: existing.id }).update({ last_seen_at: now })
      } else {
        await db(IDENTITIES).insert({ passport_id: passportId, type: item.type, name: item.name, value: item.value, last_seen_at: now })
        learned.push({ type: item.type, name: item.name })
      }
    }
  }

  // An anonymous visitor became a known person — the moment most of this system
  // exists to capture, and it used to leave no trace at all.
  //
  // Identity TYPES and NAMES only, never values. The feed streams to any console
  // client and links out to /people/<id>, where the actual addresses are shown
  // behind that module's own permission — putting a bare email in the firehose
  // would route around it. "learned email, phone" is the useful sentence anyway;
  // WHICH email is a click away.
  if (learned.length) {
    notify?.('passport.identified', {
      type: 'passport.identified',
      data: { passport_id: passportId, identities: learned },
    })?.catch?.(() => {})
  }
}

// Every table that references whitebox_passports(id), discovered from the
// Postgres catalog rather than a hardcoded list — so a new plugin table is
// covered the moment it declares its FK, with no change here. merge() and
// erase() share this so they can never drift on which tables they reach.
//
// Only single-column FKs: a composite key referencing passports isn't a
// per-passport row and can't be blindly re-pointed or deleted.
async function passportReferences(trx = db) {
  const { rows } = await trx.raw(`
    SELECT cl.relname AS tbl, a.attname AS col
    FROM pg_constraint con
    JOIN pg_class cl     ON cl.oid = con.conrelid
    JOIN pg_attribute a  ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'whitebox_passports'::regclass
      AND array_length(con.conkey, 1) = 1
  `)
  return rows
}

// Every UNIQUE/PK constraint that includes a passport column, with its OTHER
// columns. merge() re-points rows from the absorbed passport to the survivor,
// which is a plain UPDATE — and a plain UPDATE throws the moment the survivor
// already holds a row with the same (other columns, passport_id). Discovering
// those constraints from the catalog, the same way passportReferences() does
// for the FKs, means a new plugin table with a per-passport uniqueness rule is
// handled the day it's created rather than the day merge first throws on it.
async function passportUniques(trx = db) {
  const { rows } = await trx.raw(`
    SELECT cl.relname AS tbl,
           pcol.attname AS passport_col,
           -- ::text is load-bearing: attname is Postgres's "name" type, and
           -- node-postgres has no parser for name[], so aggregating it raw
           -- hands back the literal string '{segment_id}' instead of an array.
           array_remove(array_agg(ocol.attname::text), pcol.attname::text) AS other_cols
    FROM pg_constraint con
    JOIN pg_class cl        ON cl.oid = con.conrelid
    JOIN pg_constraint fk   ON fk.conrelid = con.conrelid
                           AND fk.contype = 'f'
                           AND fk.confrelid = 'whitebox_passports'::regclass
                           AND array_length(fk.conkey, 1) = 1
    JOIN pg_attribute pcol  ON pcol.attrelid = con.conrelid AND pcol.attnum = fk.conkey[1]
    JOIN pg_attribute ocol  ON ocol.attrelid = con.conrelid AND ocol.attnum = ANY (con.conkey)
    WHERE con.contype IN ('u', 'p')
      AND pcol.attnum = ANY (con.conkey)          -- the passport column is part of it
      AND array_length(con.conkey, 1) > 1         -- ...alongside something else
    GROUP BY cl.relname, pcol.attname
  `)
  return rows
}

// Merge `absorbed` into `survivor`: move every reference onto the survivor and
// record the merge so resolve() forwards future hits. NON-DESTRUCTIVE — the
// absorbed passport is kept as a childless tombstone (no CASCADE data loss, no
// FK-violation on a delete). References are discovered from the Postgres catalog,
// so any table with a FK to whitebox_passports is moved automatically — no
// hardcoded table list, new plugin tables included for free.
export async function merge(survivorId, absorbedId) {
  survivorId = await resolve(survivorId)
  absorbedId = await resolve(absorbedId)
  if (!survivorId || !absorbedId || survivorId === absorbedId) return survivorId

  const key = [survivorId, absorbedId].sort().join(':')
  const acquired = await lock.acquire(`passport:merge:${key}`, 5000)
  let merged = false

  try {
    await db.transaction(async trx => {
      // 1. Identities. Strong types are globally unique on (type, value), so the
      //    survivor can never already hold the same value → always safe to move.
      //    Weak types are per-passport → dedupe against the survivor.
      const absorbed = await trx(IDENTITIES).where({ passport_id: absorbedId })
      for (const id of absorbed) {
        if (STRONG.has(id.type)) {
          await trx(IDENTITIES).where({ id: id.id }).update({ passport_id: survivorId })
        } else {
          const dup = await trx(IDENTITIES)
            .where({ passport_id: survivorId, type: id.type, name: id.name, value: id.value }).first()
          if (dup) await trx(IDENTITIES).where({ id: id.id }).del()
          else await trx(IDENTITIES).where({ id: id.id }).update({ passport_id: survivorId })
        }
      }

      // 2. Ad signals, if the audiences plugin is installed. Same problem shape
      //    as a weak identity — unique(passport_id, name) — so the same fix:
      //    move a signal the survivor lacks, drop one it already has. Keeping
      //    the survivor's value is deliberate; on a merge the survivor is the
      //    identity we're consolidating onto, so its click ids are the ones
      //    still in play.
      if (await trx.schema.hasTable(SIGNALS)) {
        const theirs = await trx(SIGNALS).where({ passport_id: absorbedId })
        for (const sig of theirs) {
          const dup = await trx(SIGNALS).where({ passport_id: survivorId, name: sig.name }).first()
          if (dup) await trx(SIGNALS).where({ id: sig.id }).del()
          else await trx(SIGNALS).where({ id: sig.id }).update({ passport_id: survivorId })
        }
      }

      // 3. Every OTHER table with a single-column FK to whitebox_passports(id),
      //    discovered from the catalog — so a new plugin's table is re-pointed
      //    the day it declares its FK. (This also compacts
      //    whitebox_passports_merges.survivor_id.)
      //
      //    A table whose uniqueness includes the passport column can't take a
      //    blind UPDATE: if the survivor already holds the same (other cols,
      //    passport), it collides. Those are found from the catalog too and
      //    deduped row by row — move what the survivor lacks, drop what it
      //    already has. The survivor's row wins, matching steps 1 and 2:
      //    on a merge the survivor is the identity being consolidated onto.
      const uniques = new Map(
        (await passportUniques(trx)).map(u => [u.tbl, u]))
      for (const { tbl, col } of await passportReferences(trx)) {
        if (tbl === IDENTITIES || tbl === SIGNALS) continue   // both handled above
        const uniq = uniques.get(tbl)
        if (!uniq) {
          await trx(tbl).where(col, absorbedId).update({ [col]: survivorId })
          continue
        }
        for (const row of await trx(tbl).where(col, absorbedId)) {
          const match = Object.fromEntries(uniq.other_cols.map(c => [c, row[c]]))
          const dup = await trx(tbl).where({ ...match, [col]: survivorId }).first()
          if (dup) await trx(tbl).where(row).del()
          else await trx(tbl).where(row).update({ [col]: survivorId })
        }
      }

      // 4. Record the alias so resolve() forwards absorbed → survivor. The
      //    absorbed passport row stays (now childless) — we do NOT delete it.
      await trx(MERGES).insert({ absorbed_id: absorbedId, survivor_id: survivorId })
    })
    logger.info('Merged passport %s into %s', absorbedId, survivorId)
    merged = true
  } finally {
    await lock.release(acquired)
  }

  // Two people turned out to be one. Nothing else in the system changes as much
  // about the past — every event, session and fact the absorbed passport owned is
  // now attributed to the survivor — and until now it happened in silence, visible
  // only in a log line. Emitted INSIDE the success path (not the finally) so a
  // merge that threw doesn't announce itself.
  if (merged) {
    notify?.('passport.merged', {
      type: 'passport.merged',
      // The survivor, because that is who the row is now about. `passport_id` is
      // also the only field the event registry persists, so this is what puts the
      // merge on the surviving person's timeline.
      data: { passport_id: survivorId, survivor_id: survivorId, absorbed_id: absorbedId },
    })?.catch?.(() => {})
  }

  return survivorId
}

// Permanently delete a passport and everything referencing it — the
// right-to-be-forgotten counterpart to merge(). DESTRUCTIVE and irreversible;
// merge() is the non-destructive option and stays the default for "these are
// the same person".
//
// Uses the same passportReferences() discovery as merge(), so the two can never
// disagree about which tables constitute "this person's data" — the failure
// mode that makes an erasure quietly incomplete. Returns per-table row counts
// so a caller can show, and log, exactly what was removed.
//
// Also clears merge aliases in BOTH directions: rows where this passport was
// absorbed (so resolve() stops forwarding to a now-deleted id) and rows where
// it was the survivor (so an older absorbed id doesn't resolve into a void).
export async function erase(passportId) {
  const id = await resolve(passportId)
  // resolve() only follows the merge chain — it hands back an unknown id
  // unchanged rather than proving the passport exists. Without this check
  // erase() would delete nothing, then report success for someone who was
  // never here, which is exactly the wrong answer to give about an erasure.
  if (!id || !(await db(PASSPORTS).where({ id }).first())) return null

  const acquired = await lock.acquire(`passport:erase:${id}`, 5000)
  let erased = false
  const removed = {}
  try {
    await db.transaction(async trx => {
      for (const { tbl, col } of await passportReferences(trx)) {
        if (tbl === MERGES) continue                      // handled explicitly below
        const n = await trx(tbl).where(col, id).del()
        if (n) removed[tbl] = n
      }
      // A merged person is ONE person holding several passport ids. Erasing
      // only the survivor would leave every absorbed id behind as a bare,
      // unresolvable row — no PII in it, but still an identifier belonging to
      // someone who asked to be forgotten. Collect the whole chain first, then
      // drop the aliases, then every passport in it.
      const absorbed = (await trx(MERGES).where({ survivor_id: id }).select('absorbed_id'))
        .map(r => r.absorbed_id)
      const aliases = await trx(MERGES).where({ absorbed_id: id }).orWhere({ survivor_id: id }).del()
      if (aliases) removed[MERGES] = aliases
      const self = await trx(PASSPORTS).whereIn('id', [id, ...absorbed]).del()
      if (self) removed[PASSPORTS] = self
    })
    logger.info({ passport_id: id, removed }, 'Erased passport')
    erased = true
  } finally {
    await lock.release(acquired)
  }

  // A person was deleted. The most audit-worthy thing this system does, and the
  // one operation you most want to see on a board rather than discover in a log.
  //
  // Deliberately carries NO passport_id — not even in `data`, which is the field
  // the registry persists. Recording "we erased X" against X is self-defeating:
  // the whole point was to stop holding the identifier. The row counts say what
  // happened without resurrecting who it happened to, and the surrounding log line
  // (which has its own retention and access rules) keeps the id for an operator
  // who legitimately needs it.
  if (erased) {
    notify?.('passport.erased', {
      type: 'passport.erased',
      data: {
        tables: Object.keys(removed).length,
        rows: Object.values(removed).reduce((n, v) => n + Number(v || 0), 0),
      },
    })?.catch?.(() => {})
  }
  return { id, removed }
}

// Detach one identity from a passport — for correcting a bad match (a shared
// device that linked the wrong email, say). Scoped to the passport on purpose:
// an id alone would let a caller delete any row in the table.
export async function unlink(passportId, identityId) {
  const pid = await resolve(passportId)
  if (!pid) return 0
  const removed = await db(IDENTITIES).where({ id: identityId, passport_id: pid }).del()
  // Only when a row actually went — an unlink of something already gone is not an
  // event, and this is the counterpart to passport.identified: a correction to
  // who we think someone is, which deserves the same visibility as the claim.
  if (removed) {
    notify?.('passport.unlinked', {
      type: 'passport.unlinked',
      data: { passport_id: pid, identity_id: identityId },
    })?.catch?.(() => {})
  }
  return removed
}

// Everything known about one passport, assembled from the two stores that
// actually hold it. No display-name concept and no fact-key assumptions —
// facts are optional and their keys are arbitrary (a deployment may have none,
// or call a name anything), so this returns whatever is there and leaves
// presentation to the caller.
export async function get(passportId, { facts } = {}) {
  const id = await resolve(passportId)
  if (!id) return null
  const row = await db(PASSPORTS).where({ id }).first()
  if (!row) return null
  return {
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    identities: await db(IDENTITIES).where({ passport_id: id })
      .select('id', 'type', 'name', 'value', 'created_at', 'last_seen_at')
      .orderBy('last_seen_at', 'desc'),
    facts: facts ? await facts.current(id) : {},
  }
}

// The three places a search term can be looked for. Exported because they're a
// vocabulary the transports validate against and the UI renders as checkboxes —
// there must be exactly one list, not a copy per layer.
export const SEARCH_FIELDS = ['identities', 'facts', 'id']

// Find people. `q` matches an identity value (email/phone/user/fingerprint), an
// arbitrary FACT value — key-agnostic, never naming a key, because keys differ
// per deployment — or a passport id.
//
// `fields` narrows which of those to look in; omitted (or unrecognised) means
// all three, so every existing caller keeps its behaviour. Narrowing matters
// because the three overlap in practice: a numeric term hits phone identities
// AND order-total facts, and there's no way to say which you meant.
//
// `includeAnonymous` defaults false: most passports are anonymous web visitors
// with no identity and no facts (277 vs 49 identified in the dev DB), so an
// unfiltered list is mostly rows with nothing in them. Callers opt in.
//
// Tombstones never appear: an absorbed passport is somebody else now, and
// returning it would let a caller act on an id that resolve() forwards away.
export async function search({ q = '', fields, includeAnonymous = false, limit = 50, offset = 0 } = {}) {
  const term = String(q || '').trim()
  const like = `%${term}%`
  // Accepts an array or a comma-separated string, since this arrives from a
  // query string as often as from a direct call. An empty or entirely
  // unrecognised selection falls back to all: a filter typo that silently
  // matches nothing is a worse failure than one that over-matches.
  const asked = Array.isArray(fields) ? fields : String(fields ?? '').split(',')
  const picked = asked.map(f => String(f).trim()).filter(f => SEARCH_FIELDS.includes(f))
  const scope = picked.length ? picked : SEARCH_FIELDS
  // A whole uuid, but also a PREFIX of one: the rail labels an anonymous person
  // by the first 8 hex chars of their id, so what's on screen has to be what
  // you can paste back in. Gated on the term looking like hex, or every short
  // word would drag the passport table into an id scan too.
  const idish = term && /^[0-9a-f]+$/i.test(term.replace(/-/g, ''))

  const base = db(PASSPORTS).select(`${PASSPORTS}.id`)
    // a merged-away passport is no longer a person you can act on
    .whereNotExists(db(MERGES).select(db.raw(1)).whereRaw(`${MERGES}.absorbed_id = ${PASSPORTS}.id`))

  if (term) {
    base.where(b => {
      // A false seed so each enabled scope ORs on unconditionally. It also
      // gives the right answer for "id only, term isn't an id" — nobody —
      // rather than an accidental unfiltered list.
      b.whereRaw('false')
      if (scope.includes('identities')) {
        b.orWhereExists(db(IDENTITIES).select(db.raw(1))
          .whereRaw(`${IDENTITIES}.passport_id = ${PASSPORTS}.id`).andWhere('value', 'ilike', like))
      }
      if (scope.includes('facts')) {
        b.orWhereExists(db('whitebox_facts').select(db.raw(1))
          .whereRaw(`whitebox_facts.passport_id = ${PASSPORTS}.id`)
          // #>> '{}' unwraps a jsonb scalar to text without naming a key
          .andWhereRaw(`value #>> '{}' ILIKE ?`, [like]))
      }
      if (scope.includes('id') && idish) {
        b.orWhereRaw(`${PASSPORTS}.id::text LIKE ?`, [`${term.toLowerCase()}%`])
      }
    })
  } else if (!includeAnonymous) {
    base.whereExists(db(IDENTITIES).select(db.raw(1))
      .whereRaw(`${IDENTITIES}.passport_id = ${PASSPORTS}.id`))
  }

  const [{ count }] = await base.clone().clearSelect().count('* as count')
  const rows = await base
    .select(`${PASSPORTS}.created_at`, `${PASSPORTS}.last_seen_at`)
    .orderByRaw(`${PASSPORTS}.last_seen_at DESC NULLS LAST`)
    // The tiebreaker that makes LIMIT/OFFSET honest. last_seen_at is NOT unique
    // — anything that touches a batch of people in one pass (an import, a
    // campaign send, a merge sweep) stamps them all with the same instant, and
    // the anonymous tail shares NULL. Without a total order Postgres may split
    // a tie group differently per query, so the same person appears on two
    // consecutive pages while someone else is skipped entirely. Measured on dev:
    // 286 passports over 282 distinct last_seen_at values.
    .orderBy(`${PASSPORTS}.id`, 'desc')
    .limit(Math.min(Number(limit) || 50, 200))
    .offset(Number(offset) || 0)

  // One query for every result's identities rather than N — the rail renders a
  // "strongest identity + N more" line, so it needs them all, not just a count.
  const ids = rows.map(r => r.id)
  const identities = ids.length
    ? await db(IDENTITIES).whereIn('passport_id', ids)
        .select('id', 'passport_id', 'type', 'name', 'value', 'last_seen_at')
    : []
  const byPassport = new Map(ids.map(id => [id, []]))
  for (const i of identities) byPassport.get(i.passport_id)?.push(i)

  return {
    total: Number(count),
    people: rows.map(r => ({ ...r, identities: byPassport.get(r.id) || [] })),
  }
}

// Generic HTTP entry point for attaching identity claims to a passport —
// e.g. a browser linking its anonymous passport to an email/phone at
// registration or login, so pre-existing history merges instead of orphaning.
// passport_id carries no auth weight (same trust model as every other
// passport-scoped route — see /crm/observe, /shortener/claim); it's an
// attribution key, not a security boundary. `claims` is passed straight
// through to link() — this route has no opinion on identity types.
export function register(app) {
  app.post('/passports/link', async (req, res) => {
    try {
      const { passport_id: passportId, claims } = req.body || {}
      if (!passportId) return res.status(400).json({ error: 'passport_id is required' })
      if (!Array.isArray(claims) || !claims.length) return res.status(400).json({ error: 'claims must be a non-empty array' })

      await link(passportId, claims)
      res.json({ passportId: await resolve(passportId) })
    } catch (err) {
      logger.error({ err }, 'Failed to link identity')
      res.status(500).json({ error: 'Failed to link identity' })
    }
  })
}
