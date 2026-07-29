// Server-paged rail state: the rows for the current page, the real total, the
// search term, and the debounce between them.
//
// One implementation because every rail asks the identical question — "page N
// of the rows matching this term" — and four hand-rolled copies would drift on
// the parts that are easy to get subtly wrong: resetting to page 1 when the
// term changes, stepping back when a narrower search leaves you past the end,
// and not firing a query per keystroke.
//
// It replaces load-everything-then-filter-in-memory. That was fine while these
// tables held tens of rows and wrong the moment they don't: the client would
// pull every campaign to show twenty-five, and the count under the rail was a
// count of what had been downloaded rather than of what exists.
import { ref, watch } from 'vue'
import { notifyError } from '../shell/toast'

export type PageFetch<T> = (o: { q?: string; limit?: number; offset?: number }) => Promise<{ total: number; rows: T[] }>

export function useRailPage<T>(fetchPage: PageFetch<T>, { pageSize = 25, subject = 'rows', debounceMs = 250 } = {}) {
  const rows = ref<T[]>([]) as { value: T[] }
  const total = ref(0)
  const page = ref(0)
  const q = ref('')
  const loading = ref(false)

  async function search({ resetPage = true } = {}) {
    if (resetPage) page.value = 0
    loading.value = true
    try {
      const res = await fetchPage({ q: q.value, limit: pageSize, offset: page.value * pageSize })
      total.value = res.total
      rows.value = res.rows
      // A narrower term — or a deletion — can leave you past the end: page 4 of
      // a now-1-page result is an empty list under a full count, which reads as
      // a broken filter rather than as "you're off the end".
      if (!res.rows.length && page.value > 0) { page.value = 0; return search({ resetPage: false }) }
    } catch (e: any) {
      // Reads fail soft: a down or unregistered plugin degrades to an empty
      // rail with a toast rather than blanking the module.
      notifyError(`Couldn't load ${subject}: ${e.message}`)
      rows.value = []; total.value = 0
    } finally {
      loading.value = false
    }
  }

  async function goToPage(n: number) {
    const target = Math.min(Math.max(0, n), Math.max(0, Math.ceil(total.value / pageSize) - 1))
    if (target === page.value) return
    page.value = target
    await search({ resetPage: false })
  }

  // Debounced, because this is a real query now rather than an in-memory
  // filter — typing an eight-letter name would otherwise be eight round trips.
  let timer: any
  watch(q, () => {
    clearTimeout(timer)
    timer = setTimeout(() => search(), debounceMs)
  })

  // After a write. Holds your place rather than snapping to page 1: renaming
  // the third campaign on page 2 shouldn't move you. A CREATE should pass
  // `{ resetPage: true }` — the new row is at the top of page 1.
  const refresh = () => search({ resetPage: false })

  return { rows, total, page, q, loading, pageSize, search, goToPage, refresh }
}
