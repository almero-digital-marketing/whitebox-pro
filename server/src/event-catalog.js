import { trim, body, collapse, pathOf, decodePath, letters } from './event-format.js'

// What each event MEANS — declared by whoever emits it.
//
// Every notify() lands in the event registry as a type and a payload. Two
// questions get asked about it afterwards ("which way was this flowing?" and
// "which channel was it?"), and until now both were answered by a map inside
// server-plugin-live: one file listing the event namespaces of sixteen other
// modules.
//
// That map could only ever be a guess about someone else's plugin, and it
// drifted exactly as you'd expect:
//   · voip.click was missing entirely (voip.call/ring/pick were there), so
//     click-to-call — the one voip event the browser SDK produces on its own —
//     was classified `unknown` and counted in neither direction.
//   · 'conversions.' was listed, plural, but the plugin emits `conversion.` —
//     so every conversion was `unknown` until someone noticed.
//   · webhook., queue., engagement. and audiences. were all listed and are
//     emitted by NOBODY. Three of them then appeared as channel filter options
//     that could never match a single row.
// None of those were visible by reading live; all three kinds are impossible
// once the module that emits an event is the module that classifies it.
//
// So this is the same shape as the permission catalog (see plugins.js): a
// STATIC field on a plugin factory's return value, aggregated in a pre-pass
// before any register() runs. Static and pre-pass both matter — classification
// must not depend on load order, and must be available to a plugin that
// registers before the ones it reports on.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
//   export function voip(options) {
//     return {
//       name: 'voip',
//       events: {
//         'voip.ring':  'in',
//         'voip.pick':  'internal',
//         'voip.call':  'in',
//         'voip.click': 'in',
//       },
//       register(app, ctx) { … },
//     }
//   }
//
// A key is an exact type, or a PREFIX if it ends in a dot — `'conversion.'`
// covers `conversion.purchase` and every other name a host invents, which is
// the only way to declare an event whose suffix is chosen at runtime. Longest
// match wins, so `'mail.'` and `'mail.bulk.cancelled'` can disagree and the
// order they're written in doesn't matter.
//
// A value is a direction:
//   'in'       something arrived from the outside world
//   'out'      whitebox reached out
//   'internal' orchestration that touched nobody outside
//
// `internal` is not a shrug — it's what stops the numbers lying. A journey
// enrollment is not traffic, and counting it as either direction inflates a
// figure an operator is using to judge whether the system is talking to anyone.
//
// Or an object, when direction and channel aren't fixed at declaration time:
//   {
//     direction: 'in',                       // or a { from, map } lookup
//     channel: 'web',                        // default: the type's first segment
//   }
//
// `{ from, map }` reads the answer out of the payload — for an event that
// carries its own classification, recorded at the point it happened. Only
// awareness needs it today (see CORE_EVENTS), and it exists so that staying
// declarative doesn't cost accuracy: re-deriving a direction the emitter
// already decided would be a second source of truth for the same fact.
//
// ── CHANNELS ────────────────────────────────────────────────────────────────
//
// A channel defaults to the first segment of the type, which is how these names
// are built. Declare `channels: [...]` alongside `events` for channels a type
// can't reveal:
//
//   channels: ['web'],   // arrives as awareness.recorded with channel in payload
//
// The union of every declared channel is the channel FILTER list, and that is
// why it is a declaration and not a query over recent traffic: a filter list is
// not a report. Options derived from "what has happened lately" mean a quiet
// window offers nothing to filter by — you could switch a channel off after it
// got busy, never before. A channel is a thing the system HAS.
//
// ── NOT DECLARING ANYTHING ──────────────────────────────────────────────────
//
// Perfectly normal, and the right answer for a plugin that emits no events:
// analytics, audiences, engagement, geolocation, oauth and people all sit in
// this bucket. engagement is the instructive one — it records AWARENESS rather
// than emitting its own events, so its traffic already arrives as
// awareness.recorded under whatever channel the touch happened on. Listing
// 'engagement.' as live once did didn't classify anything; it just added a
// filter option that could never match.
//
// An event nobody declares classifies as `unknown` — deliberately, and never
// as `internal`. A plugin added tomorrow shows up in the board's `unknown`
// bucket and is visibly missing from its own manifest, which is a prompt to
// declare it. A default would instead be a number quietly drifting wrong.

