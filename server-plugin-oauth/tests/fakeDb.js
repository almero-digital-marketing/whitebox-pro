// A minimal in-memory stand-in for the exact slice of knex's query builder
// this package actually calls (insert/where/first/update/returning/
// onConflict().ignore()) — enough to exercise the real store.js/users.js/
// keys.js logic without a live Postgres. Not a general knex mock.

export function makeFakeDb() {
  const tables = new Map()   // name → array of row objects

  const rows = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name) }
  // A column an insert() never set is `undefined` here but NULL in real
  // Postgres — normalize both sides so where({ used_at: null }) correctly
  // matches a row that simply never had used_at written, same as `IS NULL`.
  const matches = (row, cond) => Object.entries(cond).every(([k, v]) => (row[k] ?? null) === (v ?? null))

  function table(name) {
    return {
      // insert() returns a lazy, thenable chain — real knex builders don't
      // execute until awaited, and .onConflict()/.returning() need to attach
      // to that SAME pending query, not to an already-inserted row.
      insert(obj) {
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
      },
      where(cond) {
        const found = () => rows(name).filter(r => matches(r, cond))
        return {
          async first() { return found()[0] || null },
          async update(patch) {
            const targets = found()
            for (const r of targets) Object.assign(r, patch)
            return targets.length
          },
        }
      },
    }
  }

  const db = (name) => table(name)
  db._rows = (name) => rows(name)
  return db
}
