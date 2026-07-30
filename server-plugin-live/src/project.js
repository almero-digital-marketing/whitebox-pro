// What a BROWSER is allowed to receive from the event log.
//
// The event registry stores payloads verbatim, on purpose: it's the durable
// record, the same payload already goes to webhook subscribers and every
// events.subscribe() consumer, and core has no business deciding which of a
// producer's fields are sensitive. Deciding what leaves for a client is this
// plugin's job, because this plugin owns the transport.
//
// Why it matters here specifically: producers pass whatever is convenient, and
// several pass a whole DB ROW —
//   · mail   → its outbox row: `html`, `text`, i.e. the entire email body
//   · voip   → its call row: `transcription`, the full call transcript
//   · sms    → its `body`, the message text
// …and /events/log is gated by ONE permission. Serving those verbatim let anyone
// who could read the event log read message bodies and call transcripts without
// holding mail's or voip's own permissions. A monitoring view needs to know that
// an email failed, never what it said.
//
// Note the feed itself goes further: `toFeedRow` carries no payload at all, only
// a distilled one-line `detail`. This projection is for the raw-log route, which
// exists so an operator can inspect an event — so it keeps the operational
// fields and drops the content.

// Content and credential-shaped keys. Matched case-insensitively at any depth,
// because a producer may nest a provider response.
const DROP_KEYS = new Set([
  // message / telephony content
  'html', 'text', 'body', 'message', 'transcription', 'transcript',
  'attachments', 'media', 'failure_log',
  // credential-shaped — no producer should put one in a payload, and if one ever
  // does, this is the line that stops it reaching a browser
  'password', 'secret', 'token', 'access_token', 'refresh_token',
  'authorization', 'api_key', 'apikey', 'signature',
])

// `preview` is deliberately KEPT: it's awareness's own bounded (160-char),
// PII-redacted excerpt, added precisely so an observer can say what content a
// touch was about without anyone shipping the raw text. Dropping it would blank
// the feed's detail column and push callers back to reading `text` — worse on
// both counts.

// A bound for a payload that is large without any single key looking like
// content (a provider response blob, a long array). Reported as a marker rather
// than silently truncated JSON, so a reader can tell "small event" from "we cut
// this".
const MAX_BYTES = 4096
const MAX_ARRAY = 50
const MAX_DEPTH = 5

function strip(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(v => strip(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k.toLowerCase())) continue
    out[k] = strip(v, depth + 1)
  }
  return out
}

/** One event-log row, projected for a client. */
export function projectRow(row) {
  const safe = strip(row?.data ?? null)
  const encoded = JSON.stringify(safe ?? null)
  const data = encoded && encoded.length > MAX_BYTES
    ? {
        type: safe?.type ?? row?.type ?? null,
        data: {
          _truncated: true,
          _original_bytes: encoded.length,
          // attribution survives truncation — a huge event must stay findable
          passport_id: row?.data?.data?.passport_id ?? row?.passport_id ?? null,
        },
      }
    : safe

  return {
    id: row?.id ?? null,
    type: row?.type ?? null,
    occurred_at: row?.occurred_at ?? null,
    passport_id: row?.passport_id ?? null,
    data,
  }
}

export const projectRows = (rows) => (Array.isArray(rows) ? rows.map(projectRow) : [])
