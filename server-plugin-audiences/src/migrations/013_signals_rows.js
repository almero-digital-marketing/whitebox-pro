// `whitebox_audience_identities` → `whitebox_audience_signals`, and one jsonb
// blob per passport → one row per signal.
//
// The name was wrong: the table holds no identities. It holds ad-network
// browser signals (fbp, fbc, gclid, ttclid, ga_client_id…) captured by the
// client shim. Sitting next to core's `whitebox_passports_identities`, which
// holds every actual identity, the old name actively misled. The public API
// already said "signals" (service.js / identity.js both export `saveSignals`);
// this finishes a rename that was started and left half-done at the storage
// layer.
//
// The shape was wrong too. `passport_id` was the PRIMARY KEY, and core's
// `passports.merge()` re-points references with a blind
// `UPDATE … SET passport_id = survivor` on the stated assumption that
// "passport_id is never part of a unique constraint outside identities" — so
// merging two passports that BOTH had signals violated the PK and threw.
//
// One row per signal fixes that (the conflict becomes an ordinary row-level
// dedupe, the same one merge already does for weak identity types) and buys:
//   · per-signal expiry — ad click ids have real TTLs; a per-row last_seen_at
//     lets them age out individually, like core's DEFAULT_LIFESPANS does per
//     identity type. A single blob can only expire wholesale.
//   · no blob rewrite — capturing one signal upserts one row.
//   · queryable — "who has a gclid" is an index hit, not a jsonb scan.
//   · ON DELETE CASCADE — a right-to-be-forgotten erase reaches it for free,
//     which docs/08-consent-privacy.md already required and nothing delivered.
const OLD = 'whitebox_audience_identities'
const NEW = 'whitebox_audience_signals'

export async function up(knex) {
  await knex.schema.createTable(NEW, (t) => {
    t.increments('id')
    t.uuid('passport_id').notNullable()
      .references('id').inTable('whitebox_passports').onDelete('CASCADE')
    t.string('name', 64).notNullable()      // fbp, fbc, gclid, ttclid, ga_client_id, …
    t.string('value', 512).notNullable()
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.unique(['passport_id', 'name'])       // one current value per signal per person
    t.index('passport_id')
    t.index('name')
  })

  const had = await knex.schema.hasTable(OLD)
  if (had) {
    // Expand every jsonb key into its own row. Written to run against real data
    // (dev is empty; a deployed instance is not). Skips:
    //   · null/object values — a signal is a scalar identifier, and the target
    //     column is a string; anything else was never usable by an adapter.
    //   · rows whose passport is gone — the new FK would reject them.
    // `updated_at` becomes every row's last_seen_at: it's the only timestamp
    // the blob carried, so it's the truest thing available per signal.
    await knex.raw(`
      INSERT INTO ${NEW} (passport_id, name, value, created_at, last_seen_at)
      SELECT i.passport_id, s.key, s.value #>> '{}',
             COALESCE(i.updated_at, now()), COALESCE(i.updated_at, now())
      FROM ${OLD} i
      CROSS JOIN LATERAL jsonb_each(i.signals) AS s(key, value)
      WHERE jsonb_typeof(s.value) NOT IN ('null', 'object', 'array')
        AND s.value #>> '{}' IS NOT NULL
        AND s.value #>> '{}' <> ''
        AND EXISTS (SELECT 1 FROM whitebox_passports p WHERE p.id = i.passport_id)
      ON CONFLICT (passport_id, name) DO NOTHING
    `)
    await knex.schema.dropTable(OLD)
  }
}

export async function down(knex) {
  await knex.schema.createTable(OLD, (t) => {
    t.uuid('passport_id').primary()
    t.jsonb('signals').notNullable().defaultTo('{}')
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
  })
  // Collapse the rows back into one blob per passport.
  await knex.raw(`
    INSERT INTO ${OLD} (passport_id, signals, updated_at)
    SELECT passport_id, jsonb_object_agg(name, to_jsonb(value)), max(last_seen_at)
    FROM ${NEW} GROUP BY passport_id
  `)
  await knex.schema.dropTable(NEW)
}
