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
 * @param {Array<{name?: string, events?: object, channels?: string[]}>} plugins
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

  for (const [key, entry] of Object.entries(CORE_EVENTS)) add('core', key, entry)
  for (const c of CORE_CHANNELS) channels.add(c)

  for (const plugin of plugins) {
    if (!plugin?.events) continue
    const module = plugin.name || '(unnamed)'
    for (const [key, entry] of Object.entries(plugin.events)) add(module, key, entry)
    for (const c of plugin.channels || []) channels.add(c)
  }

  for (const c of conflicts) {
    logger?.warn?.(
      'event catalog: "%s" declared by both %s and %s — keeping %s',
      c.key, c.first, c.second, c.first,
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
  const prefixes = [...byPrefix.keys()].sort((a, b) => b.length - a.length)

  return {
    byType,
    byPrefix,
    prefixes,
    channels: [...channels].sort(),
    conflicts,
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
