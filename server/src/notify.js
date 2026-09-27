// One channel that EVERY event is echoed to, for consumers that want the whole
// stream rather than one type — a monitoring view, primarily.
//
// Why not psubscribe('*')? Because the Redis database is not necessarily ours
// alone. Verified on the dev instance: a wildcard subscriber also receives
// `directus:bus:logs`, i.e. a completely different application's traffic. A
// monitor built on `*` would render another system's events as WhiteBox's own.
//
// Enumerating types instead doesn't work either: the channel IS the type, types
// are contributed by whichever plugins are registered, and new ones appear
// without anyone re-registering — a monitor that lists them silently misses
// every type added later. A single explicit channel is exact, complete, and
// carries the type in the message rather than in the channel name.
export const FIREHOSE_CHANNEL = 'whitebox:events'

export default ({ webhooksConfig, events, webhooks, eventRegistry }) => {
  async function notify(type, payload) {
    await events.publish(type, payload)
    // Fire-and-forget, like the registry write below it: observability must
    // never be able to fail or slow down the thing it is observing.
    events.publish(FIREHOSE_CHANNEL, { type, payload })?.catch?.(() => {})
    eventRegistry?.record(type, payload).catch(() => {})
    const key = type.split('.').pop()
    const configured = webhooksConfig?.[key]
    if (configured) {
      // One event may have several endpoints, so the value is a webhook config
      // OR an array of them. Spreading an array produced `{ "0": {…} }` with no
      // `url`, which webhooks.send() used to drop without a word — every
      // webhook for that event silently went nowhere.
      const targets = Array.isArray(configured) ? configured : [configured]
      await Promise.all(targets.map(target => webhooks.send({ ...target, data: payload })))
    }
  }

  return { notify }
}
