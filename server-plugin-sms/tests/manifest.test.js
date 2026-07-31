import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { sms } from '../src/index.js'

manifestSuite({
  plugin: sms({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['sms.sent', 'sms.received', 'sms.bulk.queued'],
  // status.js emits `sms.${status}` from the provider's normalised vocabulary —
  // closed, and ours to define. Enumerated rather than prefixed so a new status
  // has to be classified deliberately rather than swept up by a wildcard.
  dynamicTypes: ['sms.delivered', 'sms.bounced', 'sms.failed'],
})

describe('sms event detail', () => {
  const single = sms({}).detail['sms.']
  const bulk = sms({}).detail['sms.bulk.']

  it('leads with the recipient and the outcome', () => {
    expect(single({ to: '+359888' })).toBe('+359888')
    expect(single({ to: '+359888', failure_reason: 'blacklisted' })).toBe('+359888 — blacklisted')
    expect(single({ phone: '+359999', error_message: 'no route' })).toBe('+359999 — no route')
  })

  it('adds the segment count, pluralised', () => {
    expect(single({ to: '+359888', segments: 1 })).toBe('+359888 · 1 segment')
    expect(single({ to: '+359888', segments: 3 })).toBe('+359888 · 3 segments')
  })

  // NEVER the message text. The event registry strips `body` at the write (it's
  // message content, and the log crosses permission boundaries), so reading it
  // here would make a backfilled row describe itself differently from the same
  // event arriving live off the firehose.
  it('never puts message content in the line, even when handed some', () => {
    const out = single({ to: '+359888', body: 'Your code is 1234', text: 'Your code is 1234' })
    expect(out).toBe('+359888')
    expect(out).not.toContain('1234')
  })

  it('describes a batch by its size', () => {
    expect(bulk({ accepted: 40 })).toBe('40 recipients')
    expect(bulk({ batch_id: 'b-2' })).toBe('batch b-2')
    expect(bulk({})).toBeNull()
  })
})
