import { createMeta } from './meta.js'
import { createTiktok } from './tiktok.js'
import { createGoogle } from './google.js'

const FACTORIES = { meta: createMeta, tiktok: createTiktok, google: createGoogle }

// Build the enabled, configured adapters from a networks config block.
//   networks: { meta:{…}, tiktok:{…}, google:{…} }  (enabled:false to skip)
export function buildAdapters(networks = {}, deps = {}) {
  const adapters = []
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const cfg = networks[name]
    if (!cfg || cfg.enabled === false) continue
    adapters.push(factory(cfg, deps))
  }
  return adapters
}
