// Self-hosted OAuth 2.1 authorization server state. Public clients only (PKCE
// required, no client_secret) — MCP clients and browser-based apps can't hold
// a secret safely, and pre-registered-only (no Dynamic Client Registration)
// keeps the attack surface to "an admin explicitly added this client."

export const up = async knex => {
  await knex.schema.createTable('whitebox_oauth_keys', t => {
    t.increments('id')
    // `singleton` is always 'active' — its UNIQUE constraint is what makes
    // first-boot key creation race-safe across concurrent processes/replicas:
    // every process attempts the same conflicting value (kid is a fresh
    // random UUID per attempt, so a conflict on THAT would never fire, and
    // two processes would silently persist two different keys — exactly the
    // failure mode this guards against). Whoever's insert wins, every
    // process re-reads by this fixed value and converges on the same key.
    t.string('singleton', 16).notNullable().unique().defaultTo('active')
    // One active signing key at a time (v1 — no rotation yet, but the shape
    // is rotation-ready: kid is a real JWKS key id, not just this row's pk).
    t.string('kid', 64).notNullable().unique()
    t.text('public_jwk').notNullable()    // JSON — served verbatim at /oauth/.well-known/jwks.json
    t.text('private_jwk').notNullable()   // JSON — never leaves this table
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_oauth_users', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    t.string('email', 255).notNullable().unique()
    // scrypt: N=16384, r=8, p=1, 64-byte derived key — Node's built-in KDF, no
    // native dependency. Salt is per-user, stored alongside (not derivable).
    t.string('password_hash', 255).notNullable()
    t.string('password_salt', 64).notNullable()
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_oauth_clients', t => {
    t.string('client_id', 64).primary()
    t.string('name', 255).notNullable()
    t.jsonb('redirect_uris').notNullable()   // exact-match allowlist — no prefix/wildcard matching
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_oauth_codes', t => {
    t.string('code', 64).primary()
    t.string('client_id', 64).notNullable().references('client_id').inTable('whitebox_oauth_clients').onDelete('CASCADE')
    t.uuid('user_id').notNullable().references('id').inTable('whitebox_oauth_users').onDelete('CASCADE')
    t.text('redirect_uri').notNullable()        // must match exactly at /token too (RFC 6749 §4.1.3)
    t.string('code_challenge', 128).notNullable()
    t.string('scope', 255).notNullable().defaultTo('')
    t.timestamp('expires_at').notNullable()     // short-lived — minted with a ~60s TTL
    t.timestamp('used_at').nullable()           // single-use; set atomically on redemption
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_oauth_refresh_tokens', t => {
    t.string('token', 64).primary()
    t.string('client_id', 64).notNullable().references('client_id').inTable('whitebox_oauth_clients').onDelete('CASCADE')
    t.uuid('user_id').notNullable().references('id').inTable('whitebox_oauth_users').onDelete('CASCADE')
    t.string('scope', 255).notNullable().defaultTo('')
    t.timestamp('expires_at').notNullable()
    // Rotation: each use revokes this row and mints a fresh one. A revoked
    // token being presented again means it was stolen/replayed — the whole
    // chain should be treated as compromised (the read side can walk
    // replaced_by to invalidate descendants if that's ever needed).
    t.timestamp('revoked_at').nullable()
    t.string('replaced_by', 64).nullable()
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export const down = async knex => {
  await knex.schema.dropTableIfExists('whitebox_oauth_refresh_tokens')
  await knex.schema.dropTableIfExists('whitebox_oauth_codes')
  await knex.schema.dropTableIfExists('whitebox_oauth_clients')
  await knex.schema.dropTableIfExists('whitebox_oauth_users')
  await knex.schema.dropTableIfExists('whitebox_oauth_keys')
}
