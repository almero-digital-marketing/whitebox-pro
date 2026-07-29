// Replaces the single is_admin boolean with a per-user set of module-declared
// permission keys (see server/src/plugins.js's catalog aggregation). The
// reserved sentinel "*" means "every permission that exists" — it's never a
// UI-selectable value, only ever set by scripts/create-admin.mjs (bootstrap)
// or this migration's own admin backfill (carrying forward what is_admin meant).
//
// Every OTHER already-active (password set) non-admin user is ALSO backfilled
// — to a concrete list, not '*' — with every permission that existed under
// the old shared-scope model (every module shared one bare `app:use` scope
// everyone held). Without this, a pre-existing teammate would silently drop
// to zero permissions and lose all module access the next time their token
// refreshes, with nothing in the product explaining why. Anyone who hasn't
// accepted their invite yet (password_hash IS NULL) is deliberately left
// alone — they'll get the new, narrower per-module `defaults` when they
// complete signup (see users.js's completeInvite()), which is the intended
// behavior going forward, not something this migration should override.
const LEGACY_PERMISSIONS = JSON.stringify([
  'analytics:read', 'analytics:write',
  'audiences:read', 'audiences:write',
  'campaigns:read', 'campaigns:write',
])

export const up = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.jsonb('permissions').notNullable().defaultTo('[]')
  })
  await knex('whitebox_oauth_users').where({ is_admin: true }).update({ permissions: JSON.stringify(['*']) })
  await knex('whitebox_oauth_users')
    .where({ is_admin: false })
    .whereNotNull('password_hash')
    .update({ permissions: LEGACY_PERMISSIONS })
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.dropColumn('is_admin')
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.boolean('is_admin').notNullable().defaultTo(false)
  })
  await knex('whitebox_oauth_users').whereRaw(`permissions @> '["*"]'`).update({ is_admin: true })
  await knex.schema.alterTable('whitebox_oauth_users', t => {
    t.dropColumn('permissions')
  })
}