// Core's own events. Core is not a plugin, but it emits, so it declares in the
// same shape — and this is deliberately HERE and not in live, which is the whole
// point of the exercise.
export const CORE_EVENTS = {
  // A person arriving. Emitted on a genuine mint / new session only, not per
  // request, so between them these are new-visitors and new-sessions — the most
  // basic "is anything happening at all" signal there is.
  'passport.created': 'in',
  'session.started': 'in',

  // The rest of a person's lifecycle. All `internal`, and that is the honest
  // reading: nobody outside was touched. A merge, an erasure and a newly-learned
  // email are things WE did to our own records — the inbound act that caused them
  // (the form submit, the call, the reply) already counted as traffic under its
  // own channel, so counting these too would count one act twice.
  //
  // `internal` is not "unimportant" — it is the direction for orchestration, and
  // these are the most consequential entries the feed carries. A merge rewrites
  // every historical attribution the absorbed passport had.
  'passport.identified': 'internal',
  'passport.merged': 'internal',
  'passport.unlinked': 'internal',
  'passport.erased': 'internal',

  // Awareness carries its own direction, recorded at the point of the touch, so
  // it is read from the payload rather than derived from the type. The map is
  // core's vocabulary for what a touch WAS:
  //   exposure     we reached them            → out
  //   expression   they acted                 → in
  //   conversion   they converted             → in
  //   observation  state observed about them  → in
  //   conversation two-way (a call)           → in
  // A conversation is genuinely both directions. It counts as `in` because the
  // question this classification answers is "is anything coming back?", and a
  // call is the strongest possible yes.
  'awareness.recorded': {
    direction: {
      from: 'data.direction',
      map: {
        exposure: 'out',
        expression: 'in',
        conversion: 'in',
        observation: 'in',
        conversation: 'in',
      },
    },
    // Likewise the channel: an awareness event reports the channel it happened
    // on, which is why `web` below has to be declared by hand — it arrives ONLY
    // this way, from the browser SDK's page views, so no event type mentions it.
    channel: { from: 'data.channel' },
  },
  'awareness.forgotten': 'internal',
}

// Channels core can produce that no event type reveals. See `web` above.
export const CORE_CHANNELS = ['web']

// ── DETAIL ──────────────────────────────────────────────────────────────────
//
// What an event was ABOUT, in one short line. A feed of type names answers
// "something happened" and nothing more: twenty rows reading `awareness.recorded`
// are indistinguishable, so an operator has to open each one to learn anything.
// The type is the verb; this is the object — who it reached, which video was
// watched, which network rejected us.
//
// A SEPARATE map from `events`, keyed the same way (exact type, or a trailing-dot
// prefix, longest match wins). Separate because the natural granularity differs:
// mail declares eleven event types but needs two detail functions, and folding
// them together would mean repeating `detail: mailDetail` eleven times. build()
// warns about a detail key that no declared event can match, so the two maps
// can't quietly drift apart.
//
// Values are functions, which does mean the catalog isn't serialisable. Nothing
// serialises it, and the alternative — a template mini-language — would be a
// worse version of JavaScript.
//
// Rules, learned the hard way:
//   · Never guess a shape. Every field read is one the producer actually writes.
//   · Return null rather than something vague. "—" in the UI is honest; an
//     invented summary is worse than no summary.
//   · No PII beyond what the module already shows. Recipients are already visible
//     in mail/sms's own surfaces, but text CONTENT is redacted upstream in
//     awareness and must not be reconstituted — hence source/kind rather than the
//     excerpt itself.
//   · Don't truncate. detail() applies `trim` for you, so the cap is in one place.

