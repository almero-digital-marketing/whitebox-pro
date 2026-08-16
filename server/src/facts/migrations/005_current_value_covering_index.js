// The "current value per passport" index — the one every fact breakdown rides on.
//
// 002 created (key, passport_id, observed_at DESC) INCLUDE (value), which serves
// `DISTINCT ON (passport_id) … WHERE key = ? ORDER BY passport_id, observed_at DESC`
// as an Index Only Scan. Adding `id DESC` to that ORDER BY — which is what makes a
// tie on observed_at resolve the same way twice — takes the query off it, because a
// btree can only answer an ordering it actually carries. The plan degrades to a Seq
// Scan plus an external merge sort.
//
// Measured on the GPoint deployment (7.35M rows, 817,700 for the key in question):
//
//     ORDER BY passport_id, observed_at DESC                 2.9s   Index Only Scan
//     ORDER BY passport_id, observed_at DESC, id DESC        8.8s   Seq Scan + disk sort
//     …the same, with this index                             1.8s   Index Only Scan
//
// Faster than the form it replaces, not merely as fast: the index now answers the
// whole ordering, so there is no sort left to do.
//
// It REPLACES 002's index rather than joining it — same leading columns, so it
// serves everything the old one did. On GPoint the old index had also bloated to
// 1534 MB against 667 MB for this one built fresh, so the swap gave back ~870 MB.
//
// CONCURRENTLY, and therefore outside a transaction: this table is large enough that
// an exclusive lock for the build is an outage. knex wraps each migration in a
// transaction by default, which CREATE INDEX CONCURRENTLY cannot run inside — hence
// `config.transaction = false` below.
//
// NOTE none of this matters on a table that has never been vacuumed. An Index Only
// Scan needs the visibility map, and GPoint's facts table sat at 32% all-visible
// (relallvisible 79277 / relpages 245008) with no vacuum or analyze recorded — so
// the planner correctly refused every index here and seq-scanned regardless. VACUUM
// (ANALYZE) took that to 100% and the same query from 11.4s to 2.9s. The index is
// the second win, not the first; autovacuum being reached is the first.

export const config = { transaction: false }

const NEW = 'whitebox_facts_key_passport_observed_id_idx'
const OLD = 'whitebox_facts_key_passport_observed_idx'

export const up = async knex => {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NEW}
       ON whitebox_facts (key, passport_id, observed_at DESC, id DESC) INCLUDE (value)`,
  )
  // Only after the replacement exists, so no query is ever left without one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${OLD}`)
}

export const down = async knex => {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${OLD}
       ON whitebox_facts (key, passport_id, observed_at DESC) INCLUDE (value)`,
  )
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${NEW}`)
}
