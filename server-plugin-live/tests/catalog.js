// A representative event catalog, for the tests that need live to classify
// something.
//
// These declarations are written HERE rather than imported from the real plugin
// packages, and that is deliberate: live has no knowledge of any other module's
// event types any more, so a fixture that reached into server-plugin-mail to ask
// what mail emits would quietly re-introduce the coupling the refactor removed —
// in the test suite, where it is hardest to notice.
//
// The trade is real and worth naming: this fixture can drift from what the
// plugins actually declare. That's acceptable because nothing here is a claim
// ABOUT those plugins — it's a stand-in shaped like a plausible install, used to
// test live's reading of a catalog. Whether mail's manifest matches mail's
// emissions is mail's own test to make (see server-plugin-voip/tests/
// manifest.test.js for the pattern that does it by scanning its own source).
import { build } from 'whitebox-pro-server/event-catalog'

export const PLUGINS = [
  {
    name: 'mail',
    events: {
      'mail.queued': 'out',
      'mail.sent': 'out',
      'mail.failed': { direction: 'out', severity: 'error' },
      'mail.delivered': 'out',
      'mail.bounced': { direction: 'out', severity: 'warn' },
      'mail.bulk.queued': 'out',
      'mail.bulk.cancelled': 'internal',
      'mail.received': 'in',
      'mail.opened': 'in',
      'mail.engaged': 'in',
      'mail.complained': { direction: 'in', severity: 'warn' },
    },
  },
  {
    name: 'sms',
    events: {
      'sms.queued': 'out',
      'sms.sent': 'out',
      'sms.failed': { direction: 'out', severity: 'error' },
      'sms.delivered': 'out',
      'sms.bounced': { direction: 'out', severity: 'warn' },
      'sms.bulk.queued': 'out',
      'sms.bulk.cancelled': 'internal',
      'sms.received': 'in',
    },
  },
  {
    name: 'voip',
    events: {
      'voip.ring': 'in',
      'voip.click': 'in',
      'voip.call': 'in',
      'voip.pick': 'internal',
    },
  },
  { name: 'crm', events: { 'crm.': 'in' } },
  {
    name: 'conversions',
    events: {
      'conversion.': 'in',
      'adnetwork.accepted': 'out',
      'adnetwork.rejected': { direction: 'out', severity: 'warn' },
      'adnetwork.error': { direction: 'out', severity: 'error' },
    },
  },
  {
    name: 'campaigns',
    events: { 'campaigns.activated': 'internal', 'campaigns.sent': 'internal' },
  },
  {
    name: 'journeys',
    events: {
      'journey.enrolled': 'internal',
      'journey.completed': 'internal',
      'journey.exited': 'internal',
    },
  },
  { name: 'shortener', events: { 'shortener.claimed': 'in' } },
]

// A couple of detail declarations too, so `toFeedRow` is exercised end to end.
// It passed for a long time without them: the test asserted id/type/direction/
// channel/passport and never `detail`, which is the one field this whole exercise
// was about — a blank detail column would have gone on passing.
PLUGINS.push({
  name: 'detail-fixture',
  events: { 'fixture.thing': 'in' },
  detail: { 'fixture.thing': (d) => d.label ?? null },
})
PLUGINS.find(p => p.name === 'mail').detail = { 'mail.': (d) => d.to ?? null }

export const catalog = () => build(PLUGINS)
