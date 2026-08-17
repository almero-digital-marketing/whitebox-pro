// value_count on whitebox_facts_current — how many DISTINCT values a passport holds
// for a key.
//
// A fact is single-valued per passport by design: every read that needs one value
// picks one, and `use` (last/first/max/min) says which. But nothing told a caller a
// choice had been made. On live data `{ first_booked_at: { gte: '2026-01-01' } }`
// returns 16,741 under `last` and 16,155 under `min` — a 586-passport difference on
// "how many clients did we acquire since 1 January", with nothing in the response
// indicating a fork existed.
//
// Detecting that per query would otherwise mean a GROUP BY over the log for the key,
// which is the 5.4s query the projection exists to avoid. Kept here instead, it is a
// filter on a 2.5M-row table.
//
// DISTINCT VALUES, not row count. Row count was the cheaper thing to maintain — it
// can be incremented without looking anything up — and it is unusable: on this data
// `promo_dependency` has 7,174 passports with more than one ROW and 35 with more than
// one VALUE, so 99.5% of its warnings would have been false. booking_online: 46,399
// false. geo_city: 35,933. A warning that is usually wrong is worse than no warning,
// because it teaches people to ignore the ones that are right.
//
// The cost of being correct is that the triggers must RECOMPUTE for the pairs a
// statement touched — an insert cannot know whether the value it carries is new to
// that passport without looking. Scoped to the transition table, so the work is
// proportional to the batch, not to the table.

// Not wrapped in a transaction: the backfill below runs one statement per key so each
// commits independently. Inside knex's default transaction they would all be one
// again, which is the thing that failed.
export const config = { transaction: false }

const T = 'whitebox_facts_current'

// The three trigger functions, written from one definition so `up` and `down` cannot
// disagree about anything except the column. All three RECOMPUTE the pairs a statement
// touched: value_count is not derivable from the incoming rows alone, because whether a
// value is NEW to a passport depends on what that passport already holds.
const COLS = (withCount) =>
  `passport_id, key, fact_id, value, type, source, external_id, observed_at, recorded_at` +
  (withCount ? `, value_count` : ``)

// The distinct-value count comes from a JOINED AGGREGATE, not a window function:
// Postgres has no `count(DISTINCT x) OVER (PARTITION BY …)` — it raises "DISTINCT is
// not implemented for window functions", which broke every insert until the tests
// caught it. Aggregated once per affected pair and joined, so it is computed once per
// output row rather than once per candidate row.
const SELECT = (withCount, join) => `
    SELECT DISTINCT ON (f.passport_id, f.key)
           f.passport_id, f.key, f.id, f.value, f.type, f.source, f.external_id,
           f.observed_at, f.recorded_at` +
  (withCount ? `, vc.n AS value_count` : ``) + `
      FROM whitebox_facts f
      ${join}` +
  (withCount ? `
      JOIN (SELECT f2.passport_id, f2.key, count(DISTINCT f2.value) AS n
              FROM whitebox_facts f2
              JOIN _wbfc_affected a2
                ON a2.passport_id = f2.passport_id AND a2.key = f2.key
             GROUP BY f2.passport_id, f2.key) vc
        ON vc.passport_id = f.passport_id AND vc.key = f.key` : ``) + `
     ORDER BY f.passport_id, f.key, f.observed_at DESC, f.id DESC`

const AFFECTED = {
  [`${T}_apply`]: 'SELECT DISTINCT passport_id, key FROM new_table',
  [`${T}_recompute`]: 'SELECT DISTINCT passport_id, key FROM affected_rows',
  [`${T}_upd`]: `SELECT DISTINCT passport_id, key FROM old_table
                 UNION
                 SELECT DISTINCT passport_id, key FROM new_table`,
}

const writeFunctions = async (knex, withCount) => {
  for (const [fn, affected] of Object.entries(AFFECTED)) {
    await knex.raw(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        CREATE TEMP TABLE _wbfc_affected ON COMMIT DROP AS ${affected};

        DELETE FROM ${T} c USING _wbfc_affected a
         WHERE c.passport_id = a.passport_id AND c.key = a.key;

        INSERT INTO ${T} (${COLS(withCount)})
        ${SELECT(withCount, 'JOIN _wbfc_affected a ON a.passport_id = f.passport_id AND a.key = f.key')};

        DROP TABLE _wbfc_affected;
        RETURN NULL;
      END $fn$`)
  }
}

export const up = async knex => {
  await knex.raw(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS value_count integer NOT NULL DEFAULT 1`)

  // Partial: the interesting rows are the ambiguous ones, a minority for most keys.
  // Indexing all 2.5M to find them would be the wrong shape.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${T}_ambiguous_idx ON ${T} (key, passport_id) WHERE value_count > 1`)

  await writeFunctions(knex, true)

  // ── backfill, ONE KEY AT A TIME ──────────────────────────────────────────
  //
  // As a single statement this is a GROUP BY over all 7.4M log rows plus a 2.5M-row
  // UPDATE inside one transaction, and on production-scale data it does not finish:
  // the first attempt died with "Connection terminated unexpectedly" and rolled back.
  //
  // Per key it is 23 bounded passes, each served by the (key, passport_id, …) index,
  // each committing on its own — so the WAL and the lock footprint stay small and a
  // failure halfway leaves the rest still to do rather than undoing the lot.
  //
  // Safe to re-run: `WHERE c.value_count <> v.n` makes every pass idempotent, and with
  // transaction:false a partial run leaves the migration unrecorded, so knex simply
  // does it again.
  const keys = (await knex('whitebox_facts').distinct('key').pluck('key')).sort()
  for (const key of keys) {
    await knex.raw(`
      UPDATE ${T} c SET value_count = v.n
        FROM (SELECT passport_id, count(DISTINCT value) AS n
                FROM whitebox_facts WHERE key = ? GROUP BY passport_id) v
       WHERE c.key = ? AND v.passport_id = c.passport_id AND c.value_count <> v.n`, [key, key])
  }

  await knex.raw(`ANALYZE ${T}`)
}

export const down = async knex => {
  // Functions first: dropping the column while they still insert into it would leave
  // every write to whitebox_facts failing.
  await writeFunctions(knex, false)
  await knex.raw(`DROP INDEX IF EXISTS ${T}_ambiguous_idx`)
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS value_count`)
}
