import path from 'path'
import os from 'os'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import axios from 'axios'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'

const TABLE = 'whitebox_engagement_content'

const IMAGE_PROMPT = 'Describe this image in 2-3 sentences for content awareness tracking. Focus on subject, message, and notable text shown.'
const FRAME_PROMPT = 'Describe this video frame in one sentence. Focus on subjects, action, on-screen text, and notable visual elements.'
const SUMMARY_SYSTEM = 'You are given timestamped descriptions of frames sampled across one video, in order. Write 2-4 sentences saying what the video is about: its subject, setting, and what happens. Write about the video itself, never about the frames or the descriptions.'

// How many frames the fallback samples when a video yields no words at all.
const SUMMARY_FRAMES = 5

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let db
let ai
let logger
let image
let video

export function init(deps) {
  db = deps.db
  ai = deps.ai
  logger = deps.logger

  const cfg = deps.options || {}
  image = {
    maxSide: cfg.image?.maxSide ?? 1024,
    quality: cfg.image?.quality ?? 85,
    detail: cfg.image?.detail ?? 'low',
    maxDownloadMB: cfg.image?.maxDownloadMB ?? 20,
  }
  video = {
    extractVisual: cfg.video?.extractVisual !== false,
    framePeriodSec: cfg.video?.framePeriodSec ?? 5,
    sceneThreshold: cfg.video?.sceneThreshold ?? 0.3,
    visionDetail: cfg.video?.visionDetail ?? 'low',
    maxFrames: cfg.video?.maxFrames ?? 100,
    maxDurationSec: cfg.video?.maxDurationSec ?? 1800,
    maxDownloadMB: cfg.video?.maxDownloadMB ?? 500,
  }
}

// -------- image --------

export async function resolveImage(url, providedDescription) {
  const cached = await db(TABLE).where({ url }).first()
  if (cached) return cached

  if (providedDescription) {
    return upsert({ url, kind: 'image', text: providedDescription, source_kind: 'provided' })
  }

  const { buf } = await fetchAndResize(url)
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
  const description = await ai.vision(IMAGE_PROMPT, dataUrl, { detail: image.detail, maxTokens: 200 })
  logger.info({ url }, 'Image described: %s', description)

  return upsert({
    url, kind: 'image', text: description, source_kind: 'auto',
    meta: { model: 'gpt-4o', detail: image.detail },
  })
}