// Producers compose awareness text as "<their own label> — <the real content>".
// Conversions write "Conversion: view content — Защо не използваме…" for a
// `conversion.view_content` event: the first segment restates the type column, so
// it's pure noise here AND it consumes the row's width before the content gets a
// chance. Strip that leading echo; keep everything after it.
//
// Returns null when nothing but the echo remains — the caller then falls back to
// the url/id, which at least says where it happened.
function stripTypeEcho(preview, d) {
  if (!preview) return null
  // The type name as the producer would have written it, from content_id
  // ('conversion:view_content:<uuid>' -> 'conversion view content').
  const name = letters(String(d.content_id || '').split(':').slice(0, 2).join(' '))
  if (!name) return preview

  const segments = preview.split(/\s+[—–|]\s+/)
  const kept = segments.filter((seg, i) => {
    if (i > 0) return true                       // only a LEADING echo is noise
    const s = letters(seg)
    // exact restatement, or a prefix of it (a label truncated by the preview cap)
    return !(s === name || (s.length <= name.length + 4 && name.startsWith(s)))
  })
  const out = kept.join(' — ').trim()
  return out || null
}

// Engagement lands here with `source` carrying WHAT was consumed ('video' |
// 'text' | 'image' | 'section' | 'link' | …), which is the only place that
// distinction survives — there is no separate engagement.* event type, on
// purpose: it would double-count one touch as two events in the traffic totals.
function describeAwareness(d) {
  const what = d.source || d.channel || null

  // Prefer the actual (already-redacted) text. "text · verify-text-1" told an
  // operator nothing — an internal identifier where the sentence the person
  // actually read was available. Core carries a bounded excerpt for exactly this,
  // so show the content and fall back to the identifier only when there isn't any
  // (a conversion, a voip call — nothing was "read").
  const meaningful = stripTypeEcho(trim(collapse(d.preview)), d)
  if (meaningful) return what ? `${what} · ${meaningful}` : meaningful

  // content_id is the paired fallback for content_url and can carry the same
  // encoding (it's often derived from the slug), so it decodes the same way.
  const where = pathOf(d.content_url) || trim(decodePath(d.content_id))
  if (what && where) return `${what} · ${where}`
  return trim(what) || where
}

export const CORE_DETAIL = {
  'awareness.recorded': describeAwareness,
  'awareness.forgotten': (d) =>
    d.passport_id ? `forgot ${String(d.passport_id).slice(0, 8)}` : 'forgot a passport',

  'passport.created': () => 'new visitor',

  // Types and names, never values — see the note where this is emitted. "learned
  // email" is the useful sentence; which email is one click away on /people/<id>,
  // behind that module's own permission.
  'passport.identified': (d) => {
    const what = (d.identities || [])
      .map(i => i.name && i.name !== i.type ? `${i.type}/${i.name}` : i.type)
      .filter(Boolean)
    return what.length ? `learned ${what.join(', ')}` : 'learned an identity'
  },

  // Both ids, short — the survivor is who the row is attributed to, so the
  // absorbed one is the piece you can't get from anywhere else on the row.
  'passport.merged': (d) =>
    d.absorbed_id ? `absorbed ${String(d.absorbed_id).slice(0, 8)}` : 'merged two passports',

  'passport.unlinked': () => 'identity removed',

  // No id, deliberately. The counts are what says how much was actually deleted —
  // an erasure that removed 2 rows across 1 table did not do what you think.
  'passport.erased': (d) =>
    d.rows ? `erased ${d.rows} rows across ${d.tables} tables` : 'erased a passport',

  // Attribution is the reason anyone looks at a new session.
  'session.started': (d) => {
    const src = d.utm_source || null
    const campaign = d.utm_campaign || null
    if (src && campaign) return `${src} / ${campaign}`
    if (src) return src
    if (d.referrer) return `ref ${pathOf(d.referrer) || d.referrer}`
    return 'direct'
  },
}

const isPrefix = (key) => key.endsWith('.')

