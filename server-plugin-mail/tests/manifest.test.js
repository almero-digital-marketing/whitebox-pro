import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { mail } from '../src/index.js'

manifestSuite({
  plugin: mail({}),
  srcDir: new URL('../src', import.meta.url),
  expectEmitted: ['mail.sent', 'mail.received', 'mail.bulk.queued'],
  // tracking.js emits `mail.${status}`, but the vocabulary is OURS and closed —
  // it's exactly the values in its statusMap. Enumerated rather than covered by a
  // `'mail.'` prefix so that adding a sixth status has to be a decision: a prefix
  // would classify it silently, whatever direction it actually flows.
  //
  // Note what is NOT here: `clicked` (statusMap maps it to 'engaged') and
  // `unsubscribed` (a suppression reason, never an event). live's map declared
  // both, and both were dead.
  dynamicTypes: ['mail.delivered', 'mail.opened', 'mail.engaged', 'mail.bounced', 'mail.complained'],
})

describe('mail event detail', () => {
  const single = mail({}).detail['mail.']
  const bulk = mail({}).detail['mail.bulk.']

  it('leads with the recipient, adding the subject when there is one', () => {
    expect(single({ to: 'a@b.c' })).toBe('a@b.c')
    expect(single({ to: 'a@b.c', subject: 'Your booking' })).toBe('a@b.c · Your booking')
  })

  // The reason is the entire point of the row when a send failed.
  it('puts the failure reason in the line, in place of the subject', () => {
    expect(single({ to: 'a@b.c', subject: 'Ignored', failure_reason: 'mailbox full' }))
      .toBe('a@b.c — mailbox full')
  })

  it('falls back to the subject when there is no recipient', () => {
    expect(single({ subject: 'Only a subject' })).toBe('Only a subject')
    expect(single({})).toBeNull()
  })

  it('describes a batch by its size, not its recipients', () => {
    expect(bulk({ accepted: 240 })).toBe('240 recipients')
    expect(bulk({ cancelled: 12 })).toBe('12 recipients')
    expect(bulk({ batch_id: 'b-9' })).toBe('batch b-9')
    expect(bulk({})).toBeNull()
  })

  // WHICH batch, not just how big. Two batches in flight read identically
  // otherwise, and "240 recipients" twice tells you nothing about either.
  it('names the batch alongside the size', () => {
    expect(bulk({ accepted: 240, batch_id: 'b9c1d2e3f4g5' })).toBe('240 recipients · batch b9c1d2e3')
  })

  // 0 is a real batch size and must survive the ?? chain rather than falling
  // through to the batch id alone.
  it('reports an empty batch as empty', () => {
    expect(bulk({ accepted: 0, batch_id: 'b-9' })).toBe('0 recipients · batch b-9')
  })
})
