import path from 'path'
import { unlink } from 'fs/promises'
import ffmpeg from 'fluent-ffmpeg'

let recordsFolder, logger

export function init(deps) {
  recordsFolder = deps.config.voip.recordsFolder
  logger = deps.logger
  probeFfmpeg()
}

// Say at BOOT whether the binaries this module needs exist, because their absence is
// otherwise invisible until it has already cost you call data.
//
// fluent-ffmpeg shells out to the system ffmpeg/ffprobe — they are not npm dependencies,
// so `npm install` succeeds without them and nothing here fails at import time. What
// happens instead: duration() rejects, ari.js catches it into `0`, encode() rejects into a
// generic 'Encoding failed', and since transcription is gated on `dur > 5`, every call is
// recorded with a 0-second duration and no transcript. Nothing says why.
//
// That cost a 69-second production call on 2026-08-05 its duration and its transcript, on a
// container where ffmpeg had simply never been installed.
//
// A warning, not a throw: recording is one plugin's feature, and taking down a whole
// whitebox because transcription will be degraded is the wrong trade. But it must be
// impossible to miss in the log.
function probeFfmpeg() {
  ffmpeg.getAvailableFormats(err => {
    if (!err) return
    logger?.warn?.({ err },
      'ffmpeg/ffprobe not usable — call recordings will have duration 0 and will NOT be ' +
      'transcribed. Install ffmpeg on this host (apt-get install ffmpeg).')
  })
}

export function duration(filename) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path.join(recordsFolder, filename), (err, meta) => {
      if (err) reject(err)
      else resolve(Math.floor(meta.format.duration))
    })
  })
}

export function encode(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.mp3') return Promise.resolve(filename)

  const src = path.join(recordsFolder, filename)
  const mp3 = filename.slice(0, -ext.length) + '.mp3'
  const dest = path.join(recordsFolder, mp3)

  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .on('error', reject)
      .on('end', () => {
        unlink(src)
          .catch(err => logger.warn({ err }, 'Could not delete source: %s', filename))
          .then(() => resolve(mp3))
      })
      .save(dest)
  })
}
