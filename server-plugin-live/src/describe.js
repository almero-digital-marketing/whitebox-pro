// What an event was ABOUT, in one short line.
//
// A feed of type names answers "something happened" and nothing more: twenty
// rows reading `awareness.recorded` are indistinguishable, so the operator has
// to open each one to learn anything. The type is the verb; this is the object —
// who it reached, which video was watched, which network rejected us.
//
// Rules, learned the hard way from the rest of this plugin:
//
//   · Never guess a shape. Every field read here is one a producer actually
//     writes (mail/sms notify with their outbox ROW, voip with its call row,
//     conversions/adnetwork/session with purpose-built payloads).
//   · Return null rather than something vague. "—" in the UI is honest; an
//     invented summary is worse than no summary.
//   · Truncate, never wrap. This lands in a single-line feed row.
//   · No PII beyond what the module already shows. Recipients are already
//     visible in mail/sms's own surfaces, but text CONTENT is redacted upstream
//     in awareness and must not be reconstituted here — hence source/kind for
//     engagement rather than the excerpt itself.

// A SAFETY cap, not a layout decision — the same mistake as guessing a bar count:
// only the browser knows how wide the detail column actually is. Truncating to a
// display width here clipped text with half the row still empty, and the ellipsis
// was the server's guess rather than the real boundary. So send the whole thing
// and let `text-overflow: ellipsis` cut it at the true edge; this bound exists
// only so a pathological payload can't put a kilobyte into every feed row.
// Matches core's PREVIEW_CHARS (160) with room for the "<kind> · " prefix.
const MAX = 200

const trim = (s) => {
  if (s === null || s === undefined) return null
  const str = String(s).trim()
  if (!str) return null
  return str.length > MAX ? `${str.slice(0, MAX - 1)}…` : str
}

// Payloads are nested one level: notify(type, { type, data }) — so the useful
// fields live at payload.data. Tolerates a bare payload too.
const body = (payload) => payload?.data ?? payload ?? {}

const money = (value, currency) =>
  value === null || value === undefined || value === '' ? null : `${value}${currency ? ` ${currency}` : ''}`

// Percent-decoded for display. A non-ASCII path arrives encoded from the browser
// — gpoint.bg's routes are Bulgarian, so `/запазване-час` reaches us as
// `/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81`,
// which is both unreadable and long enough to crowd out the rest of the row.
//
// Decoding is DISPLAY-only: nothing here is stored, and nothing downstream
// matches on it. decodeURIComponent throws on a malformed sequence (a lone `%`,
// a truncated escape), and a feed row must never be the thing that breaks — so a
// failure keeps the raw string rather than losing the whole detail.
function decodePath(s) {
  if (!s || !s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// A url reduced to something that fits: path only, query dropped.
function pathOf(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    return trim(decodePath(u.pathname === '/' ? u.hostname : u.pathname))
  } catch {
    return trim(decodePath(url))
  }
}

// Engagement lands in awareness with `source` carrying WHAT was consumed
// ('video' | 'text' | 'image' | 'section' | 'link' | …), which is the only place
// that distinction survives — there is no separate engagement.* event type, on
// purpose: it would double-count one touch as two events in the traffic totals.
function describeAwareness(d) {
  const what = d.source || d.channel || null

  // Prefer the actual (already-redacted) text. "text · verify-text-1" told an
  // operator nothing — an internal identifier where the sentence the person
  // actually read was available. Core now carries a bounded excerpt for exactly
  // this, so show the content and fall back to the identifier only when there
  // isn't any (a conversion, a voip call — nothing was "read").
  const preview = trim(collapse(d.preview))

  // …but producers prefix their own label onto it. Conversions compose
  // "Conversion: view content — <page content> — …" so the touch is searchable in
  // awareness; that first segment restates the event type one column to the left
  // and, at an 80-char budget, pushes the part you actually want off the end.
  // Drop the echo, keep the content.
  const meaningful = stripTypeEcho(preview, d)
  if (meaningful) {
    if (what) return trim(`${what} · ${meaningful}`)
    return trim(meaningful)
  }

  // content_id is the paired fallback for content_url and can carry the same
  // encoding (it's often derived from the slug), so it decodes the same way.
  const where = pathOf(d.content_url) || trim(decodePath(d.content_id))
  if (what && where) return trim(`${what} · ${where}`)
  return trim(what) || where
}

// Real page text arrives with newlines and runs of whitespace from the DOM;
// a feed row is one line, so flatten before truncating.
const collapse = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s)

