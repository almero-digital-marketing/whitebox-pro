// whitebox_facts_current — the current row per (passport_id, key), maintained by
// the database rather than by the application.
//
// WHY A PROJECTION
//
// "The current value of this fact" is derived, in this codebase, by nine separate
// queries: seven in facts/store.js and two in selector/metric.js, each writing some
// form of
//
//     DISTINCT ON (passport_id) … ORDER BY passport_id, observed_at DESC, id DESC
//
// Every one of them re-derives the same answer, and each carries the same tiebreak
// rule in its own ORDER BY. That went wrong exactly as duplication does: store.js
// omitted `id`, metric.js included it, and on live data 38 (passport, key) pairs
// hold different values at their newest instant — so the fact PREDICATE and the fact
// BUCKET could disagree about the same customer, non-deterministically, because
// DISTINCT ON with an incomplete ORDER BY may resolve differently between plans.
//
// It is also structurally slow and getting slower. The log is append-heavy: newly
// written pages are not all-visible until vacuumed, so an Index Only Scan keeps
// falling back to heap fetches. Measured on GPoint at 7.36M rows —
// 89.7% all-visible, 26,486 heap fetches, 5.4s to read the current value of ONE key
// across 111,322 passports. A vacuum takes that to ~2.9s and then it drifts back,
// because the drift is what an append-only table does.
//
// This table is 2.49M rows against the log's 7.42M (33.5%), is updated in place
// rather than appended to, and answers the same question by primary key.
//
// WHY TRIGGERS, NOT APPLICATION CODE
//
// The projection's one real risk is drift, and drift is silent. Maintaining it in
// record()/recordBatch()/recordMany() would leave every other writer to remember:
// merge() re-points rows across passports, erase() deletes them for GDPR, and any
// migration or hand-run UPDATE touches the log directly. Each is a chance to
// desynchronise a cache whose failure mode is a confidently wrong number.
//
// A trigger cannot be bypassed. It runs for merge, for erase, for a psql session at
// 2am, inside whatever transaction the writer already has, or not at all if that
// transaction rolls back.
//
// STATEMENT-level with transition tables, not row-level: recordBatch/recordMany
// write thousands of rows in one statement, and a per-row trigger would turn one
// insert into thousands of upserts.
//
// This migration only CREATES and BACKFILLS the projection. No read is switched to
// it here — that is a separate change, so the projection can be verified against the
// log on real data first (facts.verifyCurrent()).

const T = 'whitebox_facts_current'

