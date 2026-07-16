// REST transport — thin routes over the service, behind `requireAuth` (a
// resolved verifier's middleware — static secret, auth0(), jwt(), … — see
// whitebox-pro-server/auth's resolveAuth(), which index.js already ran this
// through).

export function register(app, { service, requireAuth }) {
  const r = (method, path, fn) => app[method](`/campaigns${path}`, requireAuth, wrap(fn))

  // Mikser upsert — create-or-update by external_id (define before /:id). Owns content, not audiences.
  r('put', '/upsert', async (req) => service.upsertCampaign(req.body || {}))

  // campaigns CRUD (POST = UI create)
  r('get', '', async () => service.listCampaigns())
  r('post', '', async (req) => service.saveCampaign(req.body || {}))
  r('get', '/:id', async (req) => {
    const c = await service.getCampaign(req.params.id)
    if (!c) { const e = new Error('campaign not found'); e.status = 404; throw e }
    return c
  })
  r('patch', '/:id', async (req) => service.patchCampaign(req.params.id, req.body || {}))
  r('delete', '/:id', async (req) => ({ deleted: await service.deleteCampaign(req.params.id) }))

  // audience binding (many-to-many; UI only)
  r('get', '/:id/audiences', async (req) => (await service.getCampaign(req.params.id))?.audiences ?? [])
  r('post', '/:id/audiences', async (req) => service.attachAudience(req.params.id, req.body?.audience_id))
  r('delete', '/:id/audiences/:audienceId', async (req) => service.detachAudience(req.params.id, req.params.audienceId))

  // delivery preview (consent-gated union counts) + send (dry-run) + report link
  r('post', '/:id/delivery/preview', async (req) => service.previewDelivery(req.params.id))
  r('post', '/:id/schedule', async (req) => service.schedule(req.params.id, { counts: req.body?.counts }))
  r('post', '/:id/unlock', async (req) => service.unlockCampaign(req.params.id))
  r('post', '/:id/report', async (req) => service.setReport(req.params.id, req.body?.report_id))
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
