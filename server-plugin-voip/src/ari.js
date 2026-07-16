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
//
// Transport is hand-rolled (fetch + ws) rather than the `ari-client` package:
// ari-client's swagger-client dependency (old, unmaintained, last released
// 2019) discovers the full ARI resource surface via a burst of near-
// simultaneous HTTP requests against Asterisk's built-in mini-HTTP server.
// That discovery step reliably hung forever over HTTPS specifically (plain
// HTTP, and every other HTTPS client we tried against the same endpoint —
// curl, openssl s_client, a raw Node https.get — worked fine), with no
// timeout and no error, just a dead promise. ARI itself is only REST + one
// WebSocket event stream; the actual surface this file needs is a handful of
// endpoints, so there's no discovery to get stuck in.

import WebSocket from 'ws'
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

let ws = null
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

// A single REST call against ARI. Operation parameters are ARI's own
// convention — sent as query-string params, not a JSON body, on every
// method including POST. Returns the parsed JSON body, or null for 204s.
function ariRequest(method, pathname, params = {}) {
  const u = new URL(`${ariCfg.url.replace(/\/$/, '')}${pathname}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v)
  }
  return fetch(u, {
    method,
    headers: {
      authorization: 'Basic ' + Buffer.from(`${ariCfg.user}:${ariCfg.password}`).toString('base64'),
    },
  }).then(async res => {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ARI ${method} ${pathname} → ${res.status}${body ? ' ' + body : ''}`)
    }
    if (res.status === 204) return null
    return res.json().catch(() => null)
  })
}

const answerChannel   = (id)       => ariRequest('POST', `/ari/channels/${encodeURIComponent(id)}/answer`)
const recordChannel   = (id, opts) => ariRequest('POST', `/ari/channels/${encodeURIComponent(id)}/record`, opts)
const continueChannel = (id, opts) => ariRequest('POST', `/ari/channels/${encodeURIComponent(id)}/continue`, opts)
const deleteRecording = (name)     => ariRequest('DELETE', `/ari/recordings/stored/${encodeURIComponent(name)}`)
const snoopChannel    = (id, opts) => ariRequest('POST', `/ari/channels/${encodeURIComponent(id)}/snoop`, opts)
const hangupChannel   = (id)       => ariRequest('DELETE', `/ari/channels/${encodeURIComponent(id)}`)

// A channel's implicit event subscription (granted by entering Stasis) ends
// once it leaves the app via continue() — its later ChannelStateChange and
// ChannelDestroyed events stop arriving on our websocket entirely. Every
// historical call in whitebox_voip_calls is stuck at status='ringing' with
// no ended_at because of exactly this: nothing ever heard the hangup.
// Explicitly subscribing to the channel keeps events flowing after the
// handoff, independent of Stasis membership.
const subscribeToChannel = (id) => ariRequest('POST', `/ari/applications/${encodeURIComponent(ariCfg.app || 'whitebox')}/subscription`, { eventSource: `channel:${id}` })

function ariEventsUrl(appName) {
  const u = new URL(ariCfg.url)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ari/events'
  u.search = `?app=${encodeURIComponent(appName)}&api_key=${encodeURIComponent(ariCfg.user)}:${encodeURIComponent(ariCfg.password)}`
  return u.toString()
}

