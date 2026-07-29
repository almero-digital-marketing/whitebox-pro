// REST transport — thin routes over the service, split by authority rather
// than HTTP verb. Three gates, not two: erase gets its own, because deleting a
// person forever is a different kind of permission from correcting their
// email, and a support role that needs one usually shouldn't have the other.

export function register(app, { service, requireRead, requireWrite, requireErase }) {
  const read = (method, path, fn) => app[method](`/people${path}`, requireRead, wrap(fn))
  const write = (method, path, fn) => app[method](`/people${path}`, requireWrite, wrap(fn))
  const erase = (method, path, fn) => app[method](`/people${path}`, requireErase, wrap(fn))

  read('get', '', async (req) => service.list({
    q: req.query.q,
    // `?fields=identities,facts` — CSV rather than repeated params so the
    // whole search scope stays one readable, cacheable query string
    fields: req.query.fields,
    includeAnonymous: req.query.include_anonymous,
    limit: req.query.limit,
    offset: req.query.offset,
  }))
  // the lists a person can be added to — before /:id so "lists" isn't read as an id
  read('get', '/lists', async () => service.lists())
  // …and the fact keys already in use, for the same reason a key field needs them
  read('get', '/fact-keys', async () => service.factKeys())
  read('get', '/:id', async (req) => service.get(req.params.id))
  // paged awareness rows — `?limit=&offset=&directions=expression,conversion`
  read('get', '/:id/activity', async (req) => service.activity(req.params.id, req.query))

  write('post', '/:id/identities', async (req) => service.linkIdentity(req.params.id, req.body || {}))
  write('delete', '/:id/identities/:identityId', async (req) =>
    service.unlinkIdentity(req.params.id, req.params.identityId))
  write('post', '/:id/facts', async (req) => service.recordFact(req.params.id, req.body || {}))
  write('post', '/lists', async (req) => service.createList(req.body?.name))
  // Bulk. Both take the same `{passport_ids | query}` envelope and both sit on
  // a literal path segment, declared before the /:id routes so "lists" and
  // "facts" are never read as a passport id.
  write('post', '/lists/:segmentId/members', async (req) => service.addManyToList(req.params.segmentId, {
    passportIds: req.body?.passport_ids,
    query: req.body?.query,
  }))
  write('post', '/facts', async (req) => service.recordFactForMany(
    { key: req.body?.key, value: req.body?.value, observed_at: req.body?.observed_at },
    { passportIds: req.body?.passport_ids, query: req.body?.query },
  ))
  write('post', '/:id/lists', async (req) => service.addToList(req.params.id, req.body?.segment_id))
  write('delete', '/:id/lists/:segmentId', async (req) => service.removeFromList(req.params.id, req.params.segmentId))
  // survivor in the path, absorbed in the body — the path id is the person who
  // continues to exist, which is also the id the response is about
  write('post', '/:id/merge', async (req) => service.merge(req.params.id, req.body?.absorbed_id))

  // Bulk erase — POST, not DELETE, because it carries the same
  // `{passport_ids | query}` envelope as the other bulk verbs and a DELETE body
  // is not reliably forwarded by proxies. Before /:id for the usual reason.
  erase('post', '/erase', async (req) => service.eraseMany({
    passportIds: req.body?.passport_ids,
    query: req.body?.query,
  }))
  erase('delete', '/:id', async (req) => service.erase(req.params.id))
}

// Same error contract as every other plugin's transport: a thrown `status`
// surfaces as that code, anything else is a 500 with the message.
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
}
