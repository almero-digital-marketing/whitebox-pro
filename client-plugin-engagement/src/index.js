// Engagement plugin — automatic text + image + video trackers + manual section helper.
// WS-primary, sendBeacon fallback on unload.

import createText from './text.js'
import createImage from './image.js'
import createVideo from './video.js'
import createLink from './link.js'

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_BATCH_SIZE = 10

function preview(text, max = 60) {
  if (!text) return ''
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

// One readable line per captured event, regardless of kind — logged the
// moment something is detected (enqueue), separate from the flush log below
// (which only says how many/how, not what).
function describeEvent(e) {
  switch (e.type) {
    case 'engagement.text':
      return `text "${e.id}" (${e.length_chars} chars, ${e.ms_spent}ms${e.partial ? ', partial' : ''}): ${preview(e.text)}`
    case 'engagement.image':
      return `image "${e.id}" ${e.src} (${e.ms_spent}ms${e.partial ? ', partial' : ''})`
    case 'engagement.video':
      return `video "${e.id}" ${e.total_watched_s}s/${e.duration_s}s (${e.completion_pct}%${e.partial ? ', partial' : ''})`
    case 'engagement.link':
      return `link "${e.id}" -> ${e.href}`
    case 'engagement.section':
      return `section "${e.id}" (${e.dwell_ms}ms): ${preview(e.text)}`
    default:
      return e.type
  }
}

export default function engagementPlugin(localOptions = {}) {
  return {
    name: 'engagement',
    install(core) {
      const { transport, http, queue, emitter, logger, config: pluginConfig = {}, deepMerge } = core
      const options = deepMerge ? deepMerge(pluginConfig, localOptions) : { ...pluginConfig, ...localOptions }

      const buffer = []
      let flushTimer = null
      let textTracker = null
      let imageTracker = null
      let videoTracker = null
      let linkTracker = null

      function enqueue(event) {
        logger?.debug?.('whitebox: %s', describeEvent(event))
        buffer.push(event)
        if (buffer.length >= (options.batchSize ?? DEFAULT_BATCH_SIZE)) flush()
        else if (!flushTimer) scheduleFlush()
      }

      function scheduleFlush() {
        flushTimer = setTimeout(flush, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
      }

      // Progress ticks fire every ~250ms while a block is being read — far too
      // noisy to log every tick, but logging *nothing* meant there was no way
      // to tell "not tracked at all" apart from "tracked, just hasn't reached
      // the dwell threshold yet". Log only the reading/paused transitions.
      const readingIds = new Set()
      function makeProgressHandler(kind) {
        return (p) => {
          const wasReading = readingIds.has(p.id)
          if (p.reading && !wasReading) {
            readingIds.add(p.id)
            logger?.debug?.('whitebox: %s reading started: "%s" (%d%% of %dms required)', kind, p.id, Math.round(p.ratio * 100), p.required_ms)
          } else if (!p.reading && wasReading) {
            readingIds.delete(p.id)
            logger?.debug?.('whitebox: %s reading paused: "%s" (%d%% of %dms required)', kind, p.id, Math.round(p.ratio * 100), p.required_ms)
          }
          emitter.emit('engagement.progress', { kind, ...p })
        }
      }

      // The WS path resolves the passport/session from the socket connection
      // itself (see server connect.js), but the HTTP fallback (and sendBeacon,
      // which can't set headers) has no connection to key off — the server's
      // /engagement/events route requires passport_id as a query param.
      function eventsPath() {
        const params = new URLSearchParams()
        const passportId = core.getPassportId?.()
        const sessionId = core.getSessionId?.()
        if (passportId) params.set('passport_id', passportId)
        if (sessionId) params.set('session_id', sessionId)
        const qs = params.toString()
        return qs ? `/engagement/events?${qs}` : '/engagement/events'
      }

      function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        if (!buffer.length) return
        const batch = buffer.splice(0)
        const viaTransport = transport?.isConnected?.() && transport.send('engagement.batch', { events: batch })
        logger?.debug?.('whitebox: flushing %d engagement event(s) via %s', batch.length, viaTransport ? 'transport' : 'http')
        if (viaTransport) return
        http.request(eventsPath(), { method: 'POST', body: { events: batch } })
          .catch(err => logger?.warn?.('engagement flush failed', err))
      }

      // Final flush on page hide / unload via sendBeacon
      if (typeof window !== 'undefined') {
        const beaconFlush = () => {
          if (!buffer.length) return
          const batch = buffer.splice(0)
          http.beacon(eventsPath(), { events: batch })
        }
        window.addEventListener('pagehide', beaconFlush)
        window.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') beaconFlush()
        })
      }

      // Manual section helper — for code that wants to emit a section-read
      // event directly (e.g. analytics from a non-DOM context).
      function section({ id, url, text, dwell_ms, meta } = {}) {
        if (!text) return
        enqueue({ type: 'engagement.section', ts: new Date().toISOString(), id, url, text, dwell_ms, meta })
      }

      // --- Automatic text tracking ---
      const textOptions = options.text === false ? null : (options.text ?? {})
      if (textOptions && textOptions.enabled !== false) {
        textTracker = createText({
          options: textOptions,
          onRead: ({ id, kind, level, text: chunk, length_chars, ms_spent, url, partial }) => {
            enqueue({
              type: 'engagement.text',
              ts: new Date().toISOString(),
              id, kind, level, text: chunk, length_chars, ms_spent, url, partial,
            })
            emitter.emit('engagement.text', { id, kind, level, text: chunk, length_chars, ms_spent, url, partial })
          },
          onProgress: makeProgressHandler('text'),
        })
        if (typeof window !== 'undefined') queue(async () => textTracker.start())
      }

      // --- Automatic image tracking ---
      const imageOptions = options.image === false ? null : (options.image ?? {})
      if (imageOptions && imageOptions.enabled !== false) {
        imageTracker = createImage({
          options: imageOptions,
          onRead: ({ id, kind, src, alt, width, height, ms_spent, url, partial }) => {
            enqueue({
              type: 'engagement.image',
              ts: new Date().toISOString(),
              id, kind, src, alt, width, height, ms_spent, url, partial,
            })
            emitter.emit('engagement.image', { id, kind, src, alt, width, height, ms_spent, url, partial })
          },
          onProgress: makeProgressHandler('image'),
        })
        if (typeof window !== 'undefined') queue(async () => imageTracker.start())
      }

      // --- Automatic video tracking ---
      const videoOptions = options.video === false ? null : (options.video ?? {})
      if (videoOptions && videoOptions.enabled !== false) {
        videoTracker = createVideo({
          options: videoOptions,
          onRead: ({ id, kind, src, duration_s, intervals, total_watched_s, completion_pct, ms_spent, url, muted, partial }) => {
            enqueue({
              type: 'engagement.video',
              ts: new Date().toISOString(),
              id, kind, src, duration_s, intervals,
              total_watched_s, completion_pct, ms_spent, url, muted, partial,
            })
            emitter.emit('engagement.video', { id, kind, src, duration_s, intervals, total_watched_s, completion_pct, ms_spent, url, muted, partial })
          },
        })
        if (typeof window !== 'undefined') queue(async () => videoTracker.start())
      }

      // --- Link-click tracking (strong intent signal) ---
      const linkOptions = options.link === false ? null : (options.link ?? {})
      if (linkOptions && linkOptions.enabled !== false) {
        linkTracker = createLink({
          options: linkOptions,
          onClick: ({ id, text, href }) => {
            enqueue({ type: 'engagement.link', ts: new Date().toISOString(), id, text, href })
            flush()   // a click may navigate away — send promptly rather than waiting on the timer
            emitter.emit('engagement.link', { id, text, href })
          },
        })
        if (typeof window !== 'undefined') queue(async () => linkTracker.start())
      }

      function stop() {
        textTracker?.stop()
        imageTracker?.stop()
        videoTracker?.stop()
        linkTracker?.stop()
        if (flushTimer) clearTimeout(flushTimer)
      }

      core.attach('engagement', {
        section, flush, stop,
        text: textTracker,
        image: imageTracker,
        video: videoTracker,
        link: linkTracker,
      })
    },
  }
}