async function fetchAndResize(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10_000,
    maxContentLength: image.maxDownloadMB * 1024 * 1024,
  })
  const contentType = res.headers['content-type'] || ''
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`)

  const buf = await sharp(Buffer.from(res.data))
    .resize({ width: image.maxSide, height: image.maxSide, fit: 'inside', withoutEnlargement: true })
    .rotate()
    .jpeg({ quality: image.quality, mozjpeg: true })
    .withMetadata({ exif: {} })
    .toBuffer()

  return { buf }
}

// -------- video --------

export async function resolveVideo(url, providedTranscript) {
  const cached = await db(TABLE).where({ url }).first()
  if (cached) return cached

  if (providedTranscript) {
    const segments = parseProvidedTranscript(providedTranscript)
    return upsert({
      url, kind: 'video',
      text: segments.map(s => s.audio).filter(Boolean).join(' '),
      segments,
      source_kind: 'provided',
    })
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-engagement-'))
  try {
    const videoPath = await downloadVideo(url, tmp)

    // A video with no audio stream has nothing to transcribe, and asking ffmpeg
    // for an audio-only output of one fails outright — which took the whole
    // resolution down with it, losing the frame descriptions that would have
    // worked. Probe first and skip only the Whisper leg.
    const probe = await probeVideo(videoPath)
    if (probe.error) {
      logger.warn({ url, err: probe.error },
        'Could not probe the video for an audio stream; attempting transcription anyway')
    }
    const silent = probe.hasAudio === false
    if (silent) {
      logger.info({ url }, 'Video has no audio channel — skipping transcription, keeping the visual pass')
    }

    const [whisper, frames] = await Promise.all([
      silent
        ? Promise.resolve({ segments: [], text: '', duration: probe.duration })
        : extractAudio(videoPath, tmp).then(audioPath =>
            ai.transcribe(audioPath, { response_format: 'verbose_json' }).then(w => {
              logger.info({ url }, 'Video transcribed: %s', w.text || '(no speech detected)')
              return w
            })),
      video.extractVisual
        ? extractAndDescribeFrames(videoPath, tmp, url).catch(err => {
            // Frame description is an ENHANCEMENT. ffmpeg refuses to extract
            // frames from some perfectly playable files (exit 251 on one real
            // 1080p h264 mp4), and letting that reject took the whole
            // resolution down — losing the Whisper transcript that had already
            // succeeded, and with it the watch data the exposure carries.
            logger.warn({ err, url }, 'Frame extraction failed; continuing with audio only')
            return []
          })
        : Promise.resolve([]),
    ])

    let segments = mergeSegments(whisper.segments || [], frames)
    let text = segments.map(s => [s.audio, s.visual].filter(Boolean).join(' ')).join('\n')
    let sourceKind = 'auto'

    // No words at all — a silent video, a transcriber that returned nothing, or
    // a frame pass that failed. Look at the video instead of giving up: without
    // text there is no exposure, because awareness.record() requires it, and the
    // watch data would be lost for a second time.
    if (!text.trim()) {
      const duration = whisper.duration ?? probe.duration
      const summary = await summariseFromFrames(videoPath, tmp, url, duration)
      if (summary) {
        text = summary
        sourceKind = 'frames'
        // end_s null on purpose: a summary describes the WHOLE video, so
        // sliceVideo includes it for any watched interval rather than only
        // those overlapping some arbitrary span.
        segments = [{ start_s: 0, end_s: null, audio: null, visual: summary }]
      }
    }

    return upsert({
      url, kind: 'video', text, segments, source_kind: sourceKind,
      meta: {
        duration_s: whisper.duration ?? probe.duration,
        frames: frames.length,
        has_visual: frames.length > 0 || sourceKind === 'frames',
        has_audio: probe.hasAudio,
        summarised_from_frames: sourceKind === 'frames',
      },
    })
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function downloadVideo(url, tmpDir) {
  const dest = path.join(tmpDir, 'video.mp4')
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 60_000,
    maxContentLength: video.maxDownloadMB * 1024 * 1024,
  })
  await new Promise((resolve, reject) => {
    const w = createWriteStream(dest)
    res.data.pipe(w)
    w.on('finish', resolve)
    w.on('error', reject)
  })
  return dest
}

// `hasAudio` is null, not false, when the probe itself failed: treating an
// unreadable probe as "no audio" would silently drop transcripts for perfectly
// good videos, which is a worse failure than the one this guards against.
export function probeVideo(videoPath) {
  return new Promise(resolve => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        resolve({ hasAudio: null, duration: undefined, error: err })
        return
      }
      resolve({
        hasAudio: (data?.streams || []).some(stream => stream.codec_type === 'audio'),
        duration: data?.format?.duration,
      })
    })
  })
}

// One frame at a given second, taken with a plain seek. Deliberately NOT the
// scene-detection filter chain the timeline pass uses — that is the thing that
// exits 251 on some perfectly playable files, and this exists for exactly the
// moment after it has already failed.
function grabFrame(videoPath, outPath, atSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(atSeconds)
      .frames(1)
      .outputOptions(['-q:v', '4'])
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath)
  })
}

// A video with no words still has something to say. When there is no audio
// track, or the transcriber returns nothing, sample a handful of frames across
// the whole runtime, describe each, and synthesise them into what the video is
// ABOUT — which is what an exposure needs in order to exist at all, since
// awareness.record() refuses a row with no text.
export async function summariseFromFrames(videoPath, tmpDir, url, durationS) {
  const dir = await mkdtemp(path.join(tmpDir, 'summary-'))
  const span = Number.isFinite(durationS) && durationS > 1 ? durationS : null
  // Skip the outer 5% at each end: title cards and black frames describe nothing.
  const times = span
    ? Array.from({ length: SUMMARY_FRAMES },
        (_, i) => span * (0.05 + (0.9 * (i + 0.5)) / SUMMARY_FRAMES))
    : Array.from({ length: SUMMARY_FRAMES }, (_, i) => i)

  const described = []
  for (const [i, t] of times.entries()) {
    try {
      const out = await grabFrame(videoPath, path.join(dir, `s-${i}.jpg`), t)
      const buf = await sharp(out).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()
      const desc = await ai.vision(FRAME_PROMPT, `data:image/jpeg;base64,${buf.toString('base64')}`,
        { detail: video.visionDetail, maxTokens: 80 })
      if (desc) described.push({ t, desc: String(desc).trim() })
    } catch (err) {
      // One unreadable frame should not cost the summary.
      logger.warn({ err, t: Math.round(t), url }, 'Summary frame failed')
    }
  }
  if (!described.length) {
    logger.warn({ url }, 'No frames could be described; the video has no text at all')
    return null
  }

  const listed = described.map(d => `[${Math.round(d.t)}s] ${d.desc}`).join('\n')
  let summary = null
  try {
    summary = await ai.prompt(SUMMARY_SYSTEM, listed)
  } catch (err) {
    // The descriptions on their own are already a usable account of the video.
    logger.warn({ err, url }, 'Frame summary synthesis failed; keeping the descriptions')
  }
  const text = String(summary || listed).trim()
  logger.info({ url, frames: described.length }, 'Video summarised from frames: %s', text)
  return text || null
}

function extractAudio(videoPath, tmpDir) {
  const audioPath = path.join(tmpDir, 'audio.mp3')
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .on('error', reject)
      .on('end', () => resolve(audioPath))
      .save(audioPath)
  })
}

async function extractAndDescribeFrames(videoPath, tmpDir, url) {
  const framesDir = path.join(tmpDir, 'frames')
  await mkdtemp(framesDir).catch(() => {})

  const period = video.framePeriodSec
  const scene = video.sceneThreshold

  const frames = await new Promise((resolve, reject) => {
    const result = []
    ffmpeg(videoPath)
      .outputOptions([
        // format=yuvj420p forces full-range YUV before the mjpeg encoder opens.
        // Without it, source video encoded with standard tv-range (limited)
        // YUV — the common case — makes the encoder refuse to open at all
        // ("ff_frame_thread_encoder_init failed"), which fluent-ffmpeg surfaces
        // as a hard process failure even when zero frames matched the scene
        // filter (an otherwise harmless, valid outcome for static/slow clips).
        `-vf select='gt(scene\\,${scene})+lt(prev_selected_t\\,t-${period})',scale=768:768:force_original_aspect_ratio=decrease,format=yuvj420p,showinfo`,
        '-vsync', 'vfr',
        '-q:v', '5',
      ])
      .on('stderr', line => {
        // showinfo emits "pts_time:<t>" — capture frame timestamps
        const m = line.match(/pts_time:([\d.]+)/)
        if (m) result.push({ t: parseFloat(m[1]), index: result.length })
      })
      .on('error', reject)
      .on('end', () => resolve(result))
      .save(path.join(framesDir, 'f-%04d.jpg'))
  })

  const limited = frames.slice(0, video.maxFrames)

  const descriptions = await Promise.all(limited.map(async (frame, i) => {
    const framePath = path.join(framesDir, `f-${String(i + 1).padStart(4, '0')}.jpg`)
    try {
      const buf = await sharp(framePath).jpeg({ quality: 80 }).toBuffer()
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
      const desc = await ai.vision(FRAME_PROMPT, dataUrl, { detail: video.visionDetail, maxTokens: 80 })
      logger.info({ url, t: frame.t }, 'Frame described [%ds]: %s', Math.round(frame.t), desc)
      return { t: frame.t, description: desc }
    } catch (err) {
      logger.warn({ err, t: frame.t }, 'Frame describe failed')
      return null
    }
  }))

  return descriptions.filter(Boolean)
}

function mergeSegments(whisperSegments, frameDescriptions) {
  const out = []
  for (const s of whisperSegments) {
    const visuals = frameDescriptions
      .filter(f => f.t >= s.start && f.t <= s.end)
      .map(f => f.description)
    out.push({
      start_s: s.start,
      end_s: s.end,
      audio: s.text?.trim() || null,
      visual: visuals.length ? visuals.join(' | ') : null,
    })
  }
  // Capture visuals between/after audio segments as visual-only segments
  if (frameDescriptions.length) {
    const audioEnd = whisperSegments.length ? whisperSegments[whisperSegments.length - 1].end : 0
    const leftover = frameDescriptions.filter(f => f.t > audioEnd)
    if (leftover.length) {
      out.push({
        start_s: audioEnd,
        end_s: leftover[leftover.length - 1].t,
        audio: null,
        visual: leftover.map(f => f.description).join(' | '),
      })
    }
  }
  return out
}

function parseProvidedTranscript(transcript) {
  // Accepts: string (single segment) or [{ start_s, end_s, audio, visual }]
  if (typeof transcript === 'string') {
    return [{ start_s: 0, end_s: null, audio: transcript, visual: null }]
  }
  if (Array.isArray(transcript)) return transcript
  return []
}

// -------- slicing --------
//
// sliceVideo(content, intervals)
//   intervals: [{ start_s, end_s }, ...]  — watched ranges
//   - null/empty intervals → full text
//   - single object { start_s, end_s } → wrapped as one-element array (back-compat)
//   - legacy two-arg call (start_s, end_s) → wrapped to one interval
//
// Returns the concatenated transcript text for every segment that overlaps
// ANY interval, joined by newline. Each segment is included at most once.

export function sliceVideo(content, intervalsOrStart, endS) {
  if (!content.segments?.length) return content.text || ''

  let intervals = intervalsOrStart
  // Legacy two-arg form
  if (typeof intervalsOrStart === 'number' || typeof endS === 'number') {
    intervals = [{ start_s: intervalsOrStart, end_s: endS }]
  }
  // Single-object form
  if (intervals && !Array.isArray(intervals) && typeof intervals === 'object') {
    intervals = [intervals]
  }
  if (!intervals?.length) return content.text || ''

  const ranges = intervals
    .filter(r => r && (r.end_s == null || r.end_s > (r.start_s ?? 0)))
    .map(r => ({ from: r.start_s ?? 0, to: r.end_s ?? Infinity }))

  if (!ranges.length) return content.text || ''

  return content.segments
    .filter(s => {
      if (s.end_s == null) return true
      return ranges.some(r => s.end_s >= r.from && s.start_s <= r.to)
    })
    .map(s => [s.audio, s.visual].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
}

// -------- store --------

async function upsert(row) {
  // Explicit JSON.stringify for the jsonb columns rather than relying on the
  // driver to serialize plain objects/arrays — segments/meta hold free-form
  // AI-generated text (Whisper transcripts, vision captions) that can embed
  // quotes/newlines, and letting those through un-stringified has produced
  // invalid JSON at the wire level ("invalid input syntax for type json").
  const prepared = {
    ...row,
    segments: row.segments != null ? JSON.stringify(row.segments) : row.segments,
    meta: row.meta != null ? JSON.stringify(row.meta) : row.meta,
  }
  const [out] = await db(TABLE).insert(prepared).onConflict('url').merge().returning('*')
  return out
}

export async function invalidate(url) {
  return db(TABLE).where({ url }).del()
}

// -------- health --------
//
// Self-describing health for monitoring surfaces (see docs/10-plugin-status.md).
// The only thing this plugin can honestly answer is "is content resolution
// working": every video/image a visitor engages with is resolved ONCE — Whisper
// transcript, Vision description — and cached in this table forever, so the
// table is the entire trace that pipeline leaves.
//
// There is no failure row to count, and inventing one would be a lie: when
// resolveImage/resolveVideo throws, videos.js/images.js log the warning and
// swallow it, and NOTHING is written here. What is observable is the entry that
// was written with no usable text — the caller then returns early (no awareness
// record), and because the row is cached it is never retried either. A failing
// transcription pipeline that still produces rows looks exactly like that, which
// is why it's the one metric marked bad.
export async function status({ since } = {}) {
  try {
    // Resolutions ARE history — windowed on generated_at, which is the first
    // resolution's timestamp (upsert's merge() never carries a new one).
    const byKindQ = db(TABLE).select('kind').count('* as n').groupBy('kind')
    if (since) byKindQ.where('generated_at', '>=', since instanceof Date ? since : new Date(since))
    const byKind = Object.fromEntries((await byKindQ).map(r => [r.kind, Number(r.n)]))

    // NOT windowed, deliberately: this is the current state of the cache, not an
    // event. An empty entry generated last month still silently drops every view
    // of that URL today, until someone invalidates it.
    const [blank] = await db(TABLE)
      .where(b => b.whereNull('text').orWhere('text', ''))
      .count()
    const noText = Number(blank?.count ?? 0)

    return {
      label: 'engagement',
      metrics: [
        { key: 'transcribed', value: byKind.video || 0,
          description: 'Videos we read the words from, to track what was watched' },
        { key: 'described', value: byKind.image || 0,
          description: 'Images we read the content of, to track what was seen' },
        // `live`, matching the query above: this counts the whole cache, not the
        // window. Without the flag the board would show it beside the two windowed
        // counts and imply all three moved together when the window changed.
        { key: 'no text', value: noText, severity: 'bad', live: true,
          description: 'Videos or images we could not read — views go untracked' },
      ],
      note: noText
        ? `${noText} cached entr${noText === 1 ? 'y' : 'ies'} resolved to no text (whole cache, not the window) — every view of those URLs records nothing until they're invalidated`
        : null,
    }
  } catch (err) {
    // A broken status() must not take the monitoring board down — a partial
    // answer beats throwing (docs/10-plugin-status.md).
    logger?.warn?.({ err }, 'engagement.status failed')
    return { label: 'engagement', metrics: [], note: 'content cache could not be read' }
  }
}
