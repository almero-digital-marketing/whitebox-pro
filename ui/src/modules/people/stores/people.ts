// People data store. Thin orchestration over the people HTTP client — search
// paging and the open person, nothing else. Identity resolution, merging and
// erasure all live server-side.
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { peopleClient as client, SEARCH_FIELDS, type Activity, type ListSeg, type Person, type PersonRow, type SearchField } from '../people'
import { notifyError } from '../../../shell/toast'

const PAGE = 25
// matches the plugin's ACTIVITY_PAGE, so the inline first page and every
// subsequent fetch are the same size
const ACTIVITY_PAGE = 20

export const usePeopleStore = defineStore('people', () => {
  const results = ref<PersonRow[]>([])
  const total = ref(0)
  const loading = ref(false)
  const current = ref<Person | null>(null)
  // Most passports are anonymous web visitors, so the default list is the
  // identified ones — see the plugin's search(). This is the opt-in.
  const includeAnonymous = ref(false)
  const q = ref('')
  const page = ref(0)
  // Where `q` is looked for. Starts as everything, because a first search
  // should find whatever you paste in without configuring anything first — the
  // picker is for narrowing once a term matches more than you meant.
  const fields = ref<SearchField[]>(SEARCH_FIELDS.map(f => f.value))
  // Zero fields would mean "search nowhere", which is never what an empty
  // checkbox list is trying to say — it's a slip on the way to picking a
  // different one. Guarded here rather than in the component so the rule holds
  // for any caller, and the picker greys out the last box to show why.
  function setFields(next: SearchField[]) {
    if (next.length) fields.value = next
  }

  // Real pages rather than an append-on-scroll list: the result set can be
  // hundreds of thousands of passports, and "load more" gives no sense of
  // where you are in it or any way back to a row you scrolled past.
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE)))
  const rangeStart = computed(() => (total.value ? page.value * PAGE + 1 : 0))
  const rangeEnd = computed(() => Math.min(total.value, (page.value + 1) * PAGE))

  // Reads fail soft (toast + empty list) so a down or unregistered plugin
  // degrades rather than blanking the module; writes rethrow so the caller can
  // keep the form open and show the error in place.
  // ── bulk selection ──────────────────────────────────────────────────────
  // Two scopes, kept apart on purpose. `selected` is a hand-picked set of
  // people; `allMatching` means "everyone this SEARCH returns", which the
  // client can't enumerate — it has one page — so the server re-runs the query.
  //
  // A Map of ROWS, not a Set of ids: the selection is the centre pane's subject
  // now, so it has to be renderable, and it survives paging and re-searching —
  // pick two people on page 1, three on page 3, and page 1's rows are long gone
  // from `results` by the time the list is drawn.
  const selected = ref<Map<string, PersonRow>>(new Map())
  const allMatching = ref(false)
  const selectionCount = computed(() => (allMatching.value ? total.value : selected.value.size))
  const selectionRows = computed(() => [...selected.value.values()])
  const hasSelection = computed(() => allMatching.value || selected.value.size > 0)

  function toggleSelected(row: PersonRow) {
    // picking a row by hand is a narrower intent than "all matching" — honour it
    allMatching.value = false
    const next = new Map(selected.value)
    next.has(row.id) ? next.delete(row.id) : next.set(row.id, row)
    selected.value = next
  }
  function clearSelection() { selected.value = new Map(); allMatching.value = false }
  function selectAllMatching() { selected.value = new Map(); allMatching.value = true }

  // The envelope every bulk verb sends. Built once so "hand-picked ids" versus
  // "re-run the query" is decided in exactly one place — a verb that got it
  // wrong would silently act on 25 people instead of 40 000, or the reverse.
  const selectionBody = () => (allMatching.value
    ? { query: { q: q.value, fields: fields.value, includeAnonymous: includeAnonymous.value } }
    : { passport_ids: [...selected.value.keys()] })

  // Add the selection to a list BY NAME, creating it if it doesn't exist yet —
  // the bulk equivalent of createAndAdd(). Naming a new list is the common case
  // when you've just built a selection, so it can't require a detour through
  // another module first.
  async function addSelectionToListNamed(name: string) {
    const existing = lists.value.find(l => l.name.toLowerCase() === name.trim().toLowerCase())
    const seg = existing || await client.createList(name.trim())
    return { ...(await addSelectionToList(seg.id)), listName: seg.name, created: !existing }
  }

  async function addSelectionToList(segmentId: string) {
    const res = await client.addManyToList(segmentId, selectionBody())
    await loadLists()          // the pill counts just moved
    // …and so may the open person's: a bulk add over a query can easily
    // include whoever is on screen, and their Lists panel was loaded before it
    if (current.value) await open(current.value.id)
    // Deliberately does NOT clear the selection. Clearing would tear down the
    // centre pane and the panel showing the receipt in the same frame, so the
    // one thing you want to read ("Added 187 · 53 already on it") would vanish
    // as it appeared. It also makes adding the same cohort to a second list the
    // cheap thing it should be. Clear is an explicit action.
    return res
  }

  // The same fact on everyone selected. Mirrors addSelectionToList exactly —
  // same envelope, same "don't clear afterwards" rule, same refresh of the open
  // person, whose facts panel may have just gained a row.
  async function recordFactForSelection(fact: { key: string; value: string }) {
    const res = await client.recordFactForMany({ ...fact, ...selectionBody() })
    await loadFactKeys()       // a brand-new key is now part of the vocabulary
    if (current.value) await open(current.value.id)
    return res
  }

  async function search({ resetPage = true } = {}) {
    if (resetPage) page.value = 0
    loading.value = true
    try {
      const res = await client.search({
        q: q.value, fields: fields.value, includeAnonymous: includeAnonymous.value,
        limit: PAGE, offset: page.value * PAGE,
      })
      total.value = res.total
      results.value = res.people
      // a filter change can leave you past the end (page 6 of a 2-page result);
      // step back rather than showing an empty list with a full count
      if (!res.people.length && page.value > 0) { page.value = 0; return search({ resetPage: false }) }
    } catch (e: any) {
      notifyError(`Couldn't search people: ${e.message}`)
      results.value = []; total.value = 0
    } finally {
      loading.value = false
    }
  }

  async function goToPage(n: number) {
    const target = Math.min(Math.max(0, n), pageCount.value - 1)
    if (target === page.value) return
    page.value = target
    await search({ resetPage: false })
  }

  // ── activity ──────────────────────────────────────────────────────────────
  // Paged separately from the person: get() inlines the first page so opening
  // someone is one request, and only "load more" or a filter change goes back.
  const activity = ref<Activity[]>([])
  const activityHasMore = ref(false)
  const activityLoading = ref(false)
  const activityDirections = ref<string[]>([])

  async function fetchActivity({ append = false } = {}) {
    if (!current.value) return
    activityLoading.value = true
    try {
      const res = await client.activity(current.value.id, {
        limit: ACTIVITY_PAGE,
        offset: append ? activity.value.length : 0,
        directions: activityDirections.value,
      })
      activity.value = append ? [...activity.value, ...res.rows] : res.rows
      activityHasMore.value = res.hasMore
    } catch (e: any) {
      notifyError(`Couldn't load activity: ${e.message}`)
      if (!append) { activity.value = []; activityHasMore.value = false }
    } finally {
      activityLoading.value = false
    }
  }
  const loadMoreActivity = () => fetchActivity({ append: true })
  function setActivityDirections(next: string[]) {
    activityDirections.value = next
    return fetchActivity()          // filtering happens in SQL, not over this page
  }

  async function open(id: string) {
    try {
      current.value = await client.get(id)
      // seed from the page get() already returned rather than re-fetching it
      activity.value = current.value.recent || []
      // a full first page means there's probably more; the first real
      // activity() call replaces this guess with the server's answer
      activityHasMore.value = activity.value.length >= ACTIVITY_PAGE
      activityDirections.value = []
    } catch (e: any) {
      notifyError(`Couldn't open that person: ${e.message}`); current.value = null
      activity.value = []; activityHasMore.value = false
    }
  }
  const close = () => { current.value = null; activity.value = []; activityHasMore.value = false }

  // Every write returns the refreshed person, so the detail pane updates from
  // the server's own answer rather than a locally-patched guess.
  const applied = (p: Person) => { current.value = p; return p }
  const linkIdentity = async (id: string, claim: any) => applied(await client.linkIdentity(id, claim))
  const unlinkIdentity = async (id: string, identityId: number | string) => applied(await client.unlinkIdentity(id, identityId))
  const recordFact = async (id: string, fact: any) => applied(await client.recordFact(id, fact))

  // The lists a person can be put on. Fetched once per module activation rather
  // than per person — it's a short, slow-changing catalogue.
  const lists = ref<ListSeg[]>([])
  async function loadLists() {
    try { lists.value = await client.lists() } catch { lists.value = [] }
  }

  // The fact-key vocabulary, on the same terms as `lists`: fetched once per
  // module activation, short, slow-changing. It's what the key field suggests
  // when there's no single person whose own keys could stand in — and with a
  // selection there never is.
  const factKeys = ref<string[]>([])
  async function loadFactKeys() {
    try { factKeys.value = await client.factKeys() } catch { factKeys.value = [] }
  }
  // Both refresh the catalogue afterwards: each list carries a member count the
  // picker shows ("12 on it now"), and that number is wrong the moment anyone
  // is added or removed. A stale count is worse than no count — it reads as
  // fact.
  const addToList = async (id: string, segmentId: string) => {
    const p = applied(await client.addToList(id, segmentId)); await loadLists(); return p
  }
  const removeFromList = async (id: string, segmentId: string) => {
    const p = applied(await client.removeFromList(id, segmentId)); await loadLists(); return p
  }
  async function createAndAdd(id: string, name: string) {
    const seg = await client.createList(name)
    await loadLists()                       // the new list is pickable for the next person
    return applied(await client.addToList(id, seg.id))
  }


  async function erase(id: string) {
    const res = await client.erase(id)
    current.value = null
    results.value = results.value.filter(r => r.id !== id)
    total.value = Math.max(0, total.value - 1)
    return res
  }

  // Erase the whole selection. Unlike every other bulk verb this one DOES clear
  // the selection afterwards — there is nothing left to act on a second time,
  // and a cohort of erased people sitting in the centre pane would be a list of
  // rows that no longer exist. The receipt lives in the dialog, which stays
  // open, so nothing is lost by tearing the selection down.
  async function eraseSelection() {
    const res = await client.eraseMany(selectionBody())
    clearSelection()
    // The open person may have been in the set, and under "all matching" we
    // can't cheaply tell. Closing unconditionally is the honest answer: after
    // erasing a cohort, showing a person who may or may not still exist is
    // worse than showing nobody.
    close()
    await search({ resetPage: false })
    await loadLists()          // every list that held one of them just shrank
    return res
  }

  return {
    results, total, loading, current, includeAnonymous, q, fields, setFields,
    // the Paginator needs the page size to compute its `first` offset
    pageSize: PAGE,
    page, pageCount, rangeStart, rangeEnd, goToPage,
    search, open, close, linkIdentity, unlinkIdentity, recordFact, erase, eraseSelection,
    lists, loadLists, addToList, removeFromList, createAndAdd,
    factKeys, loadFactKeys,
    selected, allMatching, selectionCount, selectionRows, hasSelection,
    toggleSelected, clearSelection, selectAllMatching,
    addSelectionToList, addSelectionToListNamed, recordFactForSelection,
    activity, activityHasMore, activityLoading, activityDirections, loadMoreActivity, setActivityDirections,
  }
})
