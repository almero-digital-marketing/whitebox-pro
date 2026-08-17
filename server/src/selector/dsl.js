// A text notation for the filter tree, its printer, and a validator.
//
//   parse(text)      → the filter JSON filter.js evaluates
//   print(filter)     → the same filter as text
//   validate(filter)  → [{ path, message }], empty when well-formed
//
// Lives here, beside filter.js, because it encodes that grammar and nothing
// else. Put it anywhere further away and the two drift the first time an
// operator is added.
//
// JSON STAYS CANONICAL. The text is a view, never a storage format: nothing
// persists it, the MCP keeps emitting JSON, and deleting this module would
// strand nothing.
//
// It exists because the filter grammar is recursive — all/any/not each take a
// filter, not a clause — while a condition-builder UI is one combinator over a
// flat list of rows. Text has no trouble with recursion; a grid of rows does.
//
// Deliberately not SQL and not SQL-shaped. Anything that reads as SQL invites
// JOIN / GROUP BY / LIKE / subqueries, every one of which has to be declined,
// and the aggregate form is where the illusion would break hardest — it is not
// a table you can select from. This is a boolean expression over typed fields.
//
//   membership = 'gold' and (city = 'Sofia' or city = 'Plovdiv')
//   count(event = 'booking.created', last 90d) >= 2
//   recency_days(event = 'visit') >= 180
//   sum(amount, event = 'purchase') >= 100
//   email is present

