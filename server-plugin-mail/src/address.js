// RFC 5322 mailbox parsing, for the fields that are header values rather than
// lookup keys. The distinction matters more than it looks.
//
// `to` stays a bare address on purpose and is NOT parsed here. It is an identity
// key: outbox.js feeds it to passports.findByIdentity('email', row.to), to
// passports.link(), and to the suppression/invalid preflight. Accepting
// "Name <addr>" there would not raise an error — it would silently miss every
// one of those lookups, so a suppressed recipient would receive mail. Strict is
// the safe direction for a key.
//
// `from` is the opposite case. buildMessage puts it in Reply-To and nowhere
// else; the visible From header is the provider's configured sender. RFC 5322
// allows a display name in Reply-To, so `z.string().email()` was rejecting a
// legal header value — and it did, in production: every G Point booking
// confirmation carried from "G Point <info@gpoint.bg>" and got back
// 400 {"fieldErrors":{"from":["Invalid email"]}}, so the outbox row was never
// even created.

import { z } from 'zod'

// "Display Name <addr>" or "\"Quoted, Name\" <addr>" — captures the addr-spec.
// Anything without angle brackets is treated as a bare address.
const ANGLE_ADDR = /^\s*(?:"(?:[^"\\]|\\.)*"|[^"<>]*?)\s*<\s*([^\s<>]+)\s*>\s*$/

// The deliverable address inside a mailbox, with any display name stripped.
export function mailboxAddress(value) {
  if (typeof value !== 'string') return value
  const match = ANGLE_ADDR.exec(value)
  return match ? match[1] : value.trim()
}

const emailSchema = z.string().email()

// A bare address, or a display name plus an address. Stored as given so the
// display name survives into Reply-To; only the addr-spec is validated.
export const mailboxSchema = z.string().refine(
  value => emailSchema.safeParse(mailboxAddress(value)).success,
  { message: 'Invalid email' },
)
