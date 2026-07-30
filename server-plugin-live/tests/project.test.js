import { describe, it, expect } from 'vitest'
import { projectRow, projectRows } from '../src/project.js'

// The registry stores payloads VERBATIM on purpose — it's the durable record,
// and the same payload already goes to webhooks and every events.subscribe()
// consumer (journeys' triggers read the bus, not the table). Deciding what a
// BROWSER may receive is this plugin's job, because it owns the transport.
const row = (data, extra = {}) => ({
  id: 'e1', type: 'mail.sent', occurred_at: '2026-01-01T00:00:00.000Z',
  passport_id: 'p1', data: { type: 'mail.sent', data }, ...extra,
})

describe('projectRow()', () => {
  it('drops the email body, keeps the operational fields', () => {
    const out = projectRow(row({
      id: 42, to: 'a@b.com', subject: 'Hello', status: 'sent', passport_id: 'p1',
      html: '<p>the entire email</p>', text: 'the entire email',
    }))
    expect(out.data.data).toMatchObject({ id: 42, to: 'a@b.com', subject: 'Hello', status: 'sent' })
    expect(out.data.data.html).toBeUndefined()
    expect(out.data.data.text).toBeUndefined()
    // the row's own identity and attribution are untouched
    expect(out).toMatchObject({ id: 'e1', type: 'mail.sent', passport_id: 'p1' })
  })

  it('drops a call transcript but keeps the call metadata', () => {
    const out = projectRow(row({ caller: '+359888', line: '+3592437', duration: 42, transcription: 'the whole call' }))
    expect(out.data.data).toMatchObject({ caller: '+359888', duration: 42 })
    expect(out.data.data.transcription).toBeUndefined()
  })

  it('drops credential-shaped keys at any depth', () => {
    const out = projectRow(row({ ok: 1, provider: { token: 'sk-live-abc', status: 200 } }))
    expect(out.data.data.provider).toEqual({ status: 200 })
  })

  // awareness's `preview` exists so an observer never needs the raw text: bounded
  // at 160 chars and PII-redacted upstream. Dropping it would blank the feed's
  // detail column and push callers back to reading `text`.
  it('keeps awareness preview, already redacted and bounded', () => {
    const out = projectRow(row({ source: 'text', preview: 'A sentence the visitor read.' }))
    expect(out.data.data.preview).toBe('A sentence the visitor read.')
  })

  it('marks an oversized payload rather than shipping it', () => {
    const data = { passport_id: 'p9' }
    for (let i = 0; i < 400; i++) data['field_' + i] = 'x'.repeat(40)
    const out = projectRow(row(data))
    expect(out.data.data._truncated).toBe(true)
    expect(out.data.data._original_bytes).toBeGreaterThan(4096)
    // attribution survives truncation — a huge event must stay findable
    expect(out.data.data.passport_id).toBe('p9')
    expect(JSON.stringify(out.data).length).toBeLessThan(4200)
  })

  it('survives malformed rows instead of throwing into the response', () => {
    for (const r of [null, undefined, {}, { data: null }, { data: 'nonsense' }]) {
      expect(() => projectRow(r)).not.toThrow()
    }
    expect(projectRows(null)).toEqual([])
    expect(projectRows([row({ to: 'a@b.com' })])).toHaveLength(1)
  })
})
