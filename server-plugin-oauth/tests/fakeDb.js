// A minimal in-memory stand-in for the exact slice of knex's query builder
// this package actually calls (insert/where/andWhere/whereNotNull/select/
// orderBy/first/update/del/returning/onConflict().ignore(), plus the
// clone/clearSelect/clearOrder/count/limit/offset that pagedList() drives)
// — enough to exercise the real
// store.js/users.js/keys.js logic without a live Postgres. Not a general
// knex mock.

export function makeFakeDb() {
  const tables = new Map()   // name → array of row objects

  const rows = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name) }
  // A column an insert() never set is `undefined` here but NULL in real
  // Postgres — normalize both sides so where({ used_at: null }) correctly
  // matches a row that simply never had used_at written, same as `IS NULL`.
  const matches = (row, cond) => Object.entries(cond).every(([k, v]) => (row[k] ?? null) === (v ?? null))

  const OPS = {
    '>': (a, b) => a > b, '<': (a, b) => a < b,
    '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
    '=': (a, b) => a === b,
  }

  function table(name) {
    function makeQuery(state) {
      // `ilike '%term%'` — the only operator pagedList() emits. Case-insensitive
      // contains, ORed across the searched columns; a row passes if ANY match.
      const likes = (r) => !state.orTerms.length || state.orTerms.some(([col, , val]) =>
        String(r[col] ?? '').toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase()))
      const applyFilters = () => rows(name).filter(r =>
        matches(r, state.cond) && state.extra.every(([col, op, val]) => OPS[op](r[col], val))
        && state.notNull.every(col => (r[col] ?? null) !== null) && likes(r)
        && state.isNull.every(col => (r[col] ?? null) === null)
        && state.notIn.every(([col, vals]) => !vals.includes(r[col])))
      const project = (list) => state.cols
        ? list.map(r => Object.fromEntries(state.cols.map(c => [c, r[c]])))
        : list.map(r => ({ ...r }))
      // ORDER BY is a LIST, applied in the order it was declared — knex APPENDS
      // each orderBy() rather than replacing the last one. Modelling that
      // matters here specifically: pagedList() adds a unique tiebreaker after
      // the caller's sort column, and a fake that kept only the final term
      // would silently sort by the tiebreaker ALONE — the tests would pass
      // while proving the opposite of the real query's behaviour.
      const dedupe = (list) => state.uniq
        ? [...new Map(list.map(r => [JSON.stringify(r), r])).values()]
        : list
      const resolved = () => {
        const list = applyFilters()
        if (!state.order.length) return dedupe(project(window(list)))
        const sorted = [...list].sort((a, b) => {
          for (const [col, dir] of state.order) {
            const [x, y] = [a[col], b[col]]
            if (x === y) continue
            const cmp = x > y ? 1 : -1
            return dir === 'desc' ? -cmp : cmp
          }
          return 0
        })
        return dedupe(project(window(sorted)))
      }
      // limit/offset applied last, after ordering — same as SQL
      const window = (list) => (state.limit == null && !state.offset)
        ? list
        : list.slice(state.offset || 0, state.limit == null ? undefined : (state.offset || 0) + state.limit)

      return {
        // Varargs AND array form, like knex: select('a', 'b') and select(['a', 'b']) are the
        // same call. Only the array form was handled, so a two-column select silently set cols
        // to a string and blew up in projection.
        select(...cols) { return makeQuery({ ...state, cols: cols.flat() }) },
        where(cond, op, val) {
          // The 3-arg operator form (status()'s `where('created_at', '>=', d)`)
          // is the same thing as andWhere below — knex treats them as aliases.
          if (op !== undefined) return makeQuery({ ...state, extra: [...state.extra, [cond, op, val]] })
          // pagedList() passes a CALLBACK to group its ORed ilike terms. Only
          // that shape is supported, and only orWhere inside it — enough to
          // exercise the real searchUsers(), not a general WHERE compiler.
          if (typeof cond === 'function') {
            const terms = []
            cond({ orWhere: (col, op, val) => terms.push([col, op, val]) })
            return makeQuery({ ...state, orTerms: [...state.orTerms, ...terms] })
          }
          return makeQuery({ ...state, cond: { ...state.cond, ...cond } })
        },
        andWhere(col, op, val) { return makeQuery({ ...state, extra: [...state.extra, [col, op, val]] }) },
        whereNotNull(col) { return makeQuery({ ...state, notNull: [...state.notNull, col] }) },
        whereNull(col) { return makeQuery({ ...state, isNull: [...state.isNull, col] }) },
        // Array form only. The real prune deliberately passes an array rather than a subquery
        // (see store.pruneDynamicClients), so that is the whole surface needed — a fake that
        // pretended to run subqueries would misrepresent what a test proves.
        whereNotIn(col, vals) { return makeQuery({ ...state, notIn: [...state.notIn, [col, [...vals]]] }) },
        // DISTINCT over the PROJECTED columns, which is what `.distinct('client_id')` means.
        distinct(...cols) { return makeQuery({ ...state, cols: cols.length ? cols : state.cols, uniq: true }) },
        orderBy(col, dir = 'asc') { return makeQuery({ ...state, order: [...state.order, [col, dir]] }) },
        // pagedList() reaches for modify() to add its tiebreaker conditionally.
        // Real knex hands the callback a MUTABLE builder; this fake is
        // immutable, so instead of passing a stub that understands one method
        // (and silently no-ops on any other), record whatever the callback
        // calls and replay it onto the chain.
        modify(fn) {
          const calls = []
          const rec = new Proxy({}, { get: (_t, m) => (...args) => { calls.push([m, args]); return rec } })
          fn(rec)
          return calls.reduce((q, [m, args]) => q[m](...args), this)
        },
        // The slice of knex that pagedList() drives. clone() is what makes it
        // safe to count and then fetch from one builder; the two clear* calls
        // are how it strips the projection and ordering off the COUNT.
        clone() { return makeQuery({ ...state }) },
        clearSelect() { return makeQuery({ ...state, cols: null }) },
        clearOrder() { return makeQuery({ ...state, order: [] }) },
        limit(n) { return makeQuery({ ...state, limit: n }) },
        offset(n) { return makeQuery({ ...state, offset: n }) },
        async count() { return [{ count: String(applyFilters().length) }] },
        async first() { return resolved()[0] || null },
        async update(patch) {
          const targets = applyFilters()
          // whitebox_oauth_users.email is UNIQUE in the real schema — simulate that one
          // real constraint (not a general knex mock) so a duplicate-email PATCH exercises
          // the same 23505 path the route maps to a 409, instead of silently "succeeding".
          if (name === 'whitebox_oauth_users' && patch.email) {
            const targetIds = new Set(targets.map(r => r.id))
            const conflict = rows(name).some(r => !targetIds.has(r.id) && r.email === patch.email)
            if (conflict) {
              const err = new Error(`duplicate key value violates unique constraint "whitebox_oauth_users_email_unique"`)
              err.code = '23505'
              throw err
            }
          }
          for (const r of targets) Object.assign(r, patch)
          return targets.length
        },
        async del() {
          const targets = new Set(applyFilters())
          tables.set(name, rows(name).filter(r => !targets.has(r)))
          return targets.size
        },
        then(resolve, reject) {
          try { resolve(resolved()) } catch (err) { reject(err) }
        },
      }
    }

    // insert() returns a lazy, thenable chain — real knex builders don't
    // execute until awaited, and .onConflict()/.returning() need to attach
    // to that SAME pending query, not to an already-inserted row.
    function insert(obj) {
      let conflictCol = null
      let ignoreOnConflict = false
      let returningCols = null
      const chain = {
        onConflict(col) {
          conflictCol = col
          return { ignore: () => { ignoreOnConflict = true; return chain } }
        },
        returning(cols) { returningCols = cols; return chain },
        then(resolve, reject) {
          try {
            if (conflictCol && ignoreOnConflict && rows(name).some(r => r[conflictCol] === obj[conflictCol])) {
              return resolve(returningCols ? [] : undefined)
            }
            rows(name).push({ ...obj })
            resolve(returningCols ? [Object.fromEntries(returningCols.map(c => [c, obj[c]]))] : undefined)
          } catch (err) { reject(err) }
        },
      }
      return chain
    }

    return { insert, ...makeQuery({ cond: {}, extra: [], notNull: [], isNull: [], notIn: [], orTerms: [], cols: null, order: [], limit: null, offset: 0, uniq: false }) }
  }

  const db = (name) => table(name)
  db._rows = (name) => rows(name)
  return db
}
