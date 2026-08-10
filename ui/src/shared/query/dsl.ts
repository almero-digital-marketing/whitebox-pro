// A text notation for the filter tree, and its printer.
//
//   parse(text)   → the filter JSON server/src/selector/filter.js evaluates
//   print(filter) → the same filter as text
//
// JSON STAYS CANONICAL. This is a view, never a storage format — nothing
// persists text, the MCP keeps emitting JSON, and `print(parse(x))` is a
// property that can be tested exhaustively. If this notation turns out to be a
// mistake, deleting it strands nothing.
//
// It exists because the filter grammar is recursive (all/any/not each take a
// filter, not a clause) and the condition builder is one combinator over a flat
// list of rows. Text has no trouble with recursion; a grid of rows does. So the
// builder is the lossy view here, not this.
//
// Deliberately NOT SQL, and deliberately not SQL-shaped. The moment it reads as
// SQL, people reach for JOIN / GROUP BY / LIKE / IS NULL / subqueries, and every
// one of those is a papercut that has to be declined. This is a boolean
// expression over typed fields — the shape Sentry, Grafana and GitHub search
// use, none of which claim to be a query language.
//
//   membership = 'gold' and (city = 'Sofia' or city = 'Plovdiv')
//   not churned = true
//   count(event = 'booking.created', last 90d) >= 2
//   recency_days(event = 'visit') >= 180
//   sum(amount, event = 'purchase') >= 100
//   email is present

// Mirrors the engine. Fact ops come from facts/store.js; the metric aggregate
// list and its filter keys from selector/metric.js, where `bounds` is
// destructured as { field, gte, lte } — which is why a metric can only be
// compared with >= and <=, and a fact can use the full set.
const FACT_OPS: Record<string, string> = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
}
const FACT_OP_TEXT: Record<string, string> = Object.fromEntries(
  Object.entries(FACT_OPS).map(([text, op]) => [op, text]),
)
const AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
// Metric filter keys that are their own column. Anything else in an aggregate's
// argument list is an open per-event dimension and lands in `attrs`, which is
// what `event = '...'` relies on.
const METRIC_COLS = ['channel', 'direction', 'content']
const SESSION_COLS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer']
const WINDOW = /^\d+\s*[hdw]$/

export class QuerySyntaxError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.name = 'QuerySyntaxError'
    this.pos = pos
  }
}

type Tok = { kind: string; value: any; pos: number }

// ── tokenizer ───────────────────────────────────────────────────────────────
function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const push = (kind: string, value: any, pos: number) => toks.push({ kind, value, pos })

  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }

    if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',') { push(c, c, i); i++; continue }

    // Two-char operators first, or `>=` lexes as `>` followed by a stray `=`.
    const two = src.slice(i, i + 2)
    if (two === '>=' || two === '<=' || two === '!=') { push('op', two, i); i += 2; continue }
    if (c === '>' || c === '<' || c === '=') { push('op', c, i); i++; continue }

    if (c === "'" || c === '"') {
      const quote = c
      const start = i
      i++
      let out = ''
      while (i < src.length && src[i] !== quote) {
        // Backslash escapes so a value can contain its own quote. Only the
        // quote and the backslash are special — no \n/\t expansion, because a
        // fact value with a newline in it is a data problem, not a notation.
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2; continue }
        out += src[i]; i++
      }
      if (i >= src.length) throw new QuerySyntaxError('Unterminated string', start)
      i++
      push('string', out, start)
      continue
    }

    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i
      if (c === '-') i++
      while (i < src.length && /[0-9._]/.test(src[i])) i++
      const raw = src.slice(start, i)
      // A bare `30d` / `24h` / `2w` is a window, not a number — it only ever
      // appears after `last`, but lexing it here keeps the parser from having
      // to re-scan.
      if (/[hdw]/.test(src[i] || '')) { push('window', raw + src[i], start); i++; continue }
      push('number', Number(raw), start)
      continue
    }

    if (/[A-Za-z_]/.test(c)) {
      const start = i
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++
      const word = src.slice(start, i)
      const lower = word.toLowerCase()
      if (['and', 'or', 'not', 'in', 'is', 'present', 'last', 'true', 'false'].includes(lower)) {
        push(lower, word, start)
      } else push('ident', word, start)
      continue
    }

    throw new QuerySyntaxError(`Unexpected character ${JSON.stringify(c)}`, i)
  }
  push('end', null, src.length)
  return toks
}