// Mirrors the engine rather than inventing. Fact ops come from facts/store; the
// aggregates and their filter keys from metric.js, where `bounds` is
// destructured as { field, gte, lte } — which is why an aggregate compares only
// with >= or <=, while a fact takes the full set.
const FACT_OPS = { '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }
const FACT_OP_TEXT = Object.fromEntries(Object.entries(FACT_OPS).map(([text, op]) => [op, text]))
// The value comparators PLUS the history operators. This carried only the
// comparators, so the validator rejected every temporal predicate the engine has
// always supported — `transition`, `changed`, `decreased`, `increased` — and a
// widget using one failed to save with "unknown operator". The validator being
// stricter than the engine is the same class of bug as it being looser: both make
// it lie about what the engine will do.
const FACT_HISTORY_OPS = ['changed', 'transition', 'decreased', 'increased', 'held', 'distinct']
const FACT_OP_NAMES = new Set([...Object.values(FACT_OPS), 'in', 'present', ...FACT_HISTORY_OPS])
// The engine has TWO aggregate sets, and which one applies depends on how the
// clause is evaluated — not on how it is written.
//
//   gate  (filter.metric, no `group`)  → metric.evaluate, GATE_AGGS
//   group (filter.metric with `group`) → metric.group,    GROUP_AGGS
//
// They are not the same list. `recency_days` is a gate only — there is nothing
// to bucket about "days since" — and `distinct_passports` is a group only,
// because a per-passport aggregate cannot gate the passports it counts.
//
// Bounds differ too: a gate NEEDS gte/lte (an aggregate with no bound matches
// nothing), while a group IGNORES them — `count: {}` is the correct and
// documented way to write a timeseries.
//
// Validating both against the gate rules rejected the two commonest widget
// shapes there are, which is exactly what happened.
const GATE_AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
// MUST match metric.js GROUP_AGGS. It did not: the value aggregates shipped in the
// engine and this list was left behind, so `avg`/`median` reached here and were
// rejected as "not an aggregate" — the feature existed and no caller could get to
// it, because everything except a direct selector.resolve() comes through
// validate(). Engine tests passed precisely because they bypass this file.
const VALUE_AGGS = ['avg', 'min', 'max', 'median', 'percentile', 'earliest', 'latest']
const GROUP_AGGS = ['count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum', ...VALUE_AGGS]
// The notation can write either, so parse and print span both.
const AGGS = [...new Set([...GATE_AGGS, ...GROUP_AGGS])]
// Metric filter keys that are their own column. Anything else in an aggregate's
// argument list is an open per-event dimension and lands in `attrs`, which is
// what `event = '...'` relies on.
// `source` belongs here: it is an indexed exposure column that has always been
// groupable, and filtering on it is how "was exposed to video AT ALL" is said.
// Without it the only handle was `channel`, which lumps video in with page views
// and text engagement.
const METRIC_COLS = ['channel', 'direction', 'source', 'content']
const METRIC_KEYS = new Set([...METRIC_COLS, 'last', 'since', 'until', 'window', 'session', 'attrs'])
const ANCHOR_USE = ['last', 'first', 'min', 'max']
const MISSING = ['exclude', 'include', 'only']
const WINDOW_KEYS = ['before', 'after', 'between', 'offset', 'within', 'missing']
const OFFSET = /^-?\d+\s*[hdw]$/
const SESSION_COLS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer']
const WINDOW = /^\d+\s*[hdw]$/

export class QuerySyntaxError extends Error {
    constructor(message, pos) {
        super(message)
        this.name = 'QuerySyntaxError'
        this.pos = pos
    }
}

function lex(src) {
    const toks = []
    let i = 0
    const push = (kind, value, pos) => toks.push({ kind, value, pos })

    while (i < src.length) {
        const c = src[i]
        if (/\s/.test(c)) { i++; continue }
        if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',') { push(c, c, i); i++; continue }

        // Two-char operators first, or `>=` lexes as `>` plus a stray `=`.
        const two = src.slice(i, i + 2)
        if (two === '>=' || two === '<=' || two === '!=') { push('op', two, i); i += 2; continue }
        if (c === '>' || c === '<' || c === '=') { push('op', c, i); i++; continue }

        if (c === "'" || c === '"') {
            const quote = c
            const start = i
            i++
            let out = ''
            while (i < src.length && src[i] !== quote) {
                // Backslash escapes so a value can contain its own quote. Only
                // the quote and the backslash are special — no \n expansion,
                // because a fact value with a newline is a data problem.
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
            // A bare `30d` / `24h` / `2w` is a window, not a number. It only
            // appears after `last`, but lexing it here saves a re-scan.
            if (/[hdw]/.test(src[i] || '')) { push('window', raw + src[i], start); i++; continue }
            push('number', Number(raw), start)
            continue
        }

        if (/[A-Za-z_]/.test(c)) {
            const start = i
            while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++
            const word = src.slice(start, i)
            const lower = word.toLowerCase()
            if (['and', 'or', 'not', 'in', 'is', 'present', 'last', 'true', 'false'].includes(lower)) push(lower, word, start)
            else push('ident', word, start)
            continue
        }

        throw new QuerySyntaxError(`Unexpected character ${JSON.stringify(c)}`, i)
    }
    push('end', null, src.length)
    return toks
}

export function parse(src) {
    const toks = lex(src)
    let p = 0
    const peek = () => toks[p]
    const at = (kind) => toks[p].kind === kind
    const eat = (kind) => (at(kind) ? toks[p++] : null)
    const expect = (kind, what) => {
        if (!at(kind)) throw new QuerySyntaxError(`Expected ${what}`, peek().pos)
        return toks[p++]
    }

    // or binds loosest, then and, then not — the conventional order, and the one
    // that makes `a and b or c` mean what a reader expects.
    function parseOr() {
        const parts = [parseAnd()]
        while (eat('or')) parts.push(parseAnd())
        return parts.length === 1 ? parts[0] : { any: parts }
    }
    function parseAnd() {
        const parts = [parseNot()]
        while (eat('and')) parts.push(parseNot())
        return parts.length === 1 ? parts[0] : { all: parts }
    }
    function parseNot() {
        if (eat('not')) return { not: parseNot() }
        if (eat('(')) {
            const inner = parseOr()
            expect(')', 'a closing parenthesis')
            return inner
        }
        return parsePredicate()
    }

    function parseValue() {
        const t = peek()
        if (eat('string')) return t.value
        if (eat('number')) return t.value
        if (eat('true')) return true
        if (eat('false')) return false
        if (eat('window')) return t.value
        throw new QuerySyntaxError('Expected a value', t.pos)
    }

    function parseList() {
        expect('[', 'a list')
        const out = []
        if (!at(']')) {
            out.push(parseValue())
            while (eat(',')) out.push(parseValue())
        }
        expect(']', 'a closing bracket')
        return out
    }

    function parsePredicate() {
        const nameTok = expect('ident', 'a field name')
        const name = nameTok.value
        if (AGGS.includes(name) && at('(')) return parseMetric(name, nameTok.pos)

        // `key is present` — the only op with no right-hand value.
        if (eat('is')) { expect('present', '`present`'); return { fact: { [name]: { present: true } } } }
        if (eat('in')) return { fact: { [name]: { in: parseList() } } }

        const opTok = expect('op', 'a comparison operator')
        const op = FACT_OPS[opTok.value]
        if (!op) throw new QuerySyntaxError(`Unknown operator ${opTok.value}`, opTok.pos)
        return { fact: { [name]: { [op]: parseValue() } } }
    }

    // count(event = 'x', channel = 'web', last 30d) >= 2
    //
    // Comma-separated and always ANDed, because that is all the engine's metric
    // filters can be — there is no or/not inside an aggregate, and using `and`
    // here would imply otherwise.
    function parseMetric(agg, aggPos) {
        expect('(', 'an argument list')
        const metric = {}
        const attrs = {}
        const session = {}
        let field = null

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
            const key = keyTok.value

            // A bare identifier is `sum`'s field — the one argument that is not
            // a filter. Rejected elsewhere rather than ignored, because dropping
            // it silently would make sum_dwell_ms(amount) look accepted.
            if (!at('op') && !at('in') && !at('is')) {
                if (agg !== 'sum') throw new QuerySyntaxError(`Only \`sum\` takes a field name; \`${agg}\` does not`, keyTok.pos)
                if (field) throw new QuerySyntaxError('sum takes one field', keyTok.pos)
                field = key
                return
            }

            let cond
            if (eat('is')) { expect('present', '`present`'); cond = { present: true } }
            else if (eat('in')) cond = { in: parseList() }
            else {
                const opTok = expect('op', 'a comparison operator')
                if (opTok.value !== '=') throw new QuerySyntaxError('Only `=`, `in` and `is present` are allowed inside an aggregate', opTok.pos)
                cond = parseValue()
            }

            if (key.startsWith('session.')) {
                const col = key.slice('session.'.length)
                if (!SESSION_COLS.includes(col)) throw new QuerySyntaxError(`Unknown session column "${col}" — one of ${SESSION_COLS.join(', ')}`, keyTok.pos)
                session[col] = cond
            } else if (METRIC_COLS.includes(key)) {
                if (typeof cond === 'object') throw new QuerySyntaxError(`\`${key}\` takes a plain value`, keyTok.pos)
                metric[key] = cond
            } else attrs[key] = cond
        }

        if (!at(')')) { arg(); while (eat(',')) arg() }
        expect(')', 'a closing parenthesis')

        if (Object.keys(attrs).length) metric.attrs = attrs
        if (Object.keys(session).length) metric.session = session

        const opTok = expect('op', 'a comparison — an aggregate must be compared')
        if (opTok.value !== '>=' && opTok.value !== '<=') throw new QuerySyntaxError('An aggregate can only be compared with >= or <=', opTok.pos)
        const nTok = peek()
        if (!at('number')) throw new QuerySyntaxError('Expected a number', nTok.pos)
        p++

        if (agg === 'sum' && !field) throw new QuerySyntaxError('`sum` needs a field — sum(amount, ...)', aggPos)
        const bound = { [opTok.value === '>=' ? 'gte' : 'lte']: nTok.value }
        metric[agg] = field ? { field, ...bound } : bound
        return { metric }
    }

    const out = parseOr()
    if (!at('end')) throw new QuerySyntaxError('Unexpected trailing input', peek().pos)
    return out
}

