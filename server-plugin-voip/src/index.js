import path from 'path'
import { mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import express from 'express'

import * as calls from './calls.js'
import * as phonebook from './phonebook.js'
import * as pool from './pool.js'
import * as encoder from './encoder.js'
import * as speech from './speech.js'
import createNotify from 'whitebox-pro-server/notify'

import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: voip({ country, lines: [...], context, transcription, ari, webhooks }).
export function voip(options = {}) {
  return {
    name: 'voip',
    options,   // exposed for read-only introspection (e.g. scripts/probe-ari.js)

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_voip_migrations',
      })
    },

    async register(app, ctx) {
      const { db, webhooks, events, connect, passports, sessions, ai, awareness } = ctx
      const voipConfig = options
      // The sub-module inits (phonebook/encoder/pool/speech/ari) read `config.voip`
      // and `config.ai` — give them a local config with this plugin's options as the
      // voip block, so they stay unchanged while the source of truth is the factory arg.
      const config = { ...ctx.config, voip: voipConfig }
      const logger = ctx.logger.child({ component: 'voip' })

      // Resolve relative to the server's working dir (like `context` below), with a
      // local default — so recordings land under the running server, not an absolute
      // path like /var that may not be writable. An absolute config value is kept as-is.
      const recordsFolder = path.resolve(process.cwd(), voipConfig.recordsFolder || 'recordings')
      voipConfig.recordsFolder = recordsFolder   // normalize once so encoder/speech/ari read the resolved path too

      // Best-effort: recordings only exist with a PBX, so don't let a non-writable
      // path stop the plugin from loading (call-tracking numbers don't need it).
      await mkdir(recordsFolder, { recursive: true })
        .catch(err => logger.warn({ err, recordsFolder }, 'VoIP: could not create recordsFolder'))

      const { notify } = createNotify({ webhooksConfig: voipConfig.webhooks, events, webhooks })

      // Init module singletons in dependency order.
      phonebook.init({ config })
      calls.init({ db })
      encoder.init({ config, logger })
      pool.init({ config, connect, notify, logger })

      const contextPath = voipConfig.context ? path.resolve(process.cwd(), voipConfig.context) : null
      const context     = contextPath && existsSync(contextPath) ? readFileSync(contextPath, 'utf8').trim() : null
      const speechEnabled = !!(voipConfig.transcription && config.ai?.apiKey)
      if (speechEnabled) await speech.init({ config, ai, logger, context })

      // The PBX (Asterisk/ARI) is OPTIONAL. Without it, call-tracking numbers are
      // still assigned and shown to visitors over the socket — only the live
      // inbound-call ingestion needs a PBX (or a telephony-provider webhook).
      if (voipConfig.ari?.url) {
        // Lazy-load: only pay ari.js's ws import when a PBX is actually
        // configured; call-tracking doesn't need it.
        const ari = await import('./ari.js')
        await ari.init({
          config, webhooks, events, logger,
          passports, sessions, awareness, speechEnabled,
        }).catch(err => logger.warn({ err }, 'VoIP: PBX/ARI unavailable — running without live call ingestion'))
      } else {
        logger.info('VoIP: no PBX/ARI configured — call-tracking numbers active, live ingestion off')
      }

      app.use('/voip/records', express.static(recordsFolder))

      // Call ingestion WITHOUT a PBX: a telephony provider/dialer (or the demo's
      // "simulate call") POSTs a completed call here — WhiteBox stays an observer
      // either way (the PBX/dialer decides who to call and when; we just record
      // what happened, same as ARI does automatically when there IS a PBX).
      //
      // `direction` distinguishes the two scenarios:
      //   'inbound'  (default) — the customer dialed one of OUR tracked numbers,
      //              so `number` is looked up in the DNI pool to find who's holding it.
      //   'outbound' — WE called the customer, so `number` is THEIR real phone —
      //              not something the pool tracks. Resolve/create their passport by
      //              phone identity instead, the exact same strong-identity link
      //              ari.js's own live inbound path already falls back to for an
      //              anonymous caller with no live web session (STRONG identities
      //              non-destructively merge into whatever passport already holds
      //              that phone — see server/src/passports.js).
      app.post('/voip/calls', async (req, res) => {
        const { number, caller = null, transcription = '', duration = null, ts, direction = 'inbound' } = req.body || {}
        if (!number) return res.status(400).json({ error: 'number is required' })

        let passportId, sessionId, tag
        if (direction === 'outbound') {
          let recipient
          try {
            recipient = phonebook.toE164(number, voipConfig.country)
          } catch (err) {
            logger.error({ err, number }, 'voip call ingest: failed to parse outbound recipient number')
            return res.status(400).json({ error: 'could not parse number' })
          }
          try {
            passportId = await passports.identify(null)
            await passports.link(passportId, [{ type: 'phone', name: 'e164', value: recipient }])
          } catch (err) {
            logger.warn({ err }, 'Failed to identify/link outbound call recipient: %s', recipient)
          }
          const session = passportId ? await sessions.resolve(passportId).catch(() => null) : null
          sessionId = session?.id || null
        } else {
          const holder = pool.findByNumber(number)
          if (!holder?.passportId) return res.status(202).json({ reason: 'no_visitor_for_number' })
          passportId = holder.passportId
          sessionId = holder.sessionId
          tag = holder.tag
        }

        try {
          await awareness.record({
            passport_id: passportId,
            session_id:  sessionId,
            ts:          ts ? new Date(ts) : new Date(),
            channel:     'voip',
            direction:   'conversation',
            source:      'call',
            content_id:  `call:webhook:${number}:${ts || Date.now()}`,
            text:        transcription || '(call connected, no transcript)',
            dwell_ms:    duration ? duration * 1000 : null,
            meta: { caller, line: number, tag, via: 'webhook', call_direction: direction },
          })
          res.json({ passport_id: passportId, recorded: true })
        } catch (err) {
          logger.error({ err }, 'voip call ingest failed')
          res.status(500).json({ error: 'voip call ingest failed' })
        }
      })

      registerMcp(ctx, { db })

      logger.info('VoIP plugin ready')
    },
  }
}