// Opens the ARI event WebSocket and resolves once it's actually open —
// mirrors ari-client's connect()+start() combined into one step, since
// there's no separate discovery phase to do first.
function connectWebSocket(appName) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ariEventsUrl(appName))
    let settled = false
    socket.once('open', () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
    socket.once('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

const EVENT_HANDLERS = {
  StasisStart:        (event, channel) => wrap(onStasisStart)(event, channel),
  ChannelStateChange:  (event, channel) => wrap(onStateChange)(event, channel),
  StasisEnd:           (event, channel) => wrap(onStasisEnd)(event, channel),
  ChannelDestroyed:    (event, channel) => wrap(onChannelDestroyed)(event, channel),
}

function attachHandlers(socket) {
  socket.on('message', raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch (err) {
      logger.error({ err }, 'ARI WS: malformed event payload')
      return
    }
    const handle = EVENT_HANDLERS[event.type]
    if (handle) handle(event, event.channel)
  })
  socket.on('close', () => logger.warn('ARI WebSocket closed'))
  socket.on('error', err => logger.error({ err }, 'ARI WebSocket error'))
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
  const appName = ariCfg.app || 'whitebox'
  ws = await connectWebSocket(appName)
  attachHandlers(ws)
  logger.info('ARI connected at %s', ariCfg.url)
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

// Watchdog: the ARI WebSocket can die silently — no close event, no error,
// nothing — leaving the Stasis app unregistered on Asterisk's side while
// whitebox believes it's still connected (observed in production: fresh
// start → app registered; hours later, zero log activity → app gone from
// `GET /ari/applications`). Hence a REST-based external check, independent
// of that same socket.
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
    if (ws) { try { ws.close() } catch { /* already dead — fine */ } }
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

  try {
    await answerChannel(id)
  } catch (err) {
    logger.error({ err, channelId: channel.id }, 'Failed to answer channel; continuing anyway')
  }

  // Register the entry immediately after answering — answerChannel() is
  // what triggers the ChannelStateChange(Up) event, and onStateChange
  // needs calls_.get(id) to already exist when that event arrives. The
  // snoop/record calls below take real network round-trips; delaying
  // calls_.set() until after them left a race where "Call picked" was
  // silently missed (the state-change event arrived before the entry did).
  const recordingName = `wb-${v}-${Date.now()}`
  const entry = {
    vaultId: v,
    recordingName,
    snoopId: null,
    passportId,
    sessionId: visitor?.sessionId || null,
    ringDate: date,
    caller,
    line,
  }
  calls_.set(id, entry)

  // Record via a snoop channel rather than the main channel directly. On a
  // real PJSIP channel, an active ARI-managed recording blocks Stasis'
  // continue from ever taking effect — the channel just sits in Stasis
  // until the recording stops (reproduced directly against this PBX), and
  // recording can't be (re)started once a channel has left Stasis either
  // (ARI 409s: "Channel not in Stasis application"). A snoop channel is a
  // separate ARI-controlled channel tapping this one's audio, so the main
  // channel is free to continue immediately while the snoop keeps
  // recording for the life of the call.
  try {
    const snoop = await snoopChannel(id, {
      spy: 'both',
      app: ariCfg.app || 'whitebox',
      appArgs: 'snoop',
    })
    entry.snoopId = snoop.id
    await recordChannel(snoop.id, {
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

  // Keep receiving this channel's events after it leaves Stasis (see
  // subscribeToChannel above) — otherwise onStateChange/onChannelDestroyed
  // never fire again once continueInDialplan hands it back to the dialplan.
  await subscribeToChannel(id).catch(err => logger.warn({ err, channelId: id }, 'subscribeToChannel failed'))

  await continueInDialplan(channel)
}

// No explicit context/extension/priority: ARI's /continue, given an
// explicit cross-context target, is accepted (204) but the channel's
// dialplan resumption is delayed by tens of seconds to over a minute —
// long enough that real callers give up and hang up first (reproduced
// directly against this PBX). A bare continue resumes at the next
// priority in the SAME context Stasis() was called from — which the
// dialplan already points at the ring group — and takes effect
// immediately.
function continueInDialplan(channel) {
  return continueChannel(channel.id, {})
    .catch(err => logger.warn({ err, channelId: channel.id }, 'continueInDialplan failed'))
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

  // The recording lives on a snoop channel (see onStasisStart), which
  // doesn't necessarily hang up in lockstep with the channel it was
  // snooping. Hang it up explicitly so its recording finalises into
  // /recordings/stored before we try to fetch it, rather than racing
  // whatever implicit cleanup Asterisk does on its own.
  if (entry.snoopId) {
    await hangupChannel(entry.snoopId).catch(() => {})
  }

  // Fetch the recording bytes from ARI. ARI moves it from
  // /recordings/live to /stored once the snoop channel's recording stops.
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
  deleteRecording(recordingName)
    .catch(err => logger.warn({ err, recordingName }, 'ARI deleteStored failed'))

  return localName
}

async function sessionFor(call) {
  if (!call?.session_id) return null
  return sessions.findById(call.session_id).catch(() => null)
}

export async function stop() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  if (!ws) return
  try { ws.close() } catch { /* ignore */ }
  ws = null
}
