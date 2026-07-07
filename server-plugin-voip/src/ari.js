// ARI-backed PBX observer. Replaces the AMI + Apache-monitor combo with a
// single WebSocket connection to Asterisk Rest Interface.
//
// PBX-side requirement: every inbound call must enter the Stasis app named
// in `config.voip.ari.app` (default `whitebox`). Typical extensions.conf:
//
//   exten => _X.,1,NoOp(inbound)
//   exten => _X.,n,Stasis(whitebox)
//   exten => _X.,n,Hangup()
//
// Once the channel enters Stasis, whitebox answers it, starts an
// ARI-managed recording, and bridges out to the dialplan agent. When the
// channel ends, the recording auto-finalises and is fetched over HTTP.

import { connect } from 'ari-client'
import { createHash } from 'crypto'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import createNotify from 'whitebox-pro-server/notify'

import * as calls from './calls.js'
import * as phonebook from './phonebook.js'
import * as pool from './pool.js'
import * as encoder from './encoder.js'
import * as speech from './speech.js'

function vaultId(linkedId) {
  return createHash('sha256').update(linkedId).digest('hex').slice(0, 32)
}

let voipConfig, ariCfg, logger, passports, sessions, awareness, speechEnabled, notify

let client = null
// channelId → { vaultId, recordingName, passportId, sessionId, visitor, ringDate, pickDate }
const calls_ = new Map()

const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000
let watchdogTimer = null
let reconnecting = false

export function init(deps) {
  voipConfig = deps.config.voip
  ariCfg = voipConfig.ari || {}
  logger = deps.logger
  passports = deps.passports
  sessions = deps.sessions
  awareness = deps.awareness
  speechEnabled = deps.speechEnabled
  const created = createNotify({ webhooksConfig: voipConfig.webhooks, events: deps.events, webhooks: deps.webhooks })
  notify = created.notify

  return start()
}

// ari-client's swagger-client dependency (old, unmaintained) has a bug: on a
// bad URL/auth/unreachable host, SwaggerApi.prototype.fail() correctly calls
// its failure callback (rejecting connect()'s promise) but then *also*
// synchronously re-throws the same error — from inside an HTTP response
// callback, not the promise chain, so it becomes a genuine uncaught
// exception that kills the whole process regardless of any surrounding
// try/catch or .catch(). voip.js's own contract is that a PBX is optional
// and its absence/misconfiguration must degrade gracefully, so we trap that
// specific redundant throw for the duration of the connect() call only.
//
// Same scope, second nuisance: while parsing Asterisk's api-docs (which are
// served as ancient Swagger 1.1 — inherent to Asterisk's ARI, not fixable
// here), swagger-client prints "This API is using a deprecated version of
// Swagger!" via a bare console.log(argsArray), bypassing our logger. Purely
// cosmetic and unavoidable, so we drop exactly that line, only while
// connect() runs.
const SWAGGER_NOISE = 'deprecated version of Swagger'

function connectAri(url, user, password) {
  return new Promise((resolve, reject) => {
    const consoleLog = console.log
    console.log = (...args) => {
      // swagger-client logs as console.log([msg, ...]) — check both shapes.
      const first = Array.isArray(args[0]) ? args[0][0] : args[0]
      if (typeof first === 'string' && first.includes(SWAGGER_NOISE)) return
      consoleLog(...args)
    }

    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      process.removeListener('uncaughtException', onUncaught)
      console.log = consoleLog
      fn(value)
    }
    const onUncaught = err => settle(reject, err)
    process.on('uncaughtException', onUncaught)

    connect(url, user, password).then(
      client => settle(resolve, client),
      err => settle(reject, err),
    )
  })
}

async function start() {
  if (!ariCfg.url || !ariCfg.user || !ariCfg.password) {
    throw new Error('voip.ari requires { url, user, password } in config')
  }
  await connectAndStart()
  startWatchdog()
}

