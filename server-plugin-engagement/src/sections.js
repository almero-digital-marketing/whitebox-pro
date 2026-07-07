// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let awareness
let logger

export function init(deps) {
  awareness = deps.awareness
  logger = deps.logger
}

function preview(text, max = 100) {
  const trimmed = (text || '').trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

export async function consume(visitor, msg) {
  if (!msg?.text) return
  await awareness.record({
    passport_id: visitor.passportId,
    session_id: visitor.sessionId,
    ts: msg.ts ? new Date(msg.ts) : new Date(),
    channel: 'web',
    direction: 'exposure',
    source: 'section',
    content_id: msg.id || msg.url || null,
    content_url: msg.url || null,
    text: msg.text,
    dwell_ms: msg.dwell_ms || null,
    meta: msg.meta || null,
  })
    .then(() => logger.info(
      { url: msg.url },
      'Section read: "%s" (%dms): %s',
      msg.id || msg.url, msg.dwell_ms || 0, preview(msg.text),
    ))
    .catch(err => logger.warn({ err }, 'section.consume failed'))
}
