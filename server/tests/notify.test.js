import { describe, it, expect, vi } from 'vitest'
import createNotify from '../src/notify.js'

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
