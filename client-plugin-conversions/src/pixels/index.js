// Browser-pixel dispatch over the COMPOSED client networks. Each is a descriptor
// from a network package's /client entry — { name, present(), collect(), fire(),
// identify()? } (e.g. `import { meta } from 'whitebox-pro-adnetworks-meta/client'`).
// A missing pixel (or a network with no identify()) is a silent no-op; a
// throwing one doesn't sink the others.

export function createPixels({ networks = [], logger } = {}) {
  return {
    // kind: 'standard' | 'custom'. Returns the network names actually fired.
    fire(kind, name, payload, eventId) {
      const fired = []
      for (const net of networks) {
        if (!net?.present?.()) continue
        try {
          net.fire(kind, name, payload, eventId)
          fired.push(net.name)
        } catch (err) {
          logger?.warn?.(`conversions: ${net.name} pixel failed`, err)
        }
      }
      return fired
    },

    // Advanced Matching: hand identity claims ([{type, name, value}]) to every
    // present network that knows what to do with them. Returns the network
    // names that actually ran identify().
    identify(claims) {
      const identified = []
      for (const net of networks) {
        if (!net?.present?.() || !net.identify) continue
        try {
          net.identify(claims)
          identified.push(net.name)
        } catch (err) {
          logger?.warn?.(`conversions: ${net.name} identify failed`, err)
        }
      }
      return identified
    },
  }
}
