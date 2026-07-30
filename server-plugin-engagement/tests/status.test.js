import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import * as content from '../src/content.js'
import { engagement } from '../src/index.js'

// Minimal knex stand-in for exactly the two queries content.status() runs: a
// grouped count over `kind`, and a count of rows whose text is null/empty. Rows
// are returned the way node-pg returns aggregates — the count as a STRING — so a
// missing Number() coercion shows up here rather than as "0" on the real board.
function makeDb(rows = []) {
  function chain() {
    const preds = []
    let group = null
    let alias = null
    const c = {
      select: () => c,
      groupBy: (col) => { group = col; return c },
      // knex: count('* as n') aliases to `n`, bare count() to `count`
      count: (spec) => { alias = typeof spec === 'string' ? spec.split(' as ')[1] : 'count'; return c },
      where: (a, op, val) => {
        if (typeof a === 'function') {
          // grouped WHERE: the callback's clauses OR together
          const or = []
          const sub = {
            whereNull: (col) => { or.push(r => r[col] == null); return sub },
            orWhere: (col, v) => { or.push(r => r[col] === v); return sub },
          }
          a(sub)
          preds.push(r => or.some(f => f(r)))
        } else if (op === '>=') {
          preds.push(r => r[a] >= val)
        } else {
          preds.push(r => r[a] === op)
        }
        return c
      },
      then(resolve, reject) {
        try {
          const matched = rows.filter(r => preds.every(f => f(r)))
          if (group) {
            const buckets = new Map()
            for (const r of matched) buckets.set(r[group], (buckets.get(r[group]) || 0) + 1)
            return resolve([...buckets].map(([k, n]) => ({ [group]: k, [alias]: String(n) })))
          }
          if (alias) return resolve([{ [alias]: String(matched.length) }])
          resolve(matched.map(r => ({ ...r })))
        } catch (err) { reject(err) }
      },
    }
    return c
  }
  return () => chain()
}

function makeContent(rows, { db } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  content.init({ db: db ?? makeDb(rows), ai: {}, options: {}, logger })
  return { content, logger }
}

const HOUR = 60 * 60 * 1000
const since = new Date(Date.now() - 24 * HOUR)
const recent = new Date(Date.now() - HOUR)
const old = new Date(Date.now() - 40 * 24 * HOUR)

// Shape assertions below stay EXACT — several of them are asserting the absence of
// a key (no `severity`, no `live`), which toMatchObject would stop checking. So the
// prose is dropped rather than the strictness; that every metric HAS prose is its
// own test at the end of this file.
const shape = (m) => { const { description, ...rest } = m || {}; return rest }

describe('engagement.content.status', () => {

  it('windows resolutions by generated_at, split by kind', async () => {
    const { content } = makeContent([
      { url: 'a.mp4', kind: 'video', text: 'transcript', generated_at: recent },
      { url: 'b.mp4', kind: 'video', text: 'transcript', generated_at: recent },
      { url: 'c.jpg', kind: 'image', text: 'a cat', generated_at: recent },
      { url: 'd.mp4', kind: 'video', text: 'transcript', generated_at: old },   // before the window
    ])
    const s = await content.status({ since })
    expect(s.label).toBe('engagement')
    expect(shape(s.metrics.find(m => m.key === 'transcribed'))).toEqual({ key: 'transcribed', value: 2 })
    expect(shape(s.metrics.find(m => m.key === 'described'))).toEqual({ key: 'described', value: 1 })
    expect(s.note).toBeNull()
  })

  it('flags entries that resolved to no text as bad — the silent transcription failure', async () => {
    const { content } = makeContent([
      { url: 'a.mp4', kind: 'video', text: 'transcript', generated_at: recent },
      { url: 'b.mp4', kind: 'video', text: null, generated_at: recent },        // Vision/Whisper produced nothing
      { url: 'c.jpg', kind: 'image', text: '', generated_at: recent },
    ])
    const s = await content.status({ since })
    // `live: true` is load-bearing, not incidental: this one counts the whole cache
    // while the two beside it are windowed, and the board groups on that flag.
    expect(shape(s.metrics.find(m => m.key === 'no text')))
      .toEqual({ key: 'no text', value: 2, severity: 'bad', live: true })
    expect(s.note).toMatch(/2 cached entries resolved to no text/)
  })

  it('counts empty entries across the whole cache, not just the window', async () => {
    const { content } = makeContent([
      { url: 'a.mp4', kind: 'video', text: null, generated_at: old },   // stale, but still breaks every view today
    ])
    const s = await content.status({ since })
    expect(s.metrics.find(m => m.key === 'transcribed').value).toBe(0)
    expect(s.metrics.find(m => m.key === 'no text').value).toBe(1)
  })

  it('marks nothing but "no text" as bad — resolutions are activity, not health', async () => {
    const { content } = makeContent([
      { url: 'a.jpg', kind: 'image', text: 'a cat', generated_at: recent },
    ])
    const s = await content.status({ since })
    expect(s.metrics.filter(m => m.severity === 'bad').map(m => m.key)).toEqual(['no text'])
  })

  it('works with no `since` (whole cache)', async () => {
    const { content } = makeContent([
      { url: 'a.mp4', kind: 'video', text: 't', generated_at: old },
    ])
    const s = await content.status({})
    expect(s.metrics.find(m => m.key === 'transcribed').value).toBe(1)
  })

  it('never throws — a dead db returns a partial answer instead of taking the board down', async () => {
    const dead = () => { throw new Error('connection terminated') }
    const { content, logger } = makeContent([], { db: dead })
    const s = await content.status({ since })
    expect(s).toEqual({ label: 'engagement', metrics: [], note: 'content cache could not be read' })
    expect(logger.warn).toHaveBeenCalled()
  })
})

// The wiring: register() previously returned nothing at all, so a monitoring
// surface had no way to ask this plugin anything (see docs/10-plugin-status.md).
describe('engagement plugin — status wiring', () => {
  it('register() returns content.status as service.status', async () => {
    const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const registered = await engagement({ auth: { secret: 's' } }).register(express(), {
      db: makeDb([{ url: 'a.mp4', kind: 'video', text: 't', generated_at: recent }]),
      connect: { find: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn() },
      awareness: { record: vi.fn() },
      ai: {},
      logger,
    })

    expect(registered.service.status).toBe(content.status)
    const s = await registered.service.status({ since })
    expect(s.metrics.map(m => m.key)).toEqual(['transcribed', 'described', 'no text'])
  })
})

// Every counter must say what it counts (docs/10-plugin-status.md). This is the
// guard: without it the next metric added here ships as a bare key, and the Live
// pane shows ~65 counters from 13 plugins side by side where a bare key is a guess.
describe('descriptions', () => {
  const rows = [
    { url: 'a.mp4', kind: 'video', text: 't', generated_at: recent },
    { url: 'b.jpg', kind: 'image', text: null, generated_at: recent },
  ]

  it('gives every metric a description', async () => {
    const { content } = makeContent(rows)
    const s = await content.status({ since })
    expect(s.metrics.length).toBeGreaterThan(0)
    expect(s.metrics.filter(m => !m.description).map(m => m.key)).toEqual([])
  })

  // Restating the key teaches nobody anything.
  it('says more than the key already does', async () => {
    const { content } = makeContent(rows)
    for (const m of (await content.status({ since })).metrics) {
      expect(m.description.length).toBeGreaterThan(m.key.length + 20)
    }
  })
})
