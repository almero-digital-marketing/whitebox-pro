import path from 'path'
import { mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import express from 'express'

import * as calls from './calls.js'
import * as phonebook from './phonebook.js'
import * as pool from './pool.js'
import * as ari from './ari.js'
import * as encoder from './encoder.js'
import * as speech from './speech.js'
import createNotify from 'whitebox-server/notify'

import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  name: 'voip',

  async migrate(db) {
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      tableName: 'whitebox_voip_migrations',
    })
  },

  async register(app, ctx) {
    const { config, db, webhooks, events, connect, passports, sessions, ai, awareness } = ctx
    const voipConfig = config.voip
    const logger = ctx.logger.child({ plugin: 'voip' })

    await mkdir(voipConfig.recordsFolder, { recursive: true })

    const { notify } = createNotify({ webhooksConfig: voipConfig.webhooks, events, webhooks })

    // Init module singletons in dependency order. Modules that depend on
    // another converted module import it directly; only non-module values
    // (config, db, logger, connect, passports, sessions, ai, awareness,
    // the per-plugin notify, the speech context) are threaded through init().
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
      await ari.init({
        config, webhooks, events, logger,
        passports, sessions, awareness, speechEnabled,
      }).catch(err => logger.warn({ err }, 'VoIP: PBX/ARI unavailable — running without live call ingestion'))
    } else {
      logger.info('VoIP: no PBX/ARI configured — call-tracking numbers active, live ingestion off')
    }

    app.use('/voip/records', express.static(voipConfig.recordsFolder))
    registerMcp(ctx, { db })

    logger.info('VoIP plugin ready')
  },
}