// Connect + attach listeners + register the Stasis app. Split out from
// start() so reconnect() (the watchdog's recovery path) can redo exactly
// this without re-validating config or re-arming the watchdog interval.
async function connectAndStart() {
  client = await connectAri(ariCfg.url, ariCfg.user, ariCfg.password)
  logger.info('ARI connected at %s', ariCfg.url)

  client.on('StasisStart',       wrap(onStasisStart))
  client.on('ChannelStateChange', wrap(onStateChange))
  client.on('StasisEnd',         wrap(onStasisEnd))
  client.on('ChannelDestroyed',  wrap(onChannelDestroyed))
  client.on('APILoadError',      err => logger.error({ err }, 'ARI API load error'))
  client.on('WebSocketReconnecting', () => logger.warn('ARI WebSocket reconnecting'))

  const appName = ariCfg.app || 'whitebox'
  await client.start(appName)
  logger.info('ARI Stasis app started: %s', appName)
}

// A plain ARI GET over the REST API (not the WebSocket) — used by the
// watchdog specifically because it must not trust the same transport it's
// checking. Resolves the parsed JSON body, or rejects on any non-2xx/network
// failure.
function ariGet(pathname) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${ariCfg.url.replace(/\/$/, '')}${pathname}`)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      method: 'GET',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: 5000,
      headers: {
        authorization: 'Basic ' + Buffer.from(`${ariCfg.user}:${ariCfg.password}`).toString('base64'),
      },
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ARI GET ${pathname} → ${res.statusCode}`))
        }
        try { resolve(JSON.parse(body)) } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`ARI GET ${pathname} timed out`)))
    req.on('error', reject)
    req.end()
  })
}

// Watchdog: ari-client's WebSocket can die silently — no 'WebSocketReconnecting',
// no error event, nothing — leaving the Stasis app unregistered on Asterisk's
// side while whitebox believes it's still connected (observed in production:
// fresh start → app registered; hours later, zero log activity → app gone
// from `GET /ari/applications`). client.on('WebSocketReconnecting') only
// fires for disconnects ari-client itself detects, which doesn't cover this
// case — hence a REST-based external check, independent of that same socket.
function startWatchdog() {
  const intervalMs = ariCfg.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
  if (!intervalMs) return   // 0/false disables it (e.g. tests)

  const appName = ariCfg.app || 'whitebox'
  watchdogTimer = setInterval(() => {
    ariGet(`/ari/applications/${encodeURIComponent(appName)}`).catch(err => {
      logger.warn({ err }, 'ARI watchdog: app %s unreachable/unregistered — reconnecting', appName)
      reconnect()
    })
  }, intervalMs)
  watchdogTimer.unref?.()
}

async function reconnect() {
  if (reconnecting) return   // a check already in flight triggered this
  reconnecting = true
  try {
    if (client) { try { await client.stop() } catch { /* already dead — fine */ } }
    calls_.clear()   // in-flight call state is meaningless across a reconnect
    await connectAndStart()
    logger.info('ARI watchdog: reconnected')
  } catch (err) {
    logger.error({ err }, 'ARI watchdog: reconnect failed — will retry next tick')
  } finally {
    reconnecting = false
  }
}

// Wrap an async handler so it can't crash the event loop. Logs and swallows
// errors, returns the promise so awaiters (and tests) can synchronise on it.
function wrap(fn) {
  return async (event, channel, ...rest) => {
    try {
      return await fn(event, channel, ...rest)
    } catch (err) {
      logger.error({ err, eventType: event?.type, channelId: channel?.id }, 'ARI handler failed')
    }
  }
}

