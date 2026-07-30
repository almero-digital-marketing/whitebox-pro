// The registry of feature modules shown in the activity bar (VS Code-style).
// Add a module here and it appears as an icon on the left. Analytics is first;
// Campaigns (email/SMS planning + execution) is next. Each module is a self-
// contained folder under src/modules/<id>/ with its own components/api/styles.
import { markRaw, type Component } from 'vue'
import Analytics from '../modules/analytics/Analytics.vue'
import Audiences from '../modules/audiences/Audiences.vue'
import Campaigns from '../modules/campaigns/Campaigns.vue'
import Journeys from '../modules/journeys/Journeys.vue'
import People from '../modules/people/People.vue'
import Live from '../modules/live/Live.vue'
import Users from '../modules/users/Users.vue'

export interface ModuleDef {
  id: string
  label: string
  icon: string        // Material Symbols Outlined ligature name (rendered via .material-symbols-outlined)
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
  { id: 'live', label: 'Live', icon: 'monitoring', component: markRaw(Live), requiresAnyPermission: ['live:read'] },
  { id: 'analytics', label: 'Analytics', icon: 'bar_chart', component: markRaw(Analytics), subPath: ':reportId?/:widgetId?', requiresAnyPermission: ['analytics:read', 'analytics:write'] },
  { id: 'audiences', label: 'Audiences', icon: 'group', component: markRaw(Audiences), subPath: ':audienceId?', requiresAnyPermission: ['audiences:read', 'audiences:write'] },
  { id: 'campaigns', label: 'Campaigns', icon: 'send', component: markRaw(Campaigns), subPath: ':campaignId?', requiresAnyPermission: ['campaigns:read', 'campaigns:write'] },
  { id: 'journeys', label: 'Journeys', icon: 'account_tree', component: markRaw(Journeys), subPath: ':journeyId?', requiresAnyPermission: ['journeys:read', 'journeys:write'] },
  { id: 'people', label: 'People', icon: 'contacts', component: markRaw(People), subPath: ':personId?', requiresAnyPermission: ['people:read', 'people:write'] },
  { id: 'users', label: 'Users', icon: 'manage_accounts', component: markRaw(Users), subPath: ':userId?', requiresAnyPermission: ['users:manage'] },
]
