// A minimal in-memory stand-in for the exact slice of knex's query builder
// this package actually calls (insert/where/andWhere/select/orderBy/first/
// update/del/returning/onConflict().ignore()) — enough to exercise the real
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
      const applyFilters = () => rows(name).filter(r =>
        matches(r, state.cond) && state.extra.every(([col, op, val]) => OPS[op](r[col], val)))
      const project = (list) => state.cols
        ? list.map(r => Object.fromEntries(state.cols.map(c => [c, r[c]])))
        : list.map(r => ({ ...r }))
      const resolved = () => {
        const list = applyFilters()
        if (!state.orderCol) return project(list)
        const sorted = [...list].sort((a, b) => {
          const [x, y] = [a[state.orderCol], b[state.orderCol]]
          return state.orderDir === 'desc' ? (x < y ? 1 : x > y ? -1 : 0) : (x > y ? 1 : x < y ? -1 : 0)
        })
        return project(sorted)
      }

      return {
        select(cols) { return makeQuery({ ...state, cols }) },
        where(cond) { return makeQuery({ ...state, cond: { ...state.cond, ...cond } }) },
        andWhere(col, op, val) { return makeQuery({ ...state, extra: [...state.extra, [col, op, val]] }) },
        orderBy(col, dir = 'asc') { return makeQuery({ ...state, orderCol: col, orderDir: dir }) },
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

    return { insert, ...makeQuery({ cond: {}, extra: [], cols: null, orderCol: null, orderDir: null }) }
  }

  const db = (name) => table(name)
  db._rows = (name) => rows(name)
  return db
}
