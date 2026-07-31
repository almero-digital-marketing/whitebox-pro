// A reusable check that a plugin's event manifest matches what it actually emits.
//
// This is the test that would have caught the bug behind the whole event-catalog
// refactor: `voip.click` was emitted by pool.js and classified nowhere, so
// click-to-call had shown up in the Live board with no direction and no detail for
// as long as the feature had existed. Nobody could see it, because the emitter and
// the classification lived in different packages.
//
// They live in the same one now, so this can check them against each other — and
// it does it by SCANNING THE PLUGIN'S OWN SOURCE rather than against a hand-kept
// list, which is the part that matters. A hand-kept list of "what we emit" is just
// a second thing to forget to update, and the one in live's tests had drifted too:
// it named mail.clicked and mail.unsubscribed, neither of which any plugin emits.
//
// It lives in core so that adopting it costs a plugin four lines. A per-package
// copy would be seven copies of a scanner regex, which is the same duplication
// this refactor exists to remove.
//
//   import { describe } from 'vitest'
//   import { manifestSuite } from 'whitebox-pro-server/test-manifest'
//   import { voip } from '../src/index.js'
//
//   manifestSuite({ plugin: voip({}), srcDir: new URL('../src', import.meta.url) })
//
// Pass `expectEmitted` for a type you know is emitted, as a guard on the scanner
// itself: if the regex ever stops matching, every other assertion passes
// vacuously.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every literal event type passed to notify() anywhere under `dir`.
 *
 * Template literals (`voip.${x}`) are skipped deliberately — a dynamic suffix can
 * only be declared as a prefix, and asserting on the un-interpolated source text
 * would be asserting on source rather than behaviour. `dynamicNamespaces()` below
 * reports those separately, which is what justifies a prefix declaration.
 */
export function emittedTypes(dir) {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir)
  const found = new Set()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (!entry.name.endsWith('.js')) continue
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/notify\w*\s*\??\.?\s*\(\s*'([a-z][\w.]*)'/g)) found.add(m[1])
    }
  }
  walk(root)
  return [...found].sort()
}

