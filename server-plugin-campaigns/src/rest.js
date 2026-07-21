// REST transport — thin routes over the service, behind `requireRead` /
// `requireWrite` (each a resolved verifier's middleware — static secret,
// auth0(), jwt(), … — see whitebox-pro-server/auth's resolveReadWriteAuth(),
// which index.js already ran this through). The split is by mutation, not
// HTTP verb — /delivery/preview is a POST but never persists (a dry-run
// reach count), so it stays read-gated.

export function register(app, { service, requireRead, requireWrite }) {
  const read  = (method, path, fn) => app[method](`/campaigns${path}`, requireRead,  wrap(fn))
  const write = (method, path, fn) => app[method](`/campaigns${path}`, requireWrite, wrap(fn))

  // Mikser upsert — create-or-update by external_id (define before /:id). Owns content, not audiences.
  write('put', '/upsert', async (req) => service.upsertCampaign(req.body || {}))

  // campaigns CRUD (POST = UI create)
  read('get', '', async () => service.listCampaigns())
  write('post', '', async (req) => service.saveCampaign(req.body || {}))
  read('get', '/:id', async (req) => {
    const c = await service.getCampaign(req.params.id)
    if (!c) { const e = new Error('campaign not found'); e.status = 404; throw e }
    return c
  })
  write('patch', '/:id', async (req) => service.patchCampaign(req.params.id, req.body || {}))
  write('delete', '/:id', async (req) => ({ deleted: await service.deleteCampaign(req.params.id) }))

  // audience binding (many-to-many; UI only)
  read('get', '/:id/audiences', async (req) => (await service.getCampaign(req.params.id))?.audiences ?? [])
  write('post', '/:id/audiences', async (req) => service.attachAudience(req.params.id, req.body?.audience_id))
  write('delete', '/:id/audiences/:audienceId', async (req) => service.detachAudience(req.params.id, req.params.audienceId))

  // delivery preview (consent-gated union counts, read-only) + send (dry-run) + report link
  read('post', '/:id/delivery/preview', async (req) => service.previewDelivery(req.params.id))
  write('post', '/:id/schedule', async (req) => service.schedule(req.params.id, { counts: req.body?.counts }))
  write('post', '/:id/unlock', async (req) => service.unlockCampaign(req.params.id))
  write('post', '/:id/report', async (req) => service.setReport(req.params.id, req.body?.report_id))
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
