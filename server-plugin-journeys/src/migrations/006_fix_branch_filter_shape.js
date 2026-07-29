// Branch nodes' "by filter" condition has always persisted a flat, WRONG
// shape ({fact: '<key>', op, value}) that never matched the actual selector
// DSL's required nested clause shape ({fact: {<key>: {<op>: <value>}}}) —
// see server/src/selector/filter.js's evalFact, which does
// Object.entries(factObj) expecting exactly one [key, predicate] pair. Every
// existing by-filter branch would throw at real evaluation time via
// executor.js's runBranch -> selector.resolve({filter: cond.filter}).
// steps.nodes is keyed by dynamic node ids (not a fixed shape), so this
// walks each journey's step graph in JS, same as migration 005's
// wait-duration rewrite.

async function rewriteBranchNodes(knex, transform) {
  const rows = await knex('whitebox_journeys').select('id', 'steps')
  for (const row of rows) {
    const steps = row.steps
    if (!steps?.nodes) continue
    let changed = false
    for (const node of Object.values(steps.nodes)) {
      if (node.kind !== 'branch' || !node.config?.condition?.filter) continue
      const nextFilter = transform(node.config.condition.filter)
      if (nextFilter) { node.config.condition.filter = nextFilter; changed = true }
    }
    if (changed) await knex('whitebox_journeys').where({ id: row.id }).update({ steps: JSON.stringify(steps) })
  }
}

export const up = knex => rewriteBranchNodes(knex, filter => {
  // only the broken flat shape has `fact` as a string; the correct nested shape has it as an object
  if (typeof filter.fact !== 'string') return null
  return { fact: { [filter.fact]: { [filter.op]: filter.value } } }
})

export const down = knex => rewriteBranchNodes(knex, filter => {
  if (typeof filter.fact !== 'object' || filter.fact === null) return null
  const keys = Object.keys(filter.fact)
  if (keys.length !== 1) return null   // can't losslessly flatten a multi-key/combinator filter — the old shape never supported that
  const key = keys[0]
  const ops = Object.keys(filter.fact[key])
  if (ops.length !== 1) return null
  const op = ops[0]
  return { fact: key, op, value: filter.fact[key][op] }
})