// Precedence, so the printer parenthesises exactly when it must: an `any` inside
// an `all`, or either inside a `not`. Printing more parens than needed would
// break round-trip equality on the text side.
//
// NESTING OF THE SAME COMBINATOR IS FLATTENED, and that is intended.
// `{any:[a, b, {any:[c, d]}]}` prints as `a or b or c or d`, which parses back
// to the flat four. Same cohort: `any` folds with unionTimed and `all` with
// intersectTimed, and both the set and the matched_at combinators (earliest for
// any, latest for all) are associative — so the only casualty is a redundant
// bracket. The exact property is that parse(print(x)) equals x with that
// collapse applied, and print is idempotent thereafter.
const PREC = { or: 1, and: 2, not: 3 }

function quote(v) {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function printCond(key, cond) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if (cond.present === true) return `${key} is present`
        if (Array.isArray(cond.in)) return `${key} in [${cond.in.map(quote).join(', ')}]`
    }
    if (Array.isArray(cond)) return `${key} in [${cond.map(quote).join(', ')}]`
    return `${key} = ${quote(cond)}`
}

function printMetric(m) {
    const agg = AGGS.find((a) => a in m)
    if (!agg) throw new Error('metric clause has no aggregate')
    const bounds = m[agg] || {}
    const args = []
    if (agg === 'sum' && bounds.field) args.push(bounds.field)
    for (const [k, v] of Object.entries(m.attrs || {})) args.push(printCond(k, v))
    for (const k of METRIC_COLS) if (m[k] != null) args.push(`${k} = ${quote(m[k])}`)
    for (const [k, v] of Object.entries(m.session || {})) args.push(printCond(`session.${k}`, v))
    if (m.last) args.push(`last ${m.last}`)
    const cmp = bounds.gte != null ? `>= ${bounds.gte}` : `<= ${bounds.lte}`
    return `${agg}(${args.join(', ')}) ${cmp}`
}

