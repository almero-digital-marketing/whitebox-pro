import { describe, it, expect } from 'vitest'
import { mailboxAddress, mailboxSchema } from '../src/address.js'

describe('mailboxAddress', () => {
  it('returns a bare address unchanged', () => {
    expect(mailboxAddress('info@gpoint.bg')).toBe('info@gpoint.bg')
  })

  it('trims surrounding whitespace', () => {
    expect(mailboxAddress('  info@gpoint.bg  ')).toBe('info@gpoint.bg')
  })

  it('strips a display name', () => {
    expect(mailboxAddress('G Point <info@gpoint.bg>')).toBe('info@gpoint.bg')
  })

  it('strips a quoted display name containing a comma', () => {
    expect(mailboxAddress('"Point, G" <info@gpoint.bg>')).toBe('info@gpoint.bg')
  })

  it('strips a non-ASCII display name', () => {
    expect(mailboxAddress('Джи Пойнт <info@gpoint.bg>')).toBe('info@gpoint.bg')
  })

  it('tolerates whitespace inside the angle brackets', () => {
    expect(mailboxAddress('G Point < info@gpoint.bg >')).toBe('info@gpoint.bg')
  })
})

describe('mailboxSchema', () => {
  it('accepts a bare address', () => {
    expect(mailboxSchema.safeParse('info@gpoint.bg').success).toBe(true)
  })

  // The exact value every G Point booking confirmation carried, and the one
  // that used to come back as 400 {"fieldErrors":{"from":["Invalid email"]}}.
  it('accepts a display name plus address', () => {
    const result = mailboxSchema.safeParse('G Point <info@gpoint.bg>')
    expect(result.success).toBe(true)
    // Stored as given — the display name has to survive into Reply-To.
    expect(result.data).toBe('G Point <info@gpoint.bg>')
  })

  it('rejects a display name wrapping a non-address', () => {
    expect(mailboxSchema.safeParse('G Point <not-an-email>').success).toBe(false)
  })

  it('rejects a bare non-address', () => {
    expect(mailboxSchema.safeParse('not-an-email').success).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(mailboxSchema.safeParse('').success).toBe(false)
  })

  it('rejects an unclosed angle bracket', () => {
    expect(mailboxSchema.safeParse('G Point <info@gpoint.bg').success).toBe(false)
  })
})
