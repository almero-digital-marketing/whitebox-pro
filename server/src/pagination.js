// Consistent pagination for the REST API. Every collection endpoint parses
// `limit` + `offset` the same way (with a per-endpoint cap) and returns the same
// envelope: { data, limit, offset, has_more } (+ `total` when it's cheap to know).
//
// Two ways to build the envelope:
//   • page(rows, p)      — pass limit+1 rows fetched from the DB; the extra row
//                          signals has_more without a separate COUNT query.
//   • pageSlice(all, p)  — when you already hold the full set in memory and its
//                          total (e.g. population's distinct-passport list).

// Parse from a plain object: req.query for GET, req.body for POST.
export function parsePage(source = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = Number(source.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), maxLimit) : defaultLimit
  const rawOffset = Number(source.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

// Build the envelope from a DB fetch of limit+1 rows.
export function page(rows, { limit, offset }) {
  const has_more = rows.length > limit
  return { data: has_more ? rows.slice(0, limit) : rows, limit, offset, has_more }
}

// Build the envelope from a full in-memory set whose total size is known.
export function pageSlice(all, { limit, offset, total = all.length }) {
  return { data: all.slice(offset, offset + limit), limit, offset, total, has_more: offset + limit < total }
}

// A searchable page of one table — what every module's left rail asks for.
//
// Returns `{ total, rows }` rather than the `has_more` envelope above, and the
// extra COUNT is the point: a rail draws a POSITION ("2 of 7"), not a "more"
// arrow, so it needs the real size of the result set. page() exists for the
// endpoints where limit+1 is genuinely cheaper.
//
// The search is a case-insensitive contains over `fields`, ORed. That's the
// whole vocabulary on purpose: these rails search a name, and anything richer
// belongs in a real query builder rather than smuggled into a rail filter.
//
// `query` must be a fresh knex builder — it's cloned for the count and again
// for the rows, so the caller keeps theirs intact.
export async function pagedList(query, { q, fields = [], limit = 25, offset = 0, orderBy = 'created_at', direction = 'desc' } = {}) {
  const term = String(q ?? '').trim()
  const base = term && fields.length
    ? query.where(b => { for (const f of fields) b.orWhere(f, 'ilike', `%${term}%`) })
    : query
  // clearOrder before counting: an ORDER BY on a bare count is wasted work and
  // Postgres rejects it outright when the column isn't in the projection.
  const [{ count }] = await base.clone().clearSelect().clearOrder().count('* as count')
  const rows = await base.clone().orderBy(orderBy, direction)
    .limit(Math.min(Number(limit) || 25, 200))
    .offset(Math.max(0, Number(offset) || 0))
  return { total: Number(count), rows }
}
