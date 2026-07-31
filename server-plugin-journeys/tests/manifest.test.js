import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { journeys } from '../src/index.js'

// Our types are `journey.*` SINGULAR while the plugin is named `journeys`. live
// carried a defensive `'journeys.'` alias that could never match anything, and
// offered `journey` as a channel filter option as a result.
manifestSuite({
  plugin: journeys({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['journey.enrolled', 'journey.completed', 'journey.exited'],
})

// Every journey row used to show a BLANK detail column, and had since the feed
// existed: live described journeys, campaigns and audiences with one shared branch
// reading `name || title || slug || id`, and our payloads carry none of those four
// — they carry `journey_id`, so even the `id` fallback missed. Nobody could see it;
// the branch looked perfectly reasonable and lived in another package.
describe('journeys event detail', () => {
  const d = journeys({}).detail['journey.']

  it('names the journey, which is what an operator recognises', () => {
    expect(d({ journey_id: 'jrn-abcdef123456', journey_name: 'Winback 30d' })).toBe('Winback 30d')
  })

  it('adds the reason when the enrollment ended for one', () => {
    expect(d({ journey_id: 'j', journey_name: 'Welcome', reason: 'goal_met' })).toBe('Welcome — goal_met')
  })

  // `journey.exited` is a manual API/MCP path with no journey loaded, and a DB
  // query for a feed label isn't worth it — so a short id, which at least
  // identifies it, rather than the blank column this used to be.
  it('falls back to a short id when no name was carried', () => {
    expect(d({ journey_id: 'jrn-abcdef123456', reason: 'manual' })).toBe('#jrn-abcd — manual')
    expect(d({ journey_id: 'jrn-abcdef123456' })).toBe('#jrn-abcd')
  })

  it('says nothing rather than something vague', () => {
    expect(d({})).toBeNull()
  })
})

// The other half of that fix: the name has to be IN the payload, or the detail
// function has nothing to read. Both call sites already had the journey loaded, so
// this costs no extra query.
describe('journey_name on the lifecycle events', () => {
  it('is carried by enrolled and completed', async () => {
    const src = await import('node:fs')
    const service = src.readFileSync(new URL('../src/service.js', import.meta.url), 'utf8')
    const executor = src.readFileSync(new URL('../src/executor.js', import.meta.url), 'utf8')
    expect(service).toMatch(/journey\.enrolled[\s\S]{0,200}journey_name/)
    expect(executor).toMatch(/journey\.completed[\s\S]{0,200}journey_name/)
  })
})