// ── parser ──────────────────────────────────────────────────────────────────
export function parse(src: string): any {
  const toks = lex(src)
  let p = 0
  const peek = () => toks[p]
  const at = (kind: string) => toks[p].kind === kind
  const eat = (kind: string) => { if (!at(kind)) return null; return toks[p++] }
  const expect = (kind: string, what: string) => {
    if (!at(kind)) throw new QuerySyntaxError(`Expected ${what}`, peek().pos)
    return toks[p++]
  }

  // or is the loosest binding, then and, then not — the conventional order, and
  // the one that makes `a and b or c` mean what a reader expects.
  function parseOr(): any {
    const parts = [parseAnd()]
    while (eat('or')) parts.push(parseAnd())
    return parts.length === 1 ? parts[0] : { any: parts }
  }
  function parseAnd(): any {
    const parts = [parseNot()]
    while (eat('and')) parts.push(parseNot())
    return parts.length === 1 ? parts[0] : { all: parts }
  }
  function parseNot(): any {
    if (eat('not')) return { not: parseNot() }
    if (eat('(')) {
      const inner = parseOr()
      expect(')', 'a closing parenthesis')
      return inner
    }
    return parsePredicate()
  }

  function parseValue(): any {
    const t = peek()
    if (eat('string')) return t.value
    if (eat('number')) return t.value
    if (eat('true')) return true
    if (eat('false')) return false
    if (eat('window')) return t.value
    throw new QuerySyntaxError('Expected a value', t.pos)
  }

  function parseList(): any[] {
    expect('[', 'a list')
    const out: any[] = []
    if (!at(']')) {
      out.push(parseValue())
      while (eat(',')) out.push(parseValue())
    }
    expect(']', 'a closing bracket')
    return out
  }

  function parsePredicate(): any {
    const nameTok = expect('ident', 'a field name')
    const name: string = nameTok.value

    if (AGGS.includes(name) && at('(')) return parseMetric(name, nameTok.pos)

    // `key is present` — the only op with no right-hand value.
    if (eat('is')) {
      expect('present', '`present`')
      return { fact: { [name]: { present: true } } }
    }
    if (eat('in')) return { fact: { [name]: { in: parseList() } } }

    const opTok = expect('op', 'a comparison operator')
    const op = FACT_OPS[opTok.value]
    if (!op) throw new QuerySyntaxError(`Unknown operator ${opTok.value}`, opTok.pos)
    return { fact: { [name]: { [op]: parseValue() } } }
  }

  // count(event = 'x', channel = 'web', last 30d) >= 2
  //
  // Comma-separated and always ANDed, because that is all the engine's metric
  // filters can be — there is no or/not inside an aggregate. Using `and` here
  // would suggest otherwise.
  function parseMetric(agg: string, aggPos: number): any {
    expect('(', 'an argument list')
    const metric: any = {}
    const attrs: any = {}
    const session: any = {}
    let field: string | null = null

    const arg = () => {
      if (eat('last')) {
        const w = peek()
        if (!at('window') && !at('string')) throw new QuerySyntaxError('Expected a window like 30d, 24h or 2w', w.pos)
        p++
        if (!WINDOW.test(String(w.value))) throw new QuerySyntaxError(`Bad window ${JSON.stringify(w.value)} — use 30d, 24h or 2w`, w.pos)
        metric.last = String(w.value)
        return
      }
      const keyTok = expect('ident', 'an argument name')
      const key: string = keyTok.value

      // A bare identifier is `sum`'s field — the one place an argument is not a
      // filter. Rejected on the other aggregates rather than ignored, because
      // silently dropping it would make sum_dwell_ms(amount) look accepted.
      if (!at('op') && !at('in') && !at('is')) {
        if (agg !== 'sum') throw new QuerySyntaxError(`Only \`sum\` takes a field name; \`${agg}\` does not`, keyTok.pos)
        if (field) throw new QuerySyntaxError('sum takes one field', keyTok.pos)
        field = key
        return
      }

      let cond: any
      if (eat('is')) { expect('present', '`present`'); cond = { present: true } }
      else if (eat('in')) cond = { in: parseList() }
      else {
        const opTok = expect('op', 'a comparison operator')
        if (opTok.value !== '=') throw new QuerySyntaxError('Only `=`, `in` and `is present` are allowed inside an aggregate', opTok.pos)
        cond = parseValue()
      }

      if (key.startsWith('session.')) {
        const col = key.slice('session.'.length)
        if (!SESSION_COLS.includes(col)) {
          throw new QuerySyntaxError(`Unknown session column "${col}" — one of ${SESSION_COLS.join(', ')}`, keyTok.pos)
        }
        session[col] = cond
      } else if (METRIC_COLS.includes(key)) {
        if (typeof cond === 'object') throw new QuerySyntaxError(`\`${key}\` takes a plain value`, keyTok.pos)
        metric[key] = cond
      } else {
        attrs[key] = cond
      }
    }

    if (!at(')')) { arg(); while (eat(',')) arg() }
    expect(')', 'a closing parenthesis')

    if (Object.keys(attrs).length) metric.attrs = attrs
    if (Object.keys(session).length) metric.session = session

    const opTok = expect('op', 'a comparison — an aggregate must be compared')
    if (opTok.value !== '>=' && opTok.value !== '<=') {
      throw new QuerySyntaxError('An aggregate can only be compared with >= or <=', opTok.pos)
    }
    const nTok = peek()
    if (!at('number')) throw new QuerySyntaxError('Expected a number', nTok.pos)
    p++

    if (agg === 'sum' && !field) throw new QuerySyntaxError('`sum` needs a field — sum(amount, ...)', aggPos)
    const bound: any = { [opTok.value === '>=' ? 'gte' : 'lte']: nTok.value }
    metric[agg] = field ? { field, ...bound } : bound
    return { metric }
  }

  const out = parseOr()
  if (!at('end')) throw new QuerySyntaxError('Unexpected trailing input', peek().pos)
  return out
}

