// REST transport — thin routes over the service. Split by mutation, not HTTP
// verb (mirrors server-plugin-campaigns/src/rest.js): enroll/exit are POST
// but are the actual write actions, so they're write-gated.
//
// Route order matters: /enrollments/:enrollmentId must be registered before
// the generic /:id routes, or Express's first-match-wins would treat
// "enrollments" as a journey id (same gotcha campaigns' Mikser /upsert has
// against its own /:id).

export function register(app, { service, requireRead, requireWrite }) {
  const read  = (method, path, fn) => app[method](`/journeys${path}`, requireRead,  wrap(fn))
  const write = (method, path, fn) => app[method](`/journeys${path}`, requireWrite, wrap(fn))

  // enrollment inspection/exit — defined before /:id
  read('get',  '/enrollments/:enrollmentId', async (req) => {
    const e = await service.getEnrollment(req.params.enrollmentId)
    if (!e) { const err = new Error('enrollment not found'); err.status = 404; throw err }
    return e
  })
  write('post', '/enrollments/:enrollmentId/exit', async (req) => service.exitEnrollment(req.params.enrollmentId, req.body?.reason))

  // journeys CRUD
  read('get', '', async (req) => service.searchJourneys(req.query))
  write('post', '', async (req) => service.createJourney(req.body || {}))
  read('get', '/:id', async (req) => {
    const j = await service.getJourney(req.params.id)
    if (!j) { const e = new Error('journey not found'); e.status = 404; throw e }
    return j
  })
  write('patch', '/:id', async (req) => service.patchJourney(req.params.id, req.body || {}))
  write('delete', '/:id', async (req) => ({ deleted: await service.deleteJourney(req.params.id) }))

  // lifecycle
  write('post', '/:id/activate', async (req) => service.activateJourney(req.params.id))
  write('post', '/:id/pause', async (req) => service.pauseJourney(req.params.id))

  // enrollment
  write('post', '/:id/enroll', async (req) => service.enroll(req.params.id, req.body?.passport_id, { source: 'manual' }))
  read('get', '/:id/enrollments', async (req) => service.listEnrollments(req.params.id, { status: req.query.status }))
  read('get', '/:id/step-counts', async (req) => service.getStepCounts(req.params.id))
  // did it work — enrollment funnel + goal conversion + what the channels did
  read('get', '/:id/results', async (req) => service.getResults(req.params.id))
}

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) { res.status(err.status || 500).json({ error: err.message }) }
}
