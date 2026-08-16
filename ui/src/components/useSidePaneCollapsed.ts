import { ref, watch, type Ref } from 'vue'

// Whether a module's right pane is collapsed, remembered across reloads.
//
// Persisted for the same reason as Live's window and pinned counters (see
// modules/live/stores/live.ts, which is the convention this follows): it is a
// standing choice about how you want the screen laid out, not a per-visit one,
// and re-collapsing the pane on every reload would make the control not worth
// using. localStorage rather than the server — per-person-per-browser, and
// nothing worth a migration.
//
// Keyed PER MODULE. The panes hold different things and are worth different
// amounts on different screens: a collapsed Journeys pane (the canvas is the
// point) says nothing about whether you want People's identities hidden.
//
// EXPANDED is the fallback for anything that is not exactly the collapsed
// marker — missing, corrupt, hand-edited, storage disabled. A pane wrongly shut
// looks like the app is missing a feature, while a pane wrongly open is merely
// the default; and the recovery differs too, since the control that reopens it
// is the only thing left in a 44px strip.
export function useSidePaneCollapsed(moduleName: string): Ref<boolean> {
  const key = `wb.${moduleName}.pane-collapsed`

  let initial = false
  try { initial = localStorage.getItem(key) === '1' } catch { /* storage off — default open */ }

  const collapsed = ref(initial)

  // Write on change rather than on unmount: a module can be kept alive by
  // <KeepAlive> and never unmount, and a tab closed mid-session would otherwise
  // lose the choice that was just made.
  watch(collapsed, (v) => {
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* nothing to do — the pane still works */ }
  })

  return collapsed
}
