// wait steps used to store an unnormalized {minutes,hours,days} breakdown;
// now they store one combined duration_ms (see journeys.js's wait schema —
// the UI's separate Minutes/Hours/Days fields just compose/re-split that
// single value, they don't persist three independent ones). steps.nodes is
// keyed by dynamic node ids (not a fixed shape), so there's no single
// jsonb_set expression that can target "every wait node" — this walks each
// journey's step graph in JS instead, same as any other per-node rewrite
// would have to.

const toMs = (d = {}) => (d.minutes || 0) * 60_000 + (d.hours || 0) * 3_600_000 + (d.days || 0) * 86_400_000

const toParts = ms => {
  let rem = ms
  const days = Math.floor(rem / 86_400_000); rem -= days * 86_400_000
  const hours = Math.floor(rem / 3_600_000); rem -= hours * 3_600_000
  const minutes = Math.floor(rem / 60_000)
  const out = {}
  if (days) out.days = days
  if (hours) out.hours = hours
  if (minutes) out.minutes = minutes
  return out
}

async function rewriteWaitNodes(knex, transform) {
  const rows = await knex('whitebox_journeys').select('id', 'steps')
  for (const row of rows) {
    const steps = row.steps
    if (!steps?.nodes) continue
    let changed = false
    for (const node of Object.values(steps.nodes)) {
      if (node.kind !== 'wait' || !node.config) continue
      const nextConfig = transform(node.config)
      if (nextConfig) { node.config = nextConfig; changed = true }
    }
    if (changed) await knex('whitebox_journeys').where({ id: row.id }).update({ steps: JSON.stringify(steps) })
  }
}

export const up = knex => rewriteWaitNodes(knex, config => {
  if (!config.duration || config.duration_ms != null) return null
  const { duration, ...rest } = config
  return { ...rest, duration_ms: toMs(duration) }
})

export const down = knex => rewriteWaitNodes(knex, config => {
  if (config.duration_ms == null) return null
  const { duration_ms, ...rest } = config
  return { ...rest, duration: toParts(duration_ms) }
})