function printNode(node, ctx) {
    const wrap = (s, prec) => (prec < ctx ? `(${s})` : s)
    if (node?.all) return wrap(node.all.map((c) => printNode(c, PREC.and)).join(' and '), PREC.and)
    if (node?.any) return wrap(node.any.map((c) => printNode(c, PREC.or)).join(' or '), PREC.or)
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

export function print(filter) {
    if (!filter || !Object.keys(filter).length) return ''
    return printNode(filter, PREC.or)
}

// Well-formedness, as a LIST rather than a throw.
//
// The caller is a write boundary answering an agent that had no schema to work
// from, so it needs to say everything that is wrong at once and say where — one
// error at a time turns a fix into a guessing game across several tool calls.
//
// Separate from print() on purpose. print() is not a validator: a metric with
// neither gte nor lte prints `<= undefined` rather than failing, so using it as
// a check would pass exactly the malformed input worth catching.
export function validate(filter, { grouped = false } = {}) {
    const aggs = grouped ? GROUP_AGGS : GATE_AGGS
    const errors = []
    const err = (path, message) => errors.push({ path, message })

    const walkCond = (path, cond, what) => {
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
            const keys = Object.keys(cond)
            if (keys.length !== 1 || !['in', 'present'].includes(keys[0])) {
                err(path, `${what} takes a value, { in: [...] } or { present: true }`)
            } else if (keys[0] === 'in' && !Array.isArray(cond.in)) err(path, '`in` takes an array')
        }
    }

    const walk = (node, path) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return err(path, 'a filter must be an object')
        }
        const keys = Object.keys(node)
        if (keys.length !== 1) {
            return err(path, `a filter takes exactly one of all/any/not/fact/metric, got ${keys.length ? keys.join(' + ') : 'nothing'}`)
        }
        const key = keys[0]

        if (key === 'all' || key === 'any') {
            if (!Array.isArray(node[key]) || !node[key].length) return err(path, `\`${key}\` takes a non-empty array of filters`)
            node[key].forEach((c, i) => walk(c, `${path}.${key}[${i}]`))
            return
        }
        if (key === 'not') return walk(node.not, `${path}.not`)

        if (key === 'fact') {
            const f = node.fact
            if (!f || typeof f !== 'object') return err(path, '`fact` takes an object')
            const fk = Object.keys(f)
            if (fk.length !== 1) return err(path, `a fact clause takes exactly one key, got ${fk.length}`)
            const pred = f[fk[0]]
            if (!pred || typeof pred !== 'object' || Array.isArray(pred)) return err(`${path}.fact.${fk[0]}`, 'takes an { op: value } object')
            // MULTIPLE operators are AND-ed by the engine — `{ gte: 200, lte: 400 }`
            // is how a range is written, and operators.js documents it as such. This
            // insisted on exactly one, so the validator refused the only way to
            // express a range.
            const ops = Object.keys(pred)
            if (!ops.length) return err(`${path}.fact.${fk[0]}`, 'takes at least one operator')
            for (const o of ops) {
                if (!FACT_OP_NAMES.has(o)) return err(`${path}.fact.${fk[0]}`, `unknown operator "${o}" — one of ${[...FACT_OP_NAMES].join(', ')}`)
            }
            if ('in' in pred && !Array.isArray(pred.in)) err(`${path}.fact.${fk[0]}`, '`in` takes an array')
            if ('present' in pred && typeof pred.present !== 'boolean') err(`${path}.fact.${fk[0]}`, '`present` takes true or false')
            if ('distinct' in pred) {
                const d = pred.distinct
                const shape = d && typeof d === 'object' ? d : null
                if (!shape || (shape.gte == null && shape.lte == null)) {
                    err(`${path}.fact.${fk[0]}`, '`distinct` takes { gte: n } and/or { lte: n } — how many different values were held')
                }
            }
            return
        }

        if (key === 'metric') {
            const m = node.metric
            if (!m || typeof m !== 'object') return err(path, '`metric` takes an object')
            const found = aggs.filter((a) => a in m)
            if (found.length !== 1) {
                return err(`${path}.metric`, `needs exactly one aggregate (${aggs.join('/')}), got ${found.length ? found.join(' + ') : 'none'}`)
            }
            const agg = found[0]
            for (const k of Object.keys(m)) {
                if (k !== agg && !METRIC_KEYS.has(k)) err(`${path}.metric`, `unknown key "${k}" — one of ${[...METRIC_KEYS].join(', ')} or an aggregate`)
            }
            const bounds = m[agg]
            if (!bounds || typeof bounds !== 'object') return err(`${path}.metric.${agg}`, 'takes a { gte } or { lte } bound')
            // A grouped aggregate is bucketed, not compared — metric.group reads
            // no bound at all, and `count: {}` is how a timeseries is written.
            if (!grouped && typeof bounds.gte !== 'number' && typeof bounds.lte !== 'number') {
                err(`${path}.metric.${agg}`, 'needs a numeric gte or lte — an aggregate with no bound matches nothing')
            }
            if (agg === 'sum' && !bounds.field) err(`${path}.metric.sum`, 'needs a `field`')
            // Value aggregates read ONE numeric source. Mirrors numericSource() in
            // metric.js — kept here so a bad shape is one error naming all three
            // options, not a 500 from the engine.
            if (VALUE_AGGS.includes(agg)) {
                const given = ['field', 'column', 'fact'].filter((k) => bounds[k] != null)
                if (given.length === 0 && !['earliest', 'latest'].includes(agg)) {
                    err(`${path}.metric.${agg}`, 'needs a `field` (a meta attribute), a `column` (dwell_ms), or a `fact` (a fact key)')
                }
                if (given.length > 1) err(`${path}.metric.${agg}`, `takes one of field/column/fact, not ${given.join(' + ')}`)
                if (agg === 'percentile' && !(typeof bounds.p === 'number' && bounds.p > 0 && bounds.p < 1)) {
                    err(`${path}.metric.percentile`, 'needs `p` between 0 and 1 (0.9 = the 90th percentile)')
                }
                if (['earliest', 'latest'].includes(agg) && bounds.fact != null) {
                    err(`${path}.metric.${agg}`, 'orders by event time, and a fact has one current value per passport — there is no first or last one to take')
                }
            }
            // A fact-anchored window: the boundary is a different instant for every
            // passport, so it is the one time bound `since`/`until`/`asOf` cannot say.
            if (m.window != null) {
                const w = m.window
                if (typeof w !== 'object' || Array.isArray(w)) err(`${path}.metric.window`, 'takes an object')
                else {
                    for (const k of Object.keys(w)) {
                        if (!WINDOW_KEYS.includes(k)) err(`${path}.metric.window`, `unknown key "${k}" — one of ${WINDOW_KEYS.join(', ')}`)
                    }
                    const sides = ['before', 'after', 'between'].filter((k) => w[k] != null)
                    if (sides.length !== 1) {
                        err(`${path}.metric.window`, `takes exactly one of before/after/between, got ${sides.length ? sides.join(' + ') : 'none'}`)
                    }
                    if (w.within != null && w.between != null) {
                        err(`${path}.metric.window`, '`within` bounds the far side of a before/after window; `between` already has two bounds')
                    }
                    if (w.missing != null && !MISSING.includes(w.missing)) {
                        err(`${path}.metric.window.missing`, `one of ${MISSING.join(', ')} — "exclude" drops passports with no anchor, "only" returns just them (the never-reached-it comparison group)`)
                    }
                    for (const k of ['offset', 'within']) {
                        if (w[k] != null && !OFFSET.test(String(w[k]))) err(`${path}.metric.window.${k}`, `bad offset ${JSON.stringify(w[k])} — use 7d, -7d, 24h or 2w`)
                    }
                    const anchors = w.between != null ? (Array.isArray(w.between) ? w.between : [w.between]) : [w.before ?? w.after]
                    if (w.between != null && (!Array.isArray(w.between) || w.between.length !== 2)) {
                        err(`${path}.metric.window.between`, 'takes exactly two anchors: [{ fact: … }, { fact: … }]')
                    }
                    anchors.forEach((a, i) => {
                        const at = `${path}.metric.window.${w.between != null ? `between[${i}]` : (w.before != null ? 'before' : 'after')}`
                        if (!a || typeof a !== 'object' || Array.isArray(a)) return err(at, "must be { fact: '<key>' }")
                        if (!a.fact || typeof a.fact !== 'string') err(at, 'needs `fact` — the key whose VALUE is the boundary (not its observed_at)')
                        if (a.use != null && !ANCHOR_USE.includes(a.use)) err(`${at}.use`, `one of ${ANCHOR_USE.join(', ')}`)
                        for (const k of Object.keys(a)) if (!['fact', 'use'].includes(k)) err(at, `unknown key "${k}" — one of fact, use`)
                    })
                }
            }
            // Content by identity. A string is the DEPRECATED substring-on-content_id
            // form; an object names which handle it is.
            if (m.content != null && typeof m.content === 'object') {
                for (const k of Object.keys(m.content)) {
                    if (!['url', 'id', 'hash', 'prefix'].includes(k)) {
                        err(`${path}.metric.content`, `unknown key "${k}" — one of url, id, hash, prefix. Measurements like completion_pct are \`attrs\`, not content.`)
                    }
                }
            }
            if (m.last != null && !WINDOW.test(String(m.last))) err(`${path}.metric.last`, `bad window ${JSON.stringify(m.last)} — use 30d, 24h or 2w`)
            for (const [col, v] of Object.entries(m.session || {})) {
                if (!SESSION_COLS.includes(col)) err(`${path}.metric.session`, `unknown column "${col}" — one of ${SESSION_COLS.join(', ')}`)
                else walkCond(`${path}.metric.session.${col}`, v, 'a session filter')
            }
            for (const [k, v] of Object.entries(m.attrs || {})) walkCond(`${path}.metric.attrs.${k}`, v, 'an attr filter')
            return
        }

        err(path, `unknown clause "${key}" — one of all/any/not/fact/metric`)
    }

    if (filter != null) walk(filter, 'filter')
    return errors
}