// Compared on letters/digits only (Latin + Cyrillic), so punctuation, case and
// word separators can't hide a match.
const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, '')

// Producers compose awareness text as "<their own label> — <the real content>".
// Conversions write "Conversion: view content — Защо не използваме…" for a
// `conversion.view_content` event: the first segment restates the type column,
// so it's pure noise here AND it consumes the row's width before the content
// gets a chance. Strip that leading echo; keep everything after it.
//
// Returns null when nothing but the echo remains — then the caller falls back to
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

export function describe(type, payload) {
  const d = body(payload)
  const t = String(type || '')

  if (t === 'awareness.recorded') return describeAwareness(d)
  if (t === 'awareness.forgotten') return trim(d.passport_id ? `forgot ${String(d.passport_id).slice(0, 8)}` : 'forgot a passport')

  if (t === 'passport.created') return 'new visitor'
  if (t === 'session.started') {
    // Attribution is the reason anyone looks at a new session.
    const src = d.utm_source || null
    const campaign = d.utm_campaign || null
    if (src && campaign) return trim(`${src} / ${campaign}`)
    if (src) return trim(src)
    if (d.referrer) return trim(`ref ${pathOf(d.referrer) || d.referrer}`)
    return 'direct'
  }

  if (t.startsWith('conversion.')) {
    return money(d.value, d.currency) || pathOf(d.url) || trim(d.kind)
  }

  if (t.startsWith('adnetwork.')) {
    // The failure reason is the entire point of the event when there is one.
    const head = [d.network, d.event].filter(Boolean).join(' · ')
    return trim(d.error ? `${head} — ${d.error}` : head)
  }

  if (t.startsWith('mail.bulk.')) {
    const n = d.accepted ?? d.cancelled ?? null
    return trim(n !== null ? `${n} recipients` : d.batch_id ? `batch ${d.batch_id}` : null)
  }
  if (t.startsWith('mail.')) {
    const who = d.to || null
    const why = d.failure_reason || null
    if (who && why) return trim(`${who} — ${why}`)
    return trim(who ? (d.subject ? `${who} · ${d.subject}` : who) : d.subject)
  }

  if (t.startsWith('sms.bulk.')) {
    const n = d.accepted ?? d.cancelled ?? null
    return trim(n !== null ? `${n} recipients` : d.batch_id ? `batch ${d.batch_id}` : null)
  }
  if (t.startsWith('sms.')) {
    // Recipient and outcome only — never the message text. The event registry
    // strips `body` at the write (it's message content, and the log crosses
    // permission boundaries), so reading it here would make a BACKFILLED row
    // describe itself differently from the same event arriving live off the
    // firehose — the one thing computing detail in a single place is meant to
    // prevent. Segment count is the useful non-sensitive extra.
    const who = d.to || d.phone || null
    const why = d.failure_reason || d.reason || d.error_message || null
    if (who && why) return trim(`${who} — ${why}`)
    if (who && d.segments) return trim(`${who} · ${d.segments} segment${d.segments === 1 ? '' : 's'}`)
    return trim(who)
  }

  if (t.startsWith('voip.')) {
    // caller → the tracked line it rang, which is what attributes the call.
    const from = d.caller || null
    const line = d.line || d.destination || null
    const tag = d.tag ? ` (${d.tag})` : ''
    if (from && line) return trim(`${from} → ${line}${tag}`)
    return trim(from || line)
  }

  if (t.startsWith('crm.')) {
    const bits = [d.kind, d.external_id, d.status].filter(Boolean).join(' · ')
    return trim(bits || d.source)
  }

  // Orchestration: the name is what identifies which one ran.
  if (t.startsWith('journey.') || t.startsWith('journeys.') || t.startsWith('campaigns.') || t.startsWith('audiences.')) {
    return trim(d.name || d.title || d.slug || d.id)
  }

  return null
}
