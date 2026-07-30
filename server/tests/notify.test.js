import { describe, it, expect, vi } from 'vitest'
import createNotify, { FIREHOSE_CHANNEL } from '../src/notify.js'

describe('notify() — event registry recording', () => {
  it('calls eventRegistry.record(type, payload) alongside publish — the full payload, not just the type', async () => {
    const events = { publish: vi.fn(async () => {}) }
    const eventRegistry = { record: vi.fn(async () => {}) }
    const { notify } = createNotify({ events, webhooks: { send: vi.fn() }, eventRegistry })

    await notify('mail.sent', { type: 'mail.sent', data: { id: 1 } })

    expect(events.publish).toHaveBeenCalledWith('mail.sent', { type: 'mail.sent', data: { id: 1 } })
    expect(eventRegistry.record).toHaveBeenCalledWith('mail.sent', { type: 'mail.sent', data: { id: 1 } })
  })

  it('a rejecting eventRegistry.record() does not break notify()', async () => {
    const events = { publish: vi.fn(async () => {}) }
    const eventRegistry = { record: vi.fn(() => Promise.reject(new Error('db down'))) }
    const { notify } = createNotify({ events, webhooks: { send: vi.fn() }, eventRegistry })

    await expect(notify('mail.sent', { type: 'mail.sent', data: {} })).resolves.toBeUndefined()
  })

  it('works with no eventRegistry wired at all (optional dependency)', async () => {
    const events = { publish: vi.fn(async () => {}) }
    const { notify } = createNotify({ events, webhooks: { send: vi.fn() } })
    await expect(notify('mail.sent', { type: 'mail.sent', data: {} })).resolves.toBeUndefined()
  })

  it('still fans out to webhooks as before', async () => {
    const events = { publish: vi.fn(async () => {}) }
    const webhooks = { send: vi.fn(async () => {}) }
    const eventRegistry = { record: vi.fn(async () => {}) }
    const { notify } = createNotify({
      events, webhooks, eventRegistry,
      webhooksConfig: { sent: { url: 'https://example.com/hook' } },
    })
    await notify('mail.sent', { type: 'mail.sent', data: { id: 1 } })
    expect(webhooks.send).toHaveBeenCalledWith({ url: 'https://example.com/hook', data: { type: 'mail.sent', data: { id: 1 } } })
  })
})

describe('notify() — the firehose channel', () => {
  it('echoes every event to one channel, carrying the type IN the message', async () => {
    const events = { publish: vi.fn(async () => {}) }
    const { notify } = createNotify({ events, webhooks: { send: vi.fn() } })

    await notify('mail.sent', { data: { id: 1 } })

    // the per-type channel every existing consumer already subscribes to…
    expect(events.publish).toHaveBeenCalledWith('mail.sent', { data: { id: 1 } })
    // …plus the single one a whole-stream consumer can subscribe to instead.
    // The type has to travel in the body: a firehose subscriber sees one
    // channel name and would otherwise have no idea what it just received.
    expect(events.publish).toHaveBeenCalledWith(FIREHOSE_CHANNEL, {
      type: 'mail.sent', payload: { data: { id: 1 } },
    })
  })

  // The alternative — psubscribe('*') — was tried and rejected: the Redis db is
  // not necessarily ours, and a wildcard subscriber on the dev instance also
  // received `directus:bus:logs` from an unrelated application.
  it('the channel is a fixed, namespaced literal', () => {
    expect(FIREHOSE_CHANNEL).toBe('whitebox:events')
  })

  it('a failing firehose publish cannot break the event it is observing', async () => {
    const events = {
      publish: vi.fn(async (channel) => {
        if (channel === FIREHOSE_CHANNEL) throw new Error('redis down')
      }),
    }
    const { notify } = createNotify({ events, webhooks: { send: vi.fn() } })
    await expect(notify('mail.sent', { data: {} })).resolves.toBeUndefined()
  })
})
