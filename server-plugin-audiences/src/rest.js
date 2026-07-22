// REST transport — thin routes over the service, behind `requireRead` /
// `requireWrite` (each a resolved verifier's middleware — static secret,
// auth0(), jwt(), … — see whitebox-pro-server/auth's resolveReadWriteAuth(),
// which index.js already ran this through). Full reference: docs/09-api.md.
//
// The split is by MUTATION, not HTTP verb — several POST routes here are
// previews/name-suggestions that never persist anything (segments/preview,
// audiences/preview, audiences/:id/delivery/preview, …) and stay read-gated.

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

  // passports
  write('post',  '/passports/:pid/suppress', async (req) => ({ ok: await service.suppress(req.params.pid, req.body?.reason) }))
  write('delete', '/passports/:pid/suppress', async (req) => ({ ok: await service.unsuppress(req.params.pid) }))

  // networks / discovery
  read('get',    '/networks',                 async () => service.networks())
  read('get',    '/networks/:net/identity-manifest', async () => service.manifest())
  read('get',    '/facts',                    async () => service.availableFacts())

  // suppression
  read('get',    '/suppression', async () => service.listSuppression())
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
