const TABLE = 'whitebox_voip_calls'

let db

export function init(deps) {
  db = deps.db
}

export async function ring({ vaultId, passportId, sessionId, caller, line, tag, date }) {
  await db(TABLE).insert({
    vault_id: vaultId,
    passport_id: passportId,
    session_id: sessionId,
    caller,
    line,
    tag,
    status: 'ringing',
    started_at: date,
  })
}

export async function pick({ vaultId, destination, date }) {
  await db(TABLE).where({ vault_id: vaultId }).update({
    destination,
    status: 'active',
    picked_at: date,
  })
}

export async function end({ vaultId, duration, record, link, transcription, date }) {
  const call = await db(TABLE).where({ vault_id: vaultId }).first()
  if (!call) return null
  await db(TABLE).where({ vault_id: vaultId }).update({
    duration,
    record,
    link,
    transcription,
    status: call.picked_at ? 'ended' : 'missed',
    ended_at: date,
  })
  const updated = await db(TABLE).where({ vault_id: vaultId }).first()
  return updated
}

// Windowed counts by status, shaped like mail/sms `stats()` so the monitoring
// view can render all three channels through one code path.
//
// `missed` is the point of this card: calls.end() writes 'missed' when a call
// ended without ever being picked up, and that is the one voip number an operator
// would act on. `ringing`/`active` are live right now rather than historical.
export async function stats({ since } = {}) {
  const q = db(TABLE).select('status').count('* as n').groupBy('status')
  if (since) q.where('started_at', '>=', since instanceof Date ? since : new Date(since))
  const rows = await q
  const by = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]))
  const ringing = by.ringing || 0
  const active = by.active || 0
  const ended = by.ended || 0
  const missed = by.missed || 0
  return { total: ringing + active + ended + missed, ringing, active, ended, missed }
}

// Self-describing health (see docs/10-plugin-status.md). Calls AND the number
// pool in one answer, because they're one question: "is call tracking working".
//
// The pool numbers carry `of` — the ratio is the point, since "3 of 8 held" says
// what "3" cannot — and `live`, because they are NOT windowed. That distinction is
// not cosmetic: the four counts above are a SQL aggregate over `started_at`, while
// the pool is a read of this process's assignment map. There is no history of it to
// query, and it does not survive a restart or extend to a second instance, so
// reporting it under a window selector would be a lie about what it is.
export async function status({ since, pool } = {}) {
  const s = await stats({ since })
  const p = pool ? pool() : null
  return {
    label: 'voip',
    metrics: [
      { key: 'ringing', value: s.ringing,
        description: 'Calls that started in this window and are still ringing — nobody has picked up yet.' },
      { key: 'active', value: s.active,
        description: 'Calls connected and talking right now, counted from those that started in this window.' },
      { key: 'ended', value: s.ended,
        description: 'Calls that connected and finished normally. This is the one that means call tracking worked end to end.' },
      // Someone reached out and nobody answered — a failure in the same sense as
      // a bounced email, and the one voip number an operator would act on.
      { key: 'missed', value: s.missed, severity: 'bad',
        description: 'Somebody called a tracking number and nobody answered. A failure in the same sense as a bounced email: the visitor made contact and got nothing.' },
      ...(p ? p.tags.map(t => ({
        key: t.tag,
        value: t.assigned,
        of: t.total,
        live: true,
        description: `Tracking numbers in the "${t.tag}" pool currently held by a visitor, of ${t.total} configured. Read from this process's assignment map, so it is not windowed, does not survive a restart, and reflects only the instance that answered. When the pool is full the next visitor is shown the untracked fallback number and their call cannot be attributed.`,
        // This plugin's own judgement, not `used === total`: a full pool is only a
        // problem once somebody is actually waiting on it.
        ...(t.exhausted ? { severity: 'bad' } : {}),
      })) : []),
    ],
    note: p?.waiting
      ? `${p.waiting} visitor${p.waiting === 1 ? '' : 's'} waiting for a number — they were shown the untracked fallback`
      : null,
  }
}

export async function find(vaultId) {
  const call = await db(TABLE).where({ vault_id: vaultId }).first()
  return call
}