// ── printer ─────────────────────────────────────────────────────────────────
// Precedence, so the printer parenthesises exactly when it must: an `any`
// inside an `all`, or either inside a `not`. Printing more parens than needed
// would break round-trip equality on the text side.
//
// NESTING OF THE SAME COMBINATOR IS FLATTENED, and that is intended.
// `{any:[a, b, {any:[c, d]}]}` prints as `a or b or c or d`, which parses back
// to the flat four. The result is the same cohort — the engine folds `any` with
// unionTimed and `all` with intersectTimed, and both the set and the matched_at
// combinators (earliest for any, latest for all) are associative — so the only
// thing lost is a redundant bracket nobody wanted to read.
//
// The consequence to know: a query re-saved through the text editor comes back
// normalised. Meaning-preserving, shape-changing. The exact property is
// `parse(print(x))` equals x with same-combinator nesting collapsed, and
// `print` is idempotent from the second pass on.
const PREC = { or: 1, and: 2, not: 3, atom: 4 }

function quote(v: any): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function printCond(key: string, cond: any): string {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if (cond.present === true) return `${key} is present`
    if (Array.isArray(cond.in)) return `${key} in [${cond.in.map(quote).join(', ')}]`
  }
  if (Array.isArray(cond)) return `${key} in [${cond.map(quote).join(', ')}]`
  return `${key} = ${quote(cond)}`
}

function printMetric(m: any): string {
  const agg = AGGS.find((a) => a in m)
  if (!agg) throw new Error('metric clause has no aggregate')
  const bounds = m[agg] || {}
  const args: string[] = []

  if (agg === 'sum' && bounds.field) args.push(bounds.field)
  for (const [k, v] of Object.entries(m.attrs || {})) args.push(printCond(k, v))
  for (const k of METRIC_COLS) if (m[k] != null) args.push(`${k} = ${quote(m[k])}`)
  for (const [k, v] of Object.entries(m.session || {})) args.push(printCond(`session.${k}`, v))
  if (m.last) args.push(`last ${m.last}`)

  const cmp = bounds.gte != null ? `>= ${bounds.gte}` : `<= ${bounds.lte}`
  return `${agg}(${args.join(', ')}) ${cmp}`
}

function printNode(node: any, ctx: number): string {
  const wrap = (s: string, prec: number) => (prec < ctx ? `(${s})` : s)

  if (node?.all) return wrap(node.all.map((c: any) => printNode(c, PREC.and)).join(' and '), PREC.and)
  if (node?.any) return wrap(node.any.map((c: any) => printNode(c, PREC.or)).join(' or '), PREC.or)
  if (node?.not) return wrap(`not ${printNode(node.not, PREC.not)}`, PREC.not)
  if (node?.metric) return printMetric(node.metric)
  if (node?.fact) {
    const key = Object.keys(node.fact)[0]
    const pred = node.fact[key] || {}
    const op = Object.keys(pred)[0]
    const val = pred[op]
    if (op === 'present') return `${key} is present`
    if (op === 'in') return `${key} in [${(val || []).map(quote).join(', ')}]`
    const text = FACT_OP_TEXT[op]
    if (!text) throw new Error(`unknown fact op ${op}`)
    return `${key} ${text} ${quote(val)}`
  }
  throw new Error(`cannot print ${JSON.stringify(node)}`)
}

export function print(filter: any): string {
  if (!filter || !Object.keys(filter).length) return ''
  return printNode(filter, PREC.or)
}
