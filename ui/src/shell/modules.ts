// The registry of feature modules shown in the activity bar (VS Code-style).
// Add a module here and it appears as an icon on the left. Analytics is first;
// Campaigns (email/SMS planning + execution) is next. Each module is a self-
// contained folder under src/modules/<id>/ with its own components/api/styles.
import { defineAsyncComponent, markRaw, type Component } from 'vue'

// Modules load ON DEMAND, one chunk each. Statically importing all seven produced a single
// 3.9 MB script — which the browser must fetch completely before ANYTHING renders, and which
// carried echarts, tinymce and vue-flow even for someone who only opens Live.
//
// It also made a partial download fatal rather than annoying: with `immutable` caching, a
// browser holding a truncated copy of one enormous script keeps using it and a plain reload
// will not dislodge it — a blank page that looks like a server fault.
const lazy = (loader: () => Promise<any>) => markRaw(defineAsyncComponent(loader))

export interface ModuleDef {
  id: string
  label: string
  // Material Symbols Outlined ligature name (rendered via .material-symbols-outlined).
  // Pick one that is distinct from its NEIGHBOURS, not just apt on its own: the rail
  // is a vertical column of 20px glyphs with no labels, so two similar shapes are two
  // buttons nobody can tell apart. Live was `monitoring`, a chart, sitting directly
  // above Analytics' `bar_chart` — apt in isolation, indistinguishable in place.
  icon: string
  component: Component
  // optional route sub-segments appended to the module's path, so deep state lives in
  // the URL (analytics carries the open report + selected widget). Omit for a flat path.
  subPath?: string
  // hides the module's activity-bar icon unless the current user holds ANY
  // of these permission keys (App.vue filters on this). The route itself
  // still exists either way — real enforcement is server-side (each
  // module's own REST surface requires its own scope regardless of what
  // the UI shows). analytics/audiences/campaigns each split into :read and
  // :write — either one is enough to see the icon at all; the module's own
  // UI is responsible for disabling write-only actions for a read-only user.
  requiresAnyPermission?: string[]
}

export const modules: ModuleDef[] = [
  // FIRST, and therefore also the landing route — router.ts redirects "/" to
  // modules[0]. Opening on the monitoring view answers "is anything wrong?"
  // before you've clicked anything, which is the question you'd otherwise have
  // to remember to go and ask.
  { id: 'live', label: 'Live', icon: 'sensors', component: lazy(() => import('../modules/live/Live.vue')), requiresAnyPermission: ['live:read'] },
  { id: 'analytics', label: 'Analytics', icon: 'bar_chart', component: lazy(() => import('../modules/analytics/Analytics.vue')), subPath: ':reportId?/:widgetId?', requiresAnyPermission: ['analytics:read', 'analytics:write'] },
  { id: 'audiences', label: 'Audiences', icon: 'group', component: lazy(() => import('../modules/audiences/Audiences.vue')), subPath: ':audienceId?', requiresAnyPermission: ['audiences:read', 'audiences:write'] },
  { id: 'campaigns', label: 'Campaigns', icon: 'send', component: lazy(() => import('../modules/campaigns/Campaigns.vue')), subPath: ':campaignId?', requiresAnyPermission: ['campaigns:read', 'campaigns:write'] },
  { id: 'journeys', label: 'Journeys', icon: 'account_tree', component: lazy(() => import('../modules/journeys/Journeys.vue')), subPath: ':journeyId?', requiresAnyPermission: ['journeys:read', 'journeys:write'] },
  { id: 'people', label: 'People', icon: 'contacts', component: lazy(() => import('../modules/people/People.vue')), subPath: ':personId?', requiresAnyPermission: ['people:read', 'people:write'] },
  { id: 'users', label: 'Users', icon: 'manage_accounts', component: lazy(() => import('../modules/users/Users.vue')), subPath: ':userId?', requiresAnyPermission: ['users:manage'] },
]