// Inbound call enters our Stasis app. Treat as ring.
async function onStasisStart(event, channel) {
  const id = channel.id
  const linkedId = channel.linkedid || id
  const v = vaultId(linkedId)
  const date = new Date()

  // Skip snoop channels — they enter Stasis when we ourselves create them
  // (recording machinery, below). They aren't customer calls.
  if (event?.args?.includes('snoop')) return

  const callerNum = channel.caller?.number || channel.caller_number || ''
  const lineNum   = channel.dialplan?.exten || channel.exten || ''

  const region = phonebook.guessRegionByLineIn(lineNum)
  let caller, line
  try {
    line   = phonebook.toE164(lineNum, region)
    caller = phonebook.toE164(callerNum, region)
  } catch (err) {
    logger.error({ err, callerNum, lineNum }, 'ring: failed to parse numbers; continuing channel in dialplan')
    return continueInDialplan(channel)
  }

  const tag = phonebook.findLine(line) || 'default'
  const visitor = pool.find(line)

  let passportId
  if (visitor?.passportId) {
    passportId = visitor.passportId
    passports.link(passportId, [{ type: 'phone', name: 'e164', value: caller }])
      .catch(err => logger.warn({ err }, 'Failed to link phone to passport: %s', passportId))
  } else {
    try {
      passportId = await passports.identify(null)
      await passports.link(passportId, [{ type: 'phone', name: 'e164', value: caller }])
    } catch (err) {
      logger.warn({ err }, 'Failed to identify/link caller passport: %s', caller)
    }
  }

  await calls.ring({ vaultId: v, passportId, sessionId: visitor?.sessionId || null, caller, line, tag, date })

  logger.info(
    { vaultId: v, caller, line, tag, passportId, attributed: !!visitor },
    'Call ring: %s → %s (%s)', caller, line, tag,
  )

  if (visitor) pool.notifyRing(visitor.connectionId, { tag, caller })

  const call = await calls.find(v)
  const session = await sessionFor(call)
  await notify('voip.ring', { type: 'voip.ring', date, data: call, session })

  // Answer the channel + start an ARI-managed recording, then hand back to
  // the dialplan so normal queue / agent routing applies.
  const recordingName = `wb-${v}-${Date.now()}`
  try {
    await channel.answer()
  } catch (err) {
    logger.error({ err, channelId: channel.id }, 'Failed to answer channel; continuing anyway')
  }
  try {
    await channel.record({
      name: recordingName,
      format: 'wav',
      ifExists: 'overwrite',
      beep: false,
      maxDurationSeconds: 0,
      maxSilenceSeconds: 0,
      terminateOn: 'none',
    })
  } catch (err) {
    logger.error({ err, channelId: channel.id, recordingName }, 'Failed to record channel; continuing anyway')
  }

  calls_.set(id, {
    vaultId: v,
    recordingName,
    passportId,
    sessionId: visitor?.sessionId || null,
    ringDate: date,
    caller,
    line,
  })

  // Let the call continue through the dialplan to the agent.
  await continueInDialplan(channel)
}

function continueInDialplan(channel) {
  return channel.continueInDialplan({
    context:   ariCfg.continueContext   || 'from-internal',
    extension: channel.dialplan?.exten,
    priority:  1,
  }).catch(err => logger.warn({ err, channelId: channel.id }, 'continueInDialplan failed'))
}

// Track the moment the call is actually picked up (state == Up).
async function onStateChange(event, channel) {
  if (channel.state !== 'Up') return
  const entry = calls_.get(channel.id)
  if (!entry || entry.pickDate) return                  // not ours / already picked
  const date = new Date()
  entry.pickDate = date

  let destination = ''
  try {
    destination = phonebook.toE164(channel.caller?.number || '', voipConfig.country)
  } catch { /* destination is the agent's local extension; OK if it doesn't parse */ }

  await calls.pick({ vaultId: entry.vaultId, destination, date })

  logger.info(
    { vaultId: entry.vaultId, caller: entry.caller, line: entry.line, destination, waitMs: entry.ringDate ? date - entry.ringDate : null },
    'Call picked: %s', entry.caller,
  )

  const call = await calls.find(entry.vaultId)
  const session = await sessionFor(call)
  await notify('voip.pick', { type: 'voip.pick', date, data: call, session })
}

// Channel left our Stasis app (handed to dialplan). We don't tear down here
// — we still want ChannelDestroyed when the call eventually ends.
async function onStasisEnd(event, channel) {
  // No-op; we keep the entry alive until destruction so we can fetch the
  // recording once it finalises.
}

