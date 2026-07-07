import pino from 'pino'

const DEFAULT = {
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      // `component` is rendered inline as a [tag] prefix (see messageFormat), so
      // drop it from the key dump to avoid showing it twice.
      ignore: 'pid,hostname,component',
      // Show which plugin/core module a line came from, inline: "[voip] message".
      // Lines without a component (bare server bootstrap) print clean.
      messageFormat: '{if component}[{component}] {end}{msg}',
    },
  },
}

let logger = pino(DEFAULT)

export function init(options) {
  const cfg = options.config?.logger
  logger = pino({
    level: cfg?.level || DEFAULT.level,
    transport: cfg?.transport !== undefined
      ? cfg.transport
      : process.env.NODE_ENV !== 'production' ? DEFAULT.transport : undefined,
  })
}

// The default export must track init()'s reassignment. `export default logger`
// would snapshot the pre-init instance (ESM default-exports an identifier's
// VALUE, not a live binding), silently discarding config.logger.level/transport
// for every `import logger from './logger.js'` in the codebase — so we export
// a thin proxy that always delegates to the current instance instead.
export default new Proxy({}, {
  get(_, prop) {
    const value = logger[prop]
    return typeof value === 'function' ? value.bind(logger) : value
  },
  set(_, prop, value) {
    logger[prop] = value
    return true
  },
  has: (_, prop) => prop in logger,
})