/** Namespaces built with a template literal — `notify(`crm.${kind}`)` → 'crm'. */
export function dynamicNamespaces(dir) {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir)
  const found = new Set()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (!entry.name.endsWith('.js')) continue
      for (const m of readFileSync(p, 'utf8').matchAll(/notify\w*\s*\??\.?\s*\(\s*`([a-z][\w.]*?)\.\$\{/g)) {
        found.add(m[1].split('.')[0])
      }
    }
  }
  walk(root)
  return [...found].sort()
}

/** The manifest's own matching rule: exact type, or a trailing-dot prefix. */
export const declares = (events = {}, type) =>
  Object.keys(events).some(key => (key.endsWith('.') ? type.startsWith(key) : key === type))

/**
 * @param {object}   opts
 * @param {object}   opts.plugin           the built plugin, e.g. `voip({})`
 * @param {string|URL} opts.srcDir         the plugin's src directory
 * @param {string[]} [opts.expectEmitted]  types that MUST be found by the scan
 * @param {string[]} [opts.dynamicTypes]   the types a `${...}` suffix can produce
 *
 * `dynamicTypes` is for a namespace built with a template literal whose
 * vocabulary is nonetheless CLOSED and ours — mail emits `mail.${status}` where
 * status comes from its own statusMap (delivered | opened | engaged | bounced |
 * complained), so it enumerates rather than declaring a `'mail.'` prefix, and a
 * prefix would swallow a sixth status silently.
 *
 * It is a hand-kept list, which this file otherwise argues against — but it lives
 * in the same package as the statusMap it mirrors, so drift is local and visible,
 * and the check FAILS if a dynamic namespace is neither enumerated here nor
 * covered by a prefix. That is the part that matters: you cannot forget to decide.
 */
export function manifestSuite({ plugin, srcDir, expectEmitted = [], dynamicTypes = [], scopedDetail = [] }) {
  const name = plugin?.name || '(unnamed)'

  describe(`${name} event manifest`, () => {
    const events = plugin?.events || {}
    const emitted = [...new Set([...emittedTypes(srcDir), ...dynamicTypes])].sort()
    const dynamic = dynamicNamespaces(srcDir)
    const hasPrefixFor = (ns) => Object.keys(events).some(k => k.endsWith('.') && k.startsWith(ns))
    const enumeratedFor = (ns) => dynamicTypes.some(t => t.startsWith(`${ns}.`))

    // If the scan finds nothing, every assertion below passes vacuously.
    it('finds the events this plugin emits at all', () => {
      expect(emitted.length + dynamic.length).toBeGreaterThan(0)
      for (const t of expectEmitted) expect(emitted).toContain(t)
    })

    if (emitted.length) {
      it.each(emitted)('declares %s', (type) => {
        expect(declares(events, type)).toBe(true)
      })
    }

    // A `${...}` suffix must be accounted for one of two ways — a prefix when the
    // vocabulary is open (crm's record kinds belong to the CRM), or an enumerated
    // `dynamicTypes` when it's closed and ours (mail's statusMap). Neither is a
    // failure, because then nothing classifies those events at all.
    if (dynamic.length) {
      it.each(dynamic)('accounts for the dynamic %s.* types', (ns) => {
        expect(
          hasPrefixFor(ns) || enumeratedFor(ns),
          `nothing covers \`${ns}.\${…}\` — declare a '${ns}.' prefix, or pass its closed vocabulary as dynamicTypes`,
        ).toBe(true)
      })
    }

    // The direction that catches a STALE entry rather than a missing one. live's
    // old map declared four namespaces nobody emitted, plus 'conversions.' for an
    // event called `conversion.`, and every one was invisible. A declaration for
    // an event we don't emit is dead weight that reads as coverage.
    it('declares nothing it does not emit', () => {
      for (const key of Object.keys(events)) {
        if (key.endsWith('.')) {
          const ns = key.split('.')[0]
          const justified = dynamic.includes(ns) || emitted.some(t => t.startsWith(key))
          expect(justified, `prefix "${key}" matches nothing this plugin emits`).toBe(true)
          continue
        }
        // `emitted` includes dynamicTypes, so an enumerated status counts as
        // emitted — it is, just not as a literal in the source.
        expect(emitted, `declared "${key}" but nothing emits it`).toContain(key)
      }
    })

    it('gives every declaration a direction the catalog understands', () => {
      for (const [key, spec] of Object.entries(events)) {
        const d = typeof spec === 'string' ? spec : spec.direction
        expect(['in', 'out', 'internal'], `"${key}"`).toContain(d)
      }
    })

    // Same drift in the other map: a detail key no declared event can match is a
    // branch that never runs, and it looks exactly like a correct one.
    //
    // `scopedDetail` is the deliberate exception — a type we describe but do NOT
    // own. `awareness.recorded` is emitted by core, while its payload is composed
    // by whichever plugin called awareness.record(), so several plugins describe
    // their own rows of it (the catalog routes by `data.plugin`). Listing them
    // explicitly keeps the typo check: an unlisted key that matches nothing still
    // fails, which is the whole point of this test.
    it('declares no detail for an event it does not declare', () => {
      for (const key of Object.keys(plugin?.detail || {})) {
        if (scopedDetail.includes(key)) continue
        const reachable = Object.keys(events).some(t =>
          key.endsWith('.') ? (t.startsWith(key) || key.startsWith(t)) : (t === key || (t.endsWith('.') && key.startsWith(t))),
        )
        expect(reachable, `detail "${key}" matches no declared event — if it belongs to another module and you only describe YOUR rows of it, list it in scopedDetail`).toBe(true)
      }
    })

    // A scoped declaration only works if the catalog can route a row back to us,
    // and it does that by `data.plugin` — which the loader stamps from this very
    // name. A mismatch here would silently fall through to core's generic version.
    if (scopedDetail.length) {
      it.each(scopedDetail)('describes %s only for rows it produced', (key) => {
        expect(Object.keys(plugin?.detail || {})).toContain(key)
        expect(plugin?.name, 'a scoped detail needs a plugin name to match data.plugin against').toBeTruthy()
      })
    }
  })
}
