// Does our event manifest match what we actually emit?
//
// This is the test that would have caught the bug that started all of this:
// `voip.click` was emitted by pool.js and classified nowhere, so click-to-call
// showed up in the Live board with no direction, and had done for as long as the
// feature existed. Nobody could see it by reading code, because the emitter and
// the classification lived in different packages.
//
// Now they live in the same one — so this can check them against each other, and
// it does it by SCANNING OUR OWN SOURCE rather than against a hand-kept list.
// That distinction is the whole value: a hand-kept list of "what we emit" is just
// a second thing to forget to update, and the list in live's tests had drifted
// too (it named mail.clicked and mail.unsubscribed, neither of which any plugin
// emits).
//
// Worth copying into any plugin that emits events. It needs nothing from core.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { voip } from '../src/index.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Every literal event type passed to notify() anywhere in src/. Template
// literals (`voip.${x}`) are skipped on purpose — a dynamic suffix can only be
// declared as a prefix, and asserting on the un-interpolated string would be
// asserting on source text rather than behaviour.
function emittedTypes(dir) {
  const found = new Set()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const t of emittedTypes(path)) found.add(t)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const src = readFileSync(path, 'utf8')
    for (const m of src.matchAll(/notify\s*\??\.?\s*\(\s*'([a-z][\w.]*)'/g)) found.add(m[1])
  }
  return found
}

// The manifest's own matching rule: exact type, or a declaration ending in a dot
// that the type starts with.
const declares = (events, type) =>
  Object.keys(events).some(key => (key.endsWith('.') ? type.startsWith(key) : key === type))

describe('voip event manifest', () => {
  const { events } = voip({})
  const emitted = [...emittedTypes(SRC)].sort()

  it('finds the events we emit at all (guards the scanner itself)', () => {
    // If the regex ever stops matching, every assertion below passes vacuously —
    // so assert the scan found something, and specifically found the one that
    // was missing.
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted).toContain('voip.click')
  })

  it.each([...emittedTypes(SRC)].sort())('declares %s', (type) => {
    expect(declares(events, type)).toBe(true)
  })

  // The other direction, and the one that catches a stale entry rather than a
  // missing one: live's old map declared four namespaces nobody emitted, plus
  // 'conversions.' for an event called `conversion.`, and every one of those was
  // invisible. A declaration for an event we don't emit is dead weight that reads
  // as coverage.
  it('declares nothing it does not emit', () => {
    const dynamic = /voip\.\$\{/.test(readFileSync(join(SRC, 'pool.js'), 'utf8'))
    for (const key of Object.keys(events)) {
      if (key.endsWith('.')) {
        // A prefix is only justified by a dynamic suffix somewhere.
        expect(dynamic, `prefix "${key}" declared but nothing builds a dynamic type`).toBe(true)
        continue
      }
      expect(emitted, `declared "${key}" but nothing emits it`).toContain(key)
    }
  })

  it('gives every declaration a direction the catalog understands', () => {
    for (const [key, spec] of Object.entries(events)) {
      const d = typeof spec === 'string' ? spec : spec.direction
      expect(['in', 'out', 'internal'], `"${key}"`).toContain(d)
    }
  })
})
