import { describe, it, expect } from 'vitest'
import { manifestSuite } from 'whitebox-pro-server/test-manifest'
import { crm } from '../src/index.js'

// We emit `crm.${kind}`, where the kind is whatever record type the host system
// pushes (booking, deal, client, subscription…). There is no closed set to
// enumerate — the vocabulary belongs to the CRM on the other side — so a prefix is
// the honest declaration, and the scan checks one covers the dynamic namespace.
manifestSuite({
  plugin: crm({}),
  srcDir: new URL('../src', import.meta.url),
})

describe('crm event detail', () => {
  const d = crm({}).detail['crm.']

  // The record's own identifiers, because that's what lets an operator find it in
  // the system that pushed it.
  it('lists the record identifiers it has', () => {
    expect(d({ kind: 'booking', external_id: 'B-11', status: 'confirmed' })).toBe('booking · B-11 · confirmed')
    expect(d({ kind: 'deal', status: 'won' })).toBe('deal · won')
    expect(d({ kind: 'client' })).toBe('client')
  })

  it('falls back to the source system when the record says nothing', () => {
    expect(d({ source: 'directus' })).toBe('directus')
    expect(d({})).toBeNull()
  })
})