// Normalise a declaration to the object form once, here, so every reader deals
// with one shape instead of re-testing `typeof entry === 'string'`.
const normalise = (entry) =>
  typeof entry === 'string' ? { direction: entry } : (entry || {})

/**
 * Fold core's declarations and every plugin's into one catalog.
 *
 * Later declarations do NOT silently win: a duplicate type is a real conflict
 * (two modules claiming the same event), so it's reported rather than resolved.
 * The first declaration stands, because dropping the second is the smaller lie —
 * whoever emits it is at least classified consistently.
 *
 * @param {Array<{name?: string, events?: object, channels?: string[], detail?: object}>} plugins
 * @param {{ logger?: object }} [opts]
 */
export function build(plugins = [], { logger } = {}) {
  const byType = new Map()      // exact type   → { module, direction, channel }
  const byPrefix = new Map()    // 'mail.'      → same
  const channels = new Set()
  const conflicts = []
  // Namespaces whose channel is PER-ROW rather than fixed — see the exclusion at
  // the end of this function.
  const perRowChannel = new Set()
  // Detail functions, same two-map split so they dispatch by the same rule.
  const detailByType = new Map()
  const detailByPrefix = new Map()
  const orphanDetail = []
  // Detail for an event a plugin does NOT own, scoped to the rows it produced.
  // Keyed `${module} ${type}` — see the note on plugin-scoped detail below.
  const detailByOrigin = new Map()

  const add = (module, key, entry) => {
    const target = isPrefix(key) ? byPrefix : byType
    if (target.has(key)) {
      conflicts.push({ key, first: target.get(key).module, second: module })
      return
    }
    const spec = normalise(entry)
    target.set(key, { module, ...spec })
    // A declared channel joins the filter list; otherwise the type's first
    // segment does — but only for a FIXED channel. A `{ from }` channel is
    // per-row and cannot be enumerated, which is exactly why a module using one
    // also declares `channels`.
    if (typeof spec.channel === 'string') channels.add(spec.channel)
    else if (spec.channel?.from) perRowChannel.add(key.split('.')[0])
    else channels.add(key.split('.')[0])
  }

  const addDetail = (module, key, fn) => {
    if (typeof fn !== 'function') return
    const target = isPrefix(key) ? detailByPrefix : detailByType
    if (target.has(key)) {
      conflicts.push({ key, first: target.get(key).module, second: module, kind: 'detail' })
      return
    }
    target.set(key, { module, fn })
  }

  for (const [key, entry] of Object.entries(CORE_EVENTS)) add('core', key, entry)
  for (const [key, fn] of Object.entries(CORE_DETAIL)) addDetail('core', key, fn)
  for (const c of CORE_CHANNELS) channels.add(c)

  // Pass 1: every plugin's own events, so pass 2 can tell "I own this type" from
  // "somebody else owns it and I only produced some of its rows".
  for (const plugin of plugins) {
    if (!plugin?.events) continue
    const module = plugin.name || '(unnamed)'
    for (const [key, entry] of Object.entries(plugin.events)) add(module, key, entry)
    for (const c of plugin.channels || []) channels.add(c)
  }

  // Does ANY module declare an event this detail key could match? Defined after
  // pass 1, so it sees every declaration regardless of plugin order.
  const reachableFromDeclared = (key) => {
    const declaredKeys = [...byType.keys(), ...byPrefix.keys()]
    return declaredKeys.some(t =>
      key.endsWith('.') ? (t.startsWith(key) || key.startsWith(t)) : (t === key || (isPrefix(t) && key.startsWith(t))),
    )
  }

  // Pass 2: detail. A plugin declaring detail for a type IT declared is the
  // ordinary case. Declaring detail for someone else's type is PLUGIN-SCOPED —
  // see below.
  for (const plugin of plugins) {
    if (!plugin?.detail) continue
    const module = plugin.name || '(unnamed)'
    const owns = (key) => Object.keys(plugin.events || {}).some(t =>
      key.endsWith('.') ? (t.startsWith(key) || key.startsWith(t)) : (t === key || (t.endsWith('.') && key.startsWith(t))),
    )
    for (const [key, fn] of Object.entries(plugin.detail)) {
      if (owns(key)) { addDetail(module, key, fn); continue }
      // ── PLUGIN-SCOPED DETAIL ──────────────────────────────────────────────
      //
      // One event type, many authors. `awareness.recorded` is emitted by CORE,
      // but its payload is composed by whichever plugin called awareness.record()
      // — conversions writes `content_id: 'conversion:page_view:<uuid>'` and a
      // preview of its own; engagement writes a content id and the real page
      // text. Core cannot describe both well, and it showed: every conversions
      // row read "conversion · localhost", which names the category and the
      // hostname and tells you neither what happened nor which page.
      //
      // So the row is described by whoever PRODUCED it. The payload already says
      // who that was (`data.plugin`, stamped by the loader), and detail() prefers
      // a function registered against that name. Core's own declaration stays as
      // the fallback for a row from a plugin that declared nothing.
      //
      // This is the same principle as everywhere else in this file — the module
      // that owns the data owns the description — extended to the case where the
      // emitter and the author are different modules.
      //
      // Still checked, though: scoping is for a type SOMEBODY declares. A key
      // matching no declared event anywhere is a typo, not a scoped override, and
      // it must stay loud — `'conversions.'` for an event called `conversion.` is
      // the exact bug that made live's old map untrustworthy, and treating every
      // unmatched key as "scoped" would have quietly reintroduced it.
      if (!reachableFromDeclared(key)) { orphanDetail.push({ key, module }); continue }
      if (typeof fn === 'function') detailByOrigin.set(`${module} ${key}`, { module, fn })
    }
  }

  for (const c of conflicts) {
    logger?.warn?.(
      'event catalog: %s"%s" declared by both %s and %s — keeping %s',
      c.kind === 'detail' ? 'detail for ' : '', c.key, c.first, c.second, c.first,
    )
  }

  // A detail key that no declared event can ever match — the drift the two maps
  // make possible, and the exact failure that made live's old map untrustworthy:
  // a `'conversions.'` branch that never ran looked identical to a correct one.
  //
  // Collected in pass 2 (a key that isn't the plugin's own AND matches nothing
  // anywhere), because that is the only place it can arise: a key a plugin DOES
  // own is reachable by definition. Reported here so one loop owns the warning.
  for (const { key, module } of orphanDetail) {
    logger?.warn?.(
      'event catalog: %s declares detail for "%s" but no declared event can match it',
      module, key,
    )
  }

  // A namespace whose channel is per-row is NOT itself a channel — that's an
  // invariant, not a special case: a module that reports a different channel on
  // every row cannot also be one. `awareness` is the instance. Its events carry
  // the channel they happened on (mail, voip, web…), so the prefix is a type
  // family and nothing else; `awareness.forgotten` declaring no channel would
  // otherwise contribute the segment and put a dead `awareness` option in the
  // filter list. live used to carry a hand-written blacklist for exactly this.
  for (const ns of perRowChannel) channels.delete(ns)

  // Longest first, so an exact-ish prefix beats a broader one and the order of
  // declaration never matters.
  const byLength = (a, b) => b.length - a.length

  return {
    byType,
    byPrefix,
    prefixes: [...byPrefix.keys()].sort(byLength),
    detailByType,
    detailByPrefix,
    detailPrefixes: [...detailByPrefix.keys()].sort(byLength),
    detailByOrigin,
    channels: [...channels].sort(),
    conflicts,
    orphanDetail,

    // ── the enumerable vocabulary ──────────────────────────────────────────
    //
    // Anything that offers event types to a human needs a LIST, and the only
    // list available used to be "types seen in the log" — so the journeys
    // trigger picker could not offer an event until it had already happened.
    // You could not build "when a booking arrives, do X" on a fresh install,
    // because crm.booking had never fired. Same flaw the channel filter had.
    //
    // `types` fixes it for everything declared exactly.
    types: [...byType.keys()].sort(),

    // `families` is the answer for everything that ISN'T predefined. A prefix
    // declaration means "there will be types under here that I cannot list" —
    // crm emits `crm.${kind}` where the kind is the host CRM's vocabulary, and
    // conversions emits `conversion.${name}` where the name is whatever the site
    // invents. Neither can ever be enumerated in advance.
    //
    // Publishing the families rather than pretending they don't exist is what
    // makes that ACTIONABLE: a picker can offer free-text entry under a known
    // prefix instead of a dead end, and it can say WHO owns the namespace. The
    // alternative — waiting for one to occur — is the bug.
    families: [...byPrefix.entries()]
      .map(([prefix, spec]) => ({ prefix, module: spec.module, direction: typeof spec.direction === 'string' ? spec.direction : null }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix)),
  }
}

