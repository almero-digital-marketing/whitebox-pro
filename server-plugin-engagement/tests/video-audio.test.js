// A video with no audio channel must not be sent for transcription: ffmpeg's
// audio-only extraction fails outright on one, which used to fail the whole
// resolution and lose the frame descriptions too.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fluent-ffmpeg', () => {
  // The chain must actually fire its 'end' handler — extractAudio wraps it in a
  // promise that otherwise never settles.
  const ffmpeg = vi.fn(() => {
    const handlers = {}
    const chain = {}
    for (const m of ['noVideo', 'audioCodec', 'audioBitrate', 'outputOptions', 'screenshots']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.on = vi.fn((event, cb) => { handlers[event] = cb; return chain })
    chain.save = vi.fn(() => { setImmediate(() => handlers.end?.()); return chain })
    return chain
  })
  ffmpeg.ffprobe = vi.fn()
  return { default: ffmpeg }
})

vi.mock('axios', () => {
  const get = vi.fn()
  return { default: { get }, get }
})

const ffmpeg = (await import('fluent-ffmpeg')).default
const axiosGet = (await import('axios')).default.get
const { Readable } = await import('node:stream')
const content = await import('../src/content.js')

const probeReturns = (err, data) => {
  ffmpeg.ffprobe.mockImplementation((_path, cb) => cb(err, data))
}

describe('probeVideo', () => {
  beforeEach(() => { ffmpeg.ffprobe.mockReset() })

  it('reports an audio stream when one is present, with the duration', async () => {
    probeReturns(null, {
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      format: { duration: 12.5 },
    })
    expect(await content.probeVideo('/tmp/v.mp4')).toMatchObject({ hasAudio: true, duration: 12.5 })
  })

  it('reports no audio for a video-only file', async () => {
    probeReturns(null, { streams: [{ codec_type: 'video' }], format: { duration: 8 } })
    expect(await content.probeVideo('/tmp/v.mp4')).toMatchObject({ hasAudio: false, duration: 8 })
  })

  it('reports no audio when there are no streams at all', async () => {
    probeReturns(null, {})
    expect((await content.probeVideo('/tmp/v.mp4')).hasAudio).toBe(false)
  })

  // The distinction that matters: a failed probe is "unknown", not "silent".
  // Returning false here would silently stop transcribing perfectly good video.
  it('reports unknown — not false — when the probe itself fails', async () => {
    const err = new Error('ffprobe exited 1')
    probeReturns(err, null)
    const probe = await content.probeVideo('/tmp/v.mp4')
    expect(probe.hasAudio).toBeNull()
    expect(probe.error).toBe(err)
  })

  it('never rejects, so a probe failure cannot take the resolution down', async () => {
    probeReturns(new Error('boom'), null)
    await expect(content.probeVideo('/tmp/v.mp4')).resolves.toBeDefined()
  })
})

describe('resolveVideo — a silent video is not sent for transcription', () => {
  // Exercises the real decision rather than restating it: ffprobe reports no
  // audio stream, and ai.transcribe must never be called.
  const makeContent = (ai) => {
    const rows = []
    const chain = () => {
      const filters = []
      const c = {
        where: (cond) => { filters.push(r => Object.entries(cond).every(([k, v]) => r[k] === v)); return c },
        first: async () => rows.find(r => filters.every(f => f(r))) || null,
        insert: (data) => ({ onConflict: () => ({ merge: () => ({ returning: async () => {
          const parsed = {
            ...data,
            segments: typeof data.segments === 'string' ? JSON.parse(data.segments) : data.segments,
            meta: typeof data.meta === 'string' ? JSON.parse(data.meta) : data.meta,
          }
          rows.push(parsed)
          return [parsed]
        } }) }) }),
      }
      return c
    }
    const db = () => chain()
    db.rows = rows
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // extractVisual off so the frame pass (which also drives ffmpeg) stays out
    // of the way — the audio decision is what is under test.
    content.init({ db, ai, config: { engagement: { video: { extractVisual: false } } }, logger })
    return { db, logger }
  }

  beforeEach(() => {
    ffmpeg.ffprobe.mockReset()
    axiosGet.mockImplementation(async () => ({ data: Readable.from([Buffer.from('fake-video')]) }))
  })

  it('does not call transcribe when the video has no audio channel', async () => {
    probeReturns(null, { streams: [{ codec_type: 'video' }], format: { duration: 9 } })
    const ai = { transcribe: vi.fn(), vision: vi.fn(), embed: vi.fn() }
    const { db, logger } = makeContent(ai)

    const row = await content.resolveVideo('https://example.com/silent.mp4')

    expect(ai.transcribe).not.toHaveBeenCalled()
    expect(row.meta.has_audio).toBe(false)
    expect(row.meta.duration_s).toBe(9)          // duration still comes from the probe
    expect(logger.info).toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)              // still resolved, not failed
  })

  it('does call transcribe when an audio stream is present', async () => {
    probeReturns(null, { streams: [{ codec_type: 'audio' }], format: { duration: 4 } })
    const ai = {
      transcribe: vi.fn(async () => ({ segments: [{ start: 0, end: 4, text: 'hello' }], duration: 4, text: 'hello' })),
      vision: vi.fn(), embed: vi.fn(),
    }
    makeContent(ai)

    const row = await content.resolveVideo('https://example.com/spoken.mp4')

    expect(ai.transcribe).toHaveBeenCalledTimes(1)
    expect(row.meta.has_audio).toBe(true)
    expect(row.text).toContain('hello')
  })

  it('still attempts transcription when the probe fails — unknown is not silent', async () => {
    probeReturns(new Error('ffprobe exited 1'), null)
    const ai = {
      transcribe: vi.fn(async () => ({ segments: [], duration: 0, text: '' })),
      vision: vi.fn(), embed: vi.fn(),
    }
    const { logger } = makeContent(ai)

    await content.resolveVideo('https://example.com/unknown.mp4')

    expect(ai.transcribe).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalled()
  })
})
