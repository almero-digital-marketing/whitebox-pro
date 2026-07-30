import { describe as group, it, expect } from 'vitest'
import { describe } from '../src/describe.js'

// Every payload below is the shape a producer ACTUALLY writes — mail/sms notify
// with their outbox row, voip with its call row, the rest with purpose-built
// payloads. A describer tested against invented shapes would pass while showing
// "—" for every real event.
const wrap = (data) => ({ data })

group('describe()', () => {
  // The point of the column: show what was READ, not an internal id.
  it('shows the real (redacted) text when core carries a preview', () => {
    expect(describe('awareness.recorded', wrap({
      source: 'text', content_id: 'para-7',
      preview: 'Използваме доказано най-добрите лазери, произведени в Европа.',
    }))).toBe('text · Използваме доказано най-добрите лазери, произведени в Европа.')
  })

  // Conversions synthesise their awareness text from the event name, so echoing
  // it put "conversion · Conversion: view content" in a row whose type column
  // already said conversion.view_content. Where it happened is the useful part.
  it('ignores a preview that only restates the event type', () => {
    expect(describe('awareness.recorded', wrap({
      source: 'conversion',
      preview: 'Conversion: view content',
      content_id: 'conversion:view_content:cfde35a7-960d-4815-a060-7bdfc3517a91',
      content_url: 'https://gpoint.bg/lasers',
    }))).toBe('conversion · /lasers')
  })

  it('still shows a preview that is genuinely different from the type', () => {
    expect(describe('awareness.recorded', wrap({
      source: 'conversion',
      preview: 'Bought 3 sessions for the Sofia studio',
      content_id: 'conversion:purchase:abc',
    }))).toBe('conversion · Bought 3 sessions for the Sofia studio')
  })

  it('flattens newlines and whitespace runs out of real page text', () => {
    expect(describe('awareness.recorded', wrap({ source: 'text', preview: '  a\n\n  b   c  ' })))
      .toBe('text · a b c')
  })

  it('names the content kind for engagement, which is the only place it survives', () => {
    // there is no engagement.* event type on purpose (it would double-count the
    // touch), so `source` on awareness.recorded is how "a video was watched"
    // reaches an operator at all
    expect(describe('awareness.recorded', wrap({ source: 'video', content_url: 'https://gpoint.bg/lasers#hero' })))
      .toBe('video · /lasers')
    expect(describe('awareness.recorded', wrap({ source: 'text', content_id: 'para-7' }))).toBe('text · para-7')
    expect(describe('awareness.recorded', wrap({ source: 'image', content_url: 'https://cdn/x.jpg' }))).toBe('image · /x.jpg')
  })

  it('leads with attribution for a new session, and says direct when there is none', () => {
    expect(describe('session.started', wrap({ utm_source: 'google', utm_campaign: 'spring' }))).toBe('google / spring')
    expect(describe('session.started', wrap({ utm_source: 'google' }))).toBe('google')
    expect(describe('session.started', wrap({ referrer: 'https://news.example/post/1' }))).toBe('ref /post/1')
    expect(describe('session.started', wrap({}))).toBe('direct')
  })

  it('puts the failure reason in the line when there is one', () => {
    expect(describe('mail.failed', wrap({ to: 'a@b.com', failure_reason: 'mailbox full' }))).toBe('a@b.com — mailbox full')
    expect(describe('mail.sent', wrap({ to: 'a@b.com', subject: 'Hello' }))).toBe('a@b.com · Hello')
    expect(describe('sms.failed', wrap({ to: '+359...', failure_reason: 'DLR 5' }))).toBe('+359... — DLR 5')
  })

  // The registry strips message content at the write, so a describer that read it
  // would make a backfilled row disagree with the same event arriving live.
  it('never puts message content in the line, even when handed some', () => {
    expect(describe('sms.sent', wrap({ to: '+359888', body: 'secret promo code XYZ' })))
      .toBe('+359888')
    expect(describe('sms.sent', wrap({ to: '+359888', segments: 2 }))).toBe('+359888 · 2 segments')
    const mail = describe('mail.sent', wrap({ to: 'a@b.com', subject: 'Hello', html: '<p>body</p>', text: 'body' }))
    expect(mail).toBe('a@b.com · Hello')
    expect(mail).not.toContain('body')
  })

  // gpoint.bg's routes are Bulgarian, so the browser sends them percent-encoded.
  // Undecoded they're unreadable AND long enough to crowd the rest of the row out.
  it('percent-decodes a non-ASCII path for display', () => {
    expect(describe('conversion.view_content', wrap({
      url: 'https://gpoint.bg/%D0%B7%D0%B0%D0%BF%D0%B0%D0%B7%D0%B2%D0%B0%D0%BD%D0%B5-%D1%87%D0%B0%D1%81',
    }))).toBe('/запазване-час')
    // …and via content_url, the awareness path
    expect(describe('awareness.recorded', wrap({
      source: 'text', content_url: 'https://gpoint.bg/%D0%BA%D0%BB%D1%83%D0%B1',
    }))).toBe('text · /клуб')
  })

  it('keeps the raw string when a sequence is malformed, rather than losing the row', () => {
    // decodeURIComponent throws on these; a feed row must never be what breaks
    for (const bad of ['https://gpoint.bg/100%', 'https://gpoint.bg/%E0%A4%A']) {
      expect(() => describe('conversion.view_content', wrap({ url: bad }))).not.toThrow()
      expect(describe('conversion.view_content', wrap({ url: bad }))).toBeTruthy()
    }
  })

  it('describes an ad-network call by network, event and the rejection reason', () => {
    expect(describe('adnetwork.accepted', wrap({ network: 'meta', event: 'Purchase' }))).toBe('meta · Purchase')
    expect(describe('adnetwork.rejected', wrap({ network: 'tiktok', event: 'AddToCart', error: 'invalid pixel' })))
      .toBe('tiktok · AddToCart — invalid pixel')
  })

  it('shows money for a conversion when it carries any, else where it happened', () => {
    expect(describe('conversion.purchase', wrap({ value: 120, currency: 'BGN' }))).toBe('120 BGN')
    expect(describe('conversion.view_content', wrap({ url: 'https://gpoint.bg/studios/sofia' }))).toBe('/studios/sofia')
  })

  it('attributes a call by the line it rang', () => {
    expect(describe('voip.ring', wrap({ caller: '+359888', line: '+35924374782', tag: 'web' })))
      .toBe('+359888 → +35924374782 (web)')
  })

  // The honesty rule: no summary beats an invented one, because an operator
  // reads this column as fact.
  it('returns null rather than inventing something for an unknown shape', () => {
    expect(describe('something.nobody.mapped', wrap({ a: 1 }))).toBeNull()
    expect(describe('mail.sent', wrap({}))).toBeNull()
    expect(describe('awareness.recorded', wrap({}))).toBeNull()
  })

  it('survives a missing or malformed payload instead of throwing into the feed', () => {
    for (const p of [null, undefined, {}, { data: null }, 'nonsense']) {
      expect(() => describe('mail.sent', p)).not.toThrow()
    }
  })

  // The cap is a SAFETY bound, not a layout decision: clipping to a display
  // width here ellipsised text while half the feed row was still empty, since
  // only the browser knows the column's real width. CSS `text-overflow` cuts it
  // at the true edge; this only stops a pathological payload filling every row.
  it('bounds a pathological payload without pretending to know the column width', () => {
    const long = 'x'.repeat(5000)
    const out = describe('mail.sent', wrap({ to: long }))
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('…')).toBe(true)
    // still generous enough that a real sentence is never the server's problem
    expect(out.length).toBeGreaterThan(150)
  })
})
