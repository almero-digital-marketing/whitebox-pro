import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger })
})
afterAll(async () => { await db.destroy() })

beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

// A fact needs a real passport row — the FK is what keeps a fact from
// referencing somebody who does not exist.
async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}

// A `stat` widget asks "how many?" and was answered with the whole cohort —
// 153,245 passport ids, 9.4 MB, for a number already sitting in `count`. Enough
// to exceed an MCP client's budget outright, and pure waste over REST.
describe('selector: the `count` projection', () => {
  const seed = async (n, value) => {
    const ids = []
    for (let i = 0; i < n; i++) {
      const id = await newPassport()
      await facts.record({ passport_id: id, key: 'tier', value, source: 'test' })
      ids.push(id)
    }
    return ids
  }

  it('returns the number and NOT the ids', async () => {
    const tier = `t${Date.now()}`
    await seed(3, tier)
    const res = await selector.resolve({ filter: { fact: { tier: { eq: tier } } } }, { projection: 'count' })
    expect(res.count).toBe(3)
    expect(res.passports).toBeUndefined()
  })

  it('counts exactly what `people` would have returned', async () => {
    const tier = `t${Date.now()}b`
    await seed(4, tier)
    const sel = { filter: { fact: { tier: { eq: tier } } } }
    const people = await selector.resolve(sel, { projection: 'people' })
    const count = await selector.resolve(sel, { projection: 'count' })
    expect(count.count).toBe(people.count)
    expect(count.count).toBe(people.passports.length)
  })

  // `people` is the funnel anchor — matched_at per passport must survive.
  it('leaves the people projection exactly as it was', async () => {
    const tier = `t${Date.now()}c`
    await seed(2, tier)
    const res = await selector.resolve({ filter: { fact: { tier: { eq: tier } } } }, { projection: 'people' })
    expect(res.passports).toHaveLength(2)
    expect(res.passports[0]).toHaveProperty('matched_at')
  })

  it('still rejects a projection it does not implement', async () => {
    await expect(selector.resolve({}, { projection: 'nonsense' })).rejects.toThrow(/not implemented/)
  })
})