// Read `data.direction` / `data.channel` out of a payload. Dotted, so a
// declaration can point anywhere in the payload without this needing to know
// the shape of any particular one.
function dig(payload, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), payload)
}

/** The declaration for a type, or null if nobody declared it. */
export function lookup(catalog, type) {
  if (!catalog) return null
  const t = String(type || '')
  if (catalog.byType.has(t)) return catalog.byType.get(t)
  for (const p of catalog.prefixes) {
    if (t === p || t.startsWith(p)) return catalog.byPrefix.get(p)
  }
  return null
}

/**
 * Which way was this flowing?
 * @returns {'in'|'out'|'internal'|'unknown'}
 */
export function direction(catalog, type, payload) {
  const spec = lookup(catalog, type)
  if (!spec) return 'unknown'
  const d = spec.direction
  if (typeof d === 'string') return d
  if (d?.from) {
    const raw = dig(payload, d.from)
    // An unrecognised value is NOT guessed. The emitter said something this
    // declaration doesn't cover, and `unknown` is the honest rendering of that.
    return d.map ? (d.map[raw] ?? 'unknown') : (raw ?? 'unknown')
  }
  return 'unknown'
}

/**
 * Which channel does this row belong to? Falls back to the type's first
 * segment for an undeclared event, so an unclassified row still lands
 * somewhere sensible in the per-channel breakdown.
 */