async function onChannelDestroyed(event, channel) {
  const entry = calls_.get(channel.id)
  if (!entry) return
  calls_.delete(channel.id)
  const date = new Date()

  // Fetch the recording bytes from ARI. The recording stops automatically
  // when the channel ends; ARI moves it from /recordings/live to /stored.
  const localFile = await fetchRecording(entry.recordingName).catch(err => {
    logger.error({ err, recordingName: entry.recordingName }, 'ARI recording fetch failed')
    return null
  })

  if (!localFile) {
    await calls.end({ vaultId: entry.vaultId, date })
    logger.info(
      { vaultId: entry.vaultId, caller: entry.caller, line: entry.line, recorded: false },
      'Call ended (no recording): %s', entry.caller,
    )
    return
  }

  const dur = await encoder.duration(localFile).catch(() => 0)
  const mp3 = await encoder.encode(localFile).catch(err => {
    logger.error({ err }, 'Encoding failed')
    return localFile
  })

  let transcription
  if (speechEnabled && dur > 5) {
    transcription = await speech.transcribe(mp3).catch(err => {
      logger.error({ err }, 'Transcription failed')
    })
    if (transcription) {
      logger.info({ vaultId: entry.vaultId, caller: entry.caller }, 'Call transcribed: %s', transcription)
    }
  }

  const link = `${voipConfig.url}/voip/records/${mp3}`
  const call = await calls.end({ vaultId: entry.vaultId, duration: dur, record: mp3, link, transcription, date })

  logger.info(
    { vaultId: entry.vaultId, caller: entry.caller, line: entry.line, duration: dur, recorded: true, transcribed: !!transcription },
    'Call ended: %s (%ds%s)', entry.caller, dur, transcription ? ', transcribed' : '',
  )

  if (call) {
    const session = await sessionFor(call)
    await notify('voip.call', { type: 'voip.call', date, data: call, session })

    if (awareness && call.passport_id && call.transcription) {
      await awareness.record({
        passport_id: call.passport_id,
        session_id:  call.session_id,
        ts:          call.ended_at || date,
        channel:     'voip',
        direction:   'conversation',
        source:      'call',
        content_id:  `call:${call.vault_id}`,
        content_url: call.link,
        text:        call.transcription,
        dwell_ms:    call.duration ? call.duration * 1000 : null,
        meta: {
          caller: call.caller, line: call.line, destination: call.destination,
          tag: call.tag, vault_id: call.vault_id,
        },
      }).catch(err => logger.warn({ err, vaultId: call.vault_id }, 'awareness.record failed'))
    }
  }
}

// Download a stored recording from ARI to the local records folder.
// ARI's /recordings/stored/{name}/file returns the binary directly with
// whatever format the recording was made in (.wav for us).
async function fetchRecording(recordingName) {
  const url = `${ariCfg.url.replace(/\/$/, '')}/ari/recordings/stored/${encodeURIComponent(recordingName)}/file`
  const localName = `${crypto.randomUUID()}.wav`
  const dest = path.join(voipConfig.recordsFolder, localName)
  await new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      method: 'GET',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        authorization: 'Basic ' + Buffer.from(`${ariCfg.user}:${ariCfg.password}`).toString('base64'),
      },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`ARI fetch ${res.statusCode}`))
      }
      const writer = fs.createWriteStream(dest)
      res.pipe(writer)
      writer.on('finish', resolve)
      writer.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })

  // Best-effort: delete the recording from ARI so it doesn't accumulate
  // on the PBX disk. Not fatal if it fails.
  client?.recordings?.deleteStored?.({ recordingName })
    .catch(err => logger.warn({ err, recordingName }, 'ARI deleteStored failed'))

  return localName
}

async function sessionFor(call) {
  if (!call?.session_id) return null
  return sessions.findById(call.session_id).catch(() => null)
}

export async function stop() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  if (!client) return
  try { await client.stop() } catch { /* ignore */ }
  client = null
}
