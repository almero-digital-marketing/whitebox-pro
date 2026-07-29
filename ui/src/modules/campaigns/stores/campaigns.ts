// Campaigns data store. Thin orchestration over the campaigns HTTP client. `buildReport` reuses
// the Analytics compose pipeline (no new compose logic) to turn a campaign's prompt into a report.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { campaignsClient as client } from '../campaigns'
import { useRailPage } from '../../../components/useRailPage'
import { api as analyticsApi } from '../../analytics/api'
import { notifyError } from '../../../shell/toast'

export const useCampaignsStore = defineStore('campaigns', () => {
  // The CATALOGUE — every campaign, for Journeys' trigger_campaign picker,
  // which has to offer all of them rather than whichever page this module's
  // rail happens to be showing. Capped: a picker over thousands of options
  // wants a typeahead, and this would quietly become one page of a lie.
  const CATALOGUE_MAX = 500
  const campaigns = ref<any[]>([])   // light list rows (no audiences); getCampaign() returns the full one
  const error = ref('')

  async function loadCampaigns() {
    try { campaigns.value = (await client.list({ limit: CATALOGUE_MAX })).rows }
    catch (e: any) { error.value = e.message; notifyError(`Couldn't load campaigns: ${e.message}`) }
  }

  // …and the RAIL, which is a real server query with its own page. Separate
  // state on purpose: one is "every option there is", the other is "the
  // twenty-five you're looking at", and collapsing them would either truncate
  // the picker or make the rail fetch the whole table.
  const rail = useRailPage<any>(o => client.list(o), { subject: 'campaigns' })
  const getCampaign = (id: string) => client.get(id)

  // Re-reads rather than patching a local copy. With the rail server-paged, a
  // locally-inserted row would sit on a page the server never put it on, and
  // the total under it would be wrong until the next fetch.
  function upsertLocal(row: any) {
    if (!row?.id) return
    const i = campaigns.value.findIndex(c => c.id === row.id)
    if (i >= 0) campaigns.value = campaigns.value.map(c => (c.id === row.id ? { ...c, ...row } : c))
    else campaigns.value = [row, ...campaigns.value]
    rail.refresh()
  }

  async function createCampaign(body: { name: string; channel: 'email' | 'sms'; message?: any }) {
    const row = await client.create(body); upsertLocal(row); return row
  }
  async function patchCampaign(id: string, body: any) { const row = await client.patch(id, body); upsertLocal(row); return row }
  async function removeCampaign(id: string) {
    await client.remove(id)
    campaigns.value = campaigns.value.filter(c => c.id !== id)
    await rail.refresh()
  }
  async function attachAudience(id: string, audienceId: string) { const row = await client.attachAudience(id, audienceId); upsertLocal(row); return row }
  async function detachAudience(id: string, audienceId: string) { const row = await client.detachAudience(id, audienceId); upsertLocal(row); return row }
  const previewDelivery = (id: string) => client.previewDelivery(id)
  // Results are fetched per open campaign rather than held on the list row:
  // they change as the provider reports back (delivered → opened → clicked)
  // long after the send, so a cached copy on the row would go stale silently.
  const results = ref<any>(null)
  async function loadResults(id: string) {
    results.value = null
    try { results.value = await client.results(id) }
    catch (e: any) { notifyError(`Couldn't load campaign results: ${e.message}`) }
  }

  async function scheduleCampaign(id: string, counts?: any) { const row = await client.schedule(id, counts); upsertLocal(row); return row }
  async function sendManualCampaign(id: string, counts?: any) { const row = await client.sendManual(id, counts); upsertLocal(row); return row }
  async function unlockCampaign(id: string) { const row = await client.unlock(id); upsertLocal(row); return row }

  // Build an Analytics performance report from the campaign's prompt → returns the new report id.
  async function buildReport(campaign: any) {
    const report = await analyticsApi.createReport(`${campaign.name} — performance`)
    await analyticsApi.compose(campaign.analytics_prompt || '', report.id)
    upsertLocal(await client.setReport(campaign.id, report.id))
    return report.id
  }

  return {
    campaigns, error, results,
    // the rail's own state, flattened so the component reads store.rows/total
    rows: rail.rows, total: rail.total, page: rail.page, q: rail.q, railLoading: rail.loading,
    pageSize: rail.pageSize, searchCampaigns: rail.search, goToPage: rail.goToPage,
    loadCampaigns, getCampaign, createCampaign, patchCampaign, removeCampaign, loadResults,
    attachAudience, detachAudience, previewDelivery, scheduleCampaign, sendManualCampaign, unlockCampaign, buildReport,
  }
})
