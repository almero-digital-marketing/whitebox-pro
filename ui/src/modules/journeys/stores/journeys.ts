// Journeys data store. Thin orchestration over the journeys HTTP client — no
// business logic here (dedup policy, step execution, trigger evaluation all
// live server-side). `enrollments`/`currentEnrollment` back the right pane's
// Enrollments audit view; everything else backs the rail + editor.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { journeysClient as client } from '../journeys'
import { useRailPage } from '../../../components/useRailPage'
import { notifyError } from '../../../shell/toast'

export const useJourneysStore = defineStore('journeys', () => {
  // Every journey, for anything that needs the whole set. Capped — see the
  // campaigns store for why a picker catalogue is not a page.
  const CATALOGUE_MAX = 500
  const journeys = ref<any[]>([])
  // The rail: a real server query with its own page.
  const rail = useRailPage<any>(o => client.list(o), { subject: 'journeys' })
  const enrollments = ref<any[]>([])
  const currentEnrollment = ref<any | null>(null)
  const eventsRegistry = ref<any[]>([])
  const stepCounts = ref<Record<string, number>>({})
  // Fetched per open journey rather than cached on the list row: the numbers
  // move on their own (a goal event fires days after the enrollment did), so a
  // copy held alongside the journey would quietly go stale.
  const results = ref<any>(null)
  const error = ref('')

  async function loadJourneys() {
    try { journeys.value = (await client.list({ limit: CATALOGUE_MAX })).rows } catch (e: any) { error.value = e.message; notifyError(`Couldn't load journeys: ${e.message}`) }
  }
  async function loadEventsRegistry() {
    try { eventsRegistry.value = await client.eventsRegistry() } catch (e: any) { notifyError(`Couldn't load the event registry: ${e.message}`) }
  }
  const getJourney = (id: string) => client.get(id)

  function upsertLocal(row: any) {
    if (!row?.id) return
    const i = journeys.value.findIndex(j => j.id === row.id)
    if (i >= 0) journeys.value = journeys.value.map(j => (j.id === row.id ? { ...j, ...row } : j))
    else journeys.value = [row, ...journeys.value]
  }

  async function createJourney(body: { name: string; trigger: any; steps: any; dedupe?: any }) {
    const row = await client.create(body); upsertLocal(row); return row
  }
  async function patchJourney(id: string, body: any) { const row = await client.patch(id, body); upsertLocal(row); return row }
  async function removeJourney(id: string) { await client.remove(id); journeys.value = journeys.value.filter(j => j.id !== id) }
  async function activateJourney(id: string) { const row = await client.activate(id); upsertLocal(row); return row }
  async function pauseJourney(id: string) { const row = await client.pause(id); upsertLocal(row); return row }
  const enrollPassport = (id: string, passportId: string) => client.enroll(id, passportId)

  async function loadEnrollments(id: string, status?: string) {
    try { enrollments.value = await client.listEnrollments(id, status) } catch (e: any) { notifyError(`Couldn't load enrollments: ${e.message}`) }
  }
  async function loadEnrollmentDetail(enrollmentId: string) {
    try { currentEnrollment.value = await client.getEnrollment(enrollmentId) } catch (e: any) { notifyError(`Couldn't load enrollment: ${e.message}`) }
  }
  async function loadStepCounts(id: string) {
    try { stepCounts.value = await client.stepCounts(id) } catch (e: any) { notifyError(`Couldn't load step counts: ${e.message}`) }
  }
  async function loadResults(id: string) {
    results.value = null
    try { results.value = await client.results(id) }
    catch (e: any) { notifyError(`Couldn't load journey results: ${e.message}`) }
  }
  async function exitEnrollment(enrollmentId: string, reason?: string) {
    const row = await client.exitEnrollment(enrollmentId, reason)
    enrollments.value = enrollments.value.map(e => (e.id === enrollmentId ? { ...e, ...row } : e))
    if (currentEnrollment.value?.id === enrollmentId) currentEnrollment.value = { ...currentEnrollment.value, ...row }
    return row
  }

  return {
    rows: rail.rows, total: rail.total, page: rail.page, q: rail.q, railLoading: rail.loading,
    pageSize: rail.pageSize, searchJourneys: rail.search, goToPage: rail.goToPage, refreshRail: rail.refresh,
    journeys, enrollments, currentEnrollment, eventsRegistry, stepCounts, results, error,
    loadJourneys, getJourney, createJourney, patchJourney, removeJourney,
    activateJourney, pauseJourney, enrollPassport,
    loadEnrollments, loadEnrollmentDetail, exitEnrollment, loadResults,
    loadEventsRegistry, loadStepCounts,
  }
})
