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

describe('notify() — one event, several webhooks', () => {
  // The value under an event key may be a single config or an array of them.
  // The array form used to be spread into `{ "0": {…} }`, losing `url`, and
  // webhooks.send() dropped it silently — nothing was ever enqueued.
  const setup = (webhooksConfig) => {
    const events = { publish: vi.fn(async () => {}) }
    const webhooks = { send: vi.fn(async () => {}) }
    const { notify } = createNotify({ events, webhooks, webhooksConfig })
    return { webhooks, notify }
  }
  const payload = { type: 'voip.ring', data: { call_id: 'c1' } }

  it('sends to every target in an array, each with its own url and method', async () => {
    const { webhooks, notify } = setup({
      ring: [
        { url: 'https://one.example/ring', method: 'post' },
        { url: 'https://two.example/ring', method: 'PUT' },
      ],
    })
    await notify('voip.ring', payload)

    expect(webhooks.send).toHaveBeenCalledTimes(2)
    expect(webhooks.send).toHaveBeenCalledWith({ url: 'https://one.example/ring', method: 'post', data: payload })
    expect(webhooks.send).toHaveBeenCalledWith({ url: 'https://two.example/ring', method: 'PUT', data: payload })
  })

  it('sends an array of one with its url intact — the exact shape that sent nothing before', async () => {
    const { webhooks, notify } = setup({
      ring: [{ url: 'https://api.gpoint.bg/support/voip/ring', method: 'post' }],
    })
    await notify('voip.ring', payload)

    expect(webhooks.send).toHaveBeenCalledTimes(1)
    // Asserting the url, not just the count: a `{ "0": {…} }` object would
    // still satisfy a bare call-count assertion.
    const [sent] = webhooks.send.mock.calls[0]
    expect(sent.url).toBe('https://api.gpoint.bg/support/voip/ring')
    expect(sent.data).toEqual(payload)
    expect(sent['0']).toBeUndefined()
  })

  it('still accepts a single config object', async () => {
    const { webhooks, notify } = setup({ ring: { url: 'https://one.example/ring' } })
    await notify('voip.ring', payload)

    expect(webhooks.send).toHaveBeenCalledTimes(1)
    expect(webhooks.send).toHaveBeenCalledWith({ url: 'https://one.example/ring', data: payload })
  })

  it('sends nothing for an empty array, and does not throw', async () => {
    const { webhooks, notify } = setup({ ring: [] })
    await expect(notify('voip.ring', payload)).resolves.toBeUndefined()
    expect(webhooks.send).not.toHaveBeenCalled()
  })

  it('sends nothing for an event with no entry in the map', async () => {
    const { webhooks, notify } = setup({ pick: [{ url: 'https://one.example/pick' }] })
    await notify('voip.ring', payload)
    expect(webhooks.send).not.toHaveBeenCalled()
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