export function channel(catalog, type, payload) {
  const spec = lookup(catalog, type)
  const c = spec?.channel
  if (typeof c === 'string') return c
  if (c?.from) {
    const raw = dig(payload, c.from)
    if (raw) return raw
  }
  return String(type || '').split('.')[0]
}

/**
 * What this event was ABOUT, in one line — or null when the emitting module has
 * nothing useful to say. Null is a real answer: "—" in the UI is honest, an
 * invented summary is worse than no summary.
 *
 * `trim` is applied here rather than by every declaration, so the length cap
 * lives in one place and a plugin can't forget it.
 *
 * A declaration that THROWS yields null and a warning rather than taking the
 * request with it. These functions run over arbitrary historical payloads —
 * including rows written before a field existed — and one feed row failing to
 * describe itself must never be the thing that breaks the board.
 */
export function detail(catalog, type, payload, { logger } = {}) {
  if (!catalog) return null
  const t = String(type || '')
  const d = body(payload)

  // Whoever PRODUCED this row describes it, when they said so. `data.plugin` is
  // stamped by the plugin loader on every awareness.record(), so a shared event
  // type reads in the vocabulary of the module that actually authored the row
  // rather than in the emitter's lowest common denominator.
  const hit = (d?.plugin && catalog.detailByOrigin?.get(`${d.plugin} ${t}`))
    ?? catalog.detailByType?.get(t)
    ?? catalog.detailPrefixes?.map(p => (t === p || t.startsWith(p) ? catalog.detailByPrefix.get(p) : null)).find(Boolean)
  if (!hit) return null
  try {
    return trim(hit.fn(d, t))
  } catch (err) {
    logger?.warn?.({ err, module: hit.module, type: t }, 'event catalog: detail() threw — showing no detail')
    return null
  }
}
