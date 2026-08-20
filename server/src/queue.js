import { Queue, Worker } from 'bullmq'
import logger from './logger.js'

let connection
const queues = {}
const workers = []

// BullMQ v5 forbids ':' in queue names (it's the Redis key separator). Call
// sites use readable names like 'mail:outbox'; map ':' → '-' for the actual
// queue. createQueue and createWorker sanitize identically so they pair up.
const safeName = (name) => name.replace(/:/g, '-')

function init(options) {
  const cfg = options.config.redis
  connection = {
    host: cfg.host,
    port: cfg.port,
    password: cfg.password,
    db: cfg.db || 0,
  }
}

// `options` reaches the BullMQ Queue — most importantly `defaultJobOptions`,
// which is where `attempts`, `backoff` and `removeOnComplete` have to live.
// They are Queue options, not Worker options: BullMQ silently ignores them on
// a Worker, so passing them there leaves every job on a single attempt with no
// backoff and completed jobs accumulating in Redis forever.
function createQueue(name, options = {}) {
  if (!queues[name]) {
    queues[name] = new Queue(safeName(name), { connection, ...options })
    logger.info('Queue created: %s', safeName(name))
  } else if (Object.keys(options).length) {
    // Queues are memoized by name, so a second caller's options would be
    // dropped without a word — the same silent-default failure this fix is
    // about. Say so instead.
    logger.warn('Queue %s already exists; ignoring options from this call', safeName(name))
  }
  return queues[name]
}

function createWorker(name, handler, options = {}) {
  const worker = new Worker(safeName(name), handler, { connection, ...options })
  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Job failed: %s', name))
  worker.on('error', err => logger.error({ err }, 'Worker error: %s', name))
  workers.push(worker)
  logger.info('Worker started: %s', name)
  return worker
}

async function close() {
  await Promise.all(workers.map(w => w.close()))
  await Promise.all(Object.values(queues).map(q => q.close()))
}

export { init, createQueue, createWorker, close }
