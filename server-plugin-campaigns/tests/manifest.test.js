import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { campaigns } from '../src/index.js'

manifestSuite({
  plugin: campaigns({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['campaigns.activated', 'campaigns.sent'],
})

describe('campaigns event detail', () => {
  const d = campaigns({}).detail['campaigns.']

  // For orchestration the name is the whole answer: which one ran.
  it('names the campaign', () => {
    expect(d({ name: 'July promo' })).toBe('July promo')
    expect(d({ title: 'Fallback title' })).toBe('Fallback title')
    expect(d({ id: 'cmp-1' })).toBe('cmp-1')
    expect(d({})).toBeNull()
  })
})

// `campaigns.sent` is deliberately `internal`, not `out`. A campaign never
// delivers anything itself — it hands the send to mail or sms, and THEY emit the
// outbound events, one per message. Counting this as outbound too would count
// every send twice and make the figure impossible to reconcile against the outbox.
describe('campaigns direction', () => {
  it('keeps a campaign send out of the outbound count', () => {
    expect(campaigns({}).events['campaigns.sent']).toBe('internal')
  })
})
