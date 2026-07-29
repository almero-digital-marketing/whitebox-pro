import { describe, it, expect, vi } from 'vitest'
import { makeDeliver } from '../src/deliver.js'

const CAMPAIGN = { id: 'camp1', name: 'Spring' }
const MESSAGE = { html: '<p>hi</p>', text: 'hi' }

function make({ identities = {}, hasMail = true, hasSms = true } = {}) {
  const mail = hasMail ? { bulkSend: vi.fn(async () => ({ batch_id: 'b1', accepted: 2 })) } : {}
  const sms = hasSms ? { bulkSend: vi.fn(async () => ({ batch_id: 'b2', accepted: 1 })) } : {}
  const passports = { identities: vi.fn(async (id) => identities[id] || []) }
  return { deliver: makeDeliver({ mail, sms, passports, logger: { info: vi.fn() } }), mail, sms, passports }
}

describe('the built-in bulk delivery', () => {
  it('resolves each passport to its email and stamps the campaign on the batch', async () => {
    const { deliver, mail } = make({
      identities: {
        p1: [{ type: 'email', value: 'a@x.com' }, { type: 'phone', value: '+359881' }],
        p2: [{ type: 'email', value: 'b@x.com' }],
      },
    })
    const res = await deliver({ campaign: CAMPAIGN, channel: 'email', subject: 'Hi', message: MESSAGE, passportIds: ['p1', 'p2'] })

    expect(mail.bulkSend).toHaveBeenCalledWith({
      subject: 'Hi', html: '<p>hi</p>', text: 'hi',
      // passportId per row is what ties the message to a PERSON — without it
      // the outbox row is just an address, invisible to merge/erase
      recipients: [{ to: 'a@x.com', passportId: 'p1' }, { to: 'b@x.com', passportId: 'p2' }],
      // …and campaignId is the only link back to the campaign for results
      campaignId: 'camp1',
    })
    expect(res.batch_id).toBe('b1')
  })

  it('sends the sms body to the phone identity, not the email one', async () => {
    const { deliver, sms, mail } = make({
      identities: { p1: [{ type: 'email', value: 'a@x.com' }, { type: 'phone', value: '+359881' }] },
    })
    await deliver({ campaign: CAMPAIGN, channel: 'sms', message: MESSAGE, passportIds: ['p1'] })
    expect(sms.bulkSend).toHaveBeenCalledWith({ body: 'hi', recipients: [{ to: '+359881', passportId: 'p1' }], campaignId: 'camp1' })
    expect(mail.bulkSend).not.toHaveBeenCalled()
  })

  // a targeting gap, not a delivery failure — reported, never sent as a blank
  // address for the channel plugin to reject with less context
  it('drops passports with no address for the channel and counts them', async () => {
    const { deliver, mail } = make({
      identities: { p1: [{ type: 'email', value: 'a@x.com' }], p2: [{ type: 'phone', value: '+359881' }] },
    })
    const res = await deliver({ campaign: CAMPAIGN, channel: 'email', subject: 'Hi', message: MESSAGE, passportIds: ['p1', 'p2'] })
    expect(mail.bulkSend.mock.calls[0][0].recipients).toEqual([{ to: 'a@x.com', passportId: 'p1' }])
    expect(res.no_contact).toBe(1)
  })

  it('does not call the channel at all when nobody is reachable', async () => {
    const { deliver, mail } = make({ identities: {} })
    const res = await deliver({ campaign: CAMPAIGN, channel: 'email', subject: 'Hi', message: MESSAGE, passportIds: ['p1'] })
    expect(mail.bulkSend).not.toHaveBeenCalled()
    expect(res).toEqual({ batch_id: null, accepted: 0, no_contact: 1 })
  })

  it('fails loudly when the channel plugin is not wired', async () => {
    const { deliver } = make({ hasMail: false, identities: { p1: [{ type: 'email', value: 'a@x.com' }] } })
    await expect(deliver({ campaign: CAMPAIGN, channel: 'email', subject: 'Hi', message: MESSAGE, passportIds: ['p1'] }))
      .rejects.toThrow(/mail plugin is not wired/)
  })
})