export const up = async knex => {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${T} (
      passport_id  uuid                     NOT NULL REFERENCES whitebox_passports(id) ON DELETE CASCADE,
      key          varchar(128)             NOT NULL,
      fact_id      bigint                   NOT NULL,
      value        jsonb                    NOT NULL,
      type         varchar(16)              NOT NULL,
      source       varchar(64)              NOT NULL,
      external_id  varchar(256),
      observed_at  timestamptz              NOT NULL,
      -- Mirrored so a projection row IS the log row in every column: record() returns
      -- "what is now current" to its caller, and that row must not be missing fields
      -- depending on whether the write was suppressed.
      recorded_at  timestamptz,
      PRIMARY KEY (passport_id, key)
    )`)

  // The population read — "current value of key K across everyone" — is the one
  // that was 5.4s on the log. INCLUDE (value) so it answers from the index.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${T}_key_passport_idx ON ${T} (key, passport_id) INCLUDE (value)`)

  // ── the winner, defined once ───────────────────────────────────────────────
  //
  // (observed_at, id) DESC, both in the same direction: newest wins, and among rows
  // sharing an instant the one written last does. `id` is monotonic per insert, so
  // that reads as "later-known" — and it survives merge(), which RE-POINTS rows
  // rather than re-inserting them, leaving ids untouched.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${T}_apply() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO ${T} (passport_id, key, fact_id, value, type, source, external_id, observed_at, recorded_at)
      SELECT DISTINCT ON (passport_id, key)
             passport_id, key, id, value, type, source, external_id, observed_at, recorded_at
        FROM new_table
       ORDER BY passport_id, key, observed_at DESC, id DESC
      ON CONFLICT (passport_id, key) DO UPDATE SET
             fact_id     = excluded.fact_id,
             value       = excluded.value,
             type        = excluded.type,
             source      = excluded.source,
             external_id = excluded.external_id,
             observed_at = excluded.observed_at,
             recorded_at = excluded.recorded_at
       -- Only if the incoming row really is newer. record() accepts a past
       -- observed_at, so a backfill of March data must not overwrite today's value.
       WHERE (excluded.observed_at, excluded.fact_id)
           > (${T}.observed_at, ${T}.fact_id);
      RETURN NULL;
    END $fn$`)

  // A row leaving, or moving between passports, cannot be applied incrementally —
  // the new winner is whatever else remains for that pair, which may be nothing.
  // So: drop the affected pairs and re-derive them from the log.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${T}_recompute() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      CREATE TEMP TABLE _wbfc_affected ON COMMIT DROP AS
        SELECT DISTINCT passport_id, key FROM affected_rows;

      DELETE FROM ${T} c
       USING _wbfc_affected a
       WHERE c.passport_id = a.passport_id AND c.key = a.key;

      INSERT INTO ${T} (passport_id, key, fact_id, value, type, source, external_id, observed_at, recorded_at)
      SELECT DISTINCT ON (f.passport_id, f.key)
             f.passport_id, f.key, f.id, f.value, f.type, f.source, f.external_id, f.observed_at, f.recorded_at
        FROM whitebox_facts f
        JOIN _wbfc_affected a ON a.passport_id = f.passport_id AND a.key = f.key
       ORDER BY f.passport_id, f.key, f.observed_at DESC, f.id DESC;

      DROP TABLE _wbfc_affected;
      RETURN NULL;
    END $fn$`)

  await knex.raw(`
    CREATE TRIGGER ${T}_ins AFTER INSERT ON whitebox_facts
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT EXECUTE FUNCTION ${T}_apply()`)

  // UPDATE needs both sides: the pair a row left AND the pair it arrived at. merge()
  // re-points passport_id, so one statement can empty one pair and change another.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${T}_upd() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      CREATE TEMP TABLE _wbfc_affected ON COMMIT DROP AS
        SELECT DISTINCT passport_id, key FROM old_table
        UNION
        SELECT DISTINCT passport_id, key FROM new_table;

      DELETE FROM ${T} c
       USING _wbfc_affected a
       WHERE c.passport_id = a.passport_id AND c.key = a.key;

      INSERT INTO ${T} (passport_id, key, fact_id, value, type, source, external_id, observed_at, recorded_at)
      SELECT DISTINCT ON (f.passport_id, f.key)
             f.passport_id, f.key, f.id, f.value, f.type, f.source, f.external_id, f.observed_at, f.recorded_at
        FROM whitebox_facts f
        JOIN _wbfc_affected a ON a.passport_id = f.passport_id AND a.key = f.key
       ORDER BY f.passport_id, f.key, f.observed_at DESC, f.id DESC;

      DROP TABLE _wbfc_affected;
      RETURN NULL;
    END $fn$`)

  await knex.raw(`
    CREATE TRIGGER ${T}_upd AFTER UPDATE ON whitebox_facts
    REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
    FOR EACH STATEMENT EXECUTE FUNCTION ${T}_upd()`)

  await knex.raw(`
    CREATE TRIGGER ${T}_del AFTER DELETE ON whitebox_facts
    REFERENCING OLD TABLE AS affected_rows
    FOR EACH STATEMENT EXECUTE FUNCTION ${T}_recompute()`)

  // ── backfill ──────────────────────────────────────────────────────────────
  // One statement. On GPoint this reads 7.42M rows and writes 2.49M.
  await knex.raw(`
    INSERT INTO ${T} (passport_id, key, fact_id, value, type, source, external_id, observed_at, recorded_at)
    SELECT DISTINCT ON (passport_id, key)
           passport_id, key, id, value, type, source, external_id, observed_at, recorded_at
      FROM whitebox_facts
     ORDER BY passport_id, key, observed_at DESC, id DESC
    ON CONFLICT (passport_id, key) DO NOTHING`)

  await knex.raw(`ANALYZE ${T}`)
}

export const down = async knex => {
  await knex.raw(`DROP TRIGGER IF EXISTS ${T}_ins ON whitebox_facts`)
  await knex.raw(`DROP TRIGGER IF EXISTS ${T}_upd ON whitebox_facts`)
  await knex.raw(`DROP TRIGGER IF EXISTS ${T}_del ON whitebox_facts`)
  await knex.raw(`DROP FUNCTION IF EXISTS ${T}_apply()`)
  await knex.raw(`DROP FUNCTION IF EXISTS ${T}_upd()`)
  await knex.raw(`DROP FUNCTION IF EXISTS ${T}_recompute()`)
  await knex.raw(`DROP TABLE IF EXISTS ${T}`)
}
