// REST transport — thin routes over the service, behind `requireRead` /
// `requireWrite` (each a resolved verifier's middleware — static secret,
// auth0(), jwt(), … — see whitebox-pro-server/auth's resolveReadWriteAuth(),
// which index.js already ran this through). Full reference: docs/09-api.md.
//
// The split is by MUTATION, not HTTP verb — several POST routes here are
// previews/name-suggestions/dry-run-by-default that never persist anything
// (segments/preview, audiences/preview, rules/:id/preview, draft, …) and stay
// read-gated; conversely rules/:id/evaluate and passports/:pid/evaluate are
// POST-and-`dryRun`-flag-named but ALWAYS persist match rows via
// store.upsertMatch (dryRun only controls whether the ad-network side effect
// fires), so both are write-gated.

export function register(app, { service, requireRead, requireWrite }) {
  const read  = (method, path, fn) => app[method](`/audiences${path}`, requireRead,  wrap(fn))
  const write = (method, path, fn) => app[method](`/audiences${path}`, requireWrite, wrap(fn))

  // segments — chart-derived dynamic sub-queries (the atom of the audience layer)
  read('post',   '/segments/preview', async (req) => service.previewSegment(req.body?.source ?? req.body))
  read('post',   '/segments/name',    async (req) => service.nameSegment(req.body?.source ?? req.body, req.body?.context))
  read('get',    '/segments',         async () => service.listSegments())
  write('post',  '/segments',         async (req) => service.saveSegment(req.body || {}))
  read('get',    '/segments/:id',     async (req) => {
    const seg = await service.getSegment(req.params.id)
    if (!seg) { const e = new Error('segment not found'); e.status = 404; throw e }
    return seg
  })
  write('patch',  '/segments/:id',     async (req) => service.renameSegment(req.params.id, req.body?.name))
  write('delete', '/segments/:id',     async (req) => ({ deleted: await service.deleteSegment(req.params.id) }))
  read('get',    '/segments/:id/members', async (req) => service.resolveSegment(req.params.id, { limit: +req.query.limit || 5000 }))

  // audiences — boolean compositions of segments (the deliverable audience layer)
  read('post',   '/audiences/preview', async (req) => service.previewAudience(req.body?.rule ?? req.body))
  read('post',   '/audiences/name',    async (req) => service.nameAudience(req.body?.rule ?? req.body))
  // membership — which audiences this passport is in (reported to the client by activation_id)
  read('get',    '/audiences/memberships/:passportId', async (req) => service.passportAudiences(req.params.passportId))
  read('get',    '/audiences/by-activation-id/:activationId', async (req) => {
    const a = await service.getAudienceByActivationId(req.params.activationId)
    if (!a) { const e = new Error('audience not found'); e.status = 404; throw e }
    return a
  })
  read('get',    '/audiences',         async () => service.listAudiences())
  write('post',  '/audiences',         async (req) => service.saveAudience(req.body || {}))
  read('get',    '/audiences/:id',     async (req) => {
    const a = await service.getAudience(req.params.id)
    if (!a) { const e = new Error('audience not found'); e.status = 404; throw e }
    return a
  })
  write('delete', '/audiences/:id',     async (req) => ({ deleted: await service.deleteAudience(req.params.id) }))
  read('get',    '/audiences/:id/members', async (req) => service.resolveAudience(req.params.id, { limit: Math.min(+req.query.limit || 1000, 5000) }))
  read('post',   '/audiences/:id/delivery/preview', async (req) => service.previewDelivery(req.params.id))
  write('post',  '/audiences/:id/delivery', async (req) => service.setDelivery(req.params.id, { network: req.body?.network, enabled: !!req.body?.enabled }))
  write('post',  '/audiences/:id/client-side', async (req) => service.setClientSide(req.params.id, !!req.body?.enabled))
  write('post',  '/audiences/:id/campaigns', async (req) => service.setCampaigns(req.params.id, !!req.body?.enabled))

  // rules
  read('get',    '/rules',          async (req) => service.listRules())
  write('post',  '/rules',          async (req) => service.saveRule(req.body, req.get('x-actor')))
  read('get',    '/rules/:id',      async (req) => service.getRule(req.params.id))
  write('patch', '/rules/:id',      async (req) => service.saveRule({ ...(await service.getRule(req.params.id)), ...req.body, id: req.params.id }, req.get('x-actor')))
  write('delete', '/rules/:id',      async (req) => ({ deleted: await service.deleteRule(req.params.id) }))
  read('post',   '/rules/:id/preview',  async (req) => service.preview(req.params.id, { sample: req.body?.sample }))
  // persists match rows regardless of dryRun (see file-header note) — write-gated
  write('post',  '/rules/:id/evaluate', async (req) => service.evaluateRule(req.params.id, { dryRun: req.body?.dryRun !== false }))
  read('get',    '/rules/:id/members',  async (req) => service.members(req.params.id, { limit: +req.query.limit || 50, offset: +req.query.offset || 0 }))
  read('get',    '/rules/:id/stats',    async (req) => service.stats(req.params.id))

  // passports
  read('get',    '/passports/:pid/segments', async (req) => service.passportSegments(req.params.pid))
  write('post',  '/passports/:pid/evaluate', async (req) => service.evaluatePassport(req.params.pid))   // persists match rows — see file-header note
  write('post',  '/passports/:pid/suppress', async (req) => ({ ok: await service.suppress(req.params.pid, req.body?.reason) }))
  write('delete', '/passports/:pid/suppress', async (req) => ({ ok: await service.unsuppress(req.params.pid) }))

  // networks / discovery
  read('get',    '/networks',                 async () => service.networks())
  read('get',    '/networks/:net/identity-manifest', async () => service.manifest())
  read('get',    '/facts',                    async () => service.availableFacts())

  // audit / suppression
  read('get',    '/deliveries',  async (req) => service.deliveries({ ruleId: req.query.rule, network: req.query.network, status: req.query.status, limit: +req.query.limit || 50 }))
  read('get',    '/suppression', async () => service.listSuppression())

  // drafting — AI-proposes a rule definition for review; nothing persists until POST /rules
  read('post',   '/draft', async (req) => service.draft(req.body?.description || ''))
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
