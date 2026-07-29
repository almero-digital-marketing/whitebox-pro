// What this journey is FOR. Until now a journey could tell you how many people
// it moved through which steps, but never whether that achieved anything — the
// difference between a builder and a tool you'd keep using.
//
// Nullable on purpose: a goal is optional. A journey without one still reports
// its enrollment funnel; it just can't say whether reaching the end mattered.
//
// Shape (see Goal in journeys.js): { event: [...], window_days: n|null }. Only
// events for now, mirroring the trigger's own discriminated shape so a
// condition-based goal can be added later as a second kind rather than a
// rewrite. Events are the cheap, exact case: the event log records one row per
// occurrence with a timestamp, so "did they do X within N days of enrolling"
// is a join and needs no stored per-enrollment state.
export const up = knex => knex.schema.alterTable('whitebox_journeys', t => {
  t.jsonb('goal').nullable()
})

export const down = knex => knex.schema.alterTable('whitebox_journeys', t => {
  t.dropColumn('goal')
})
