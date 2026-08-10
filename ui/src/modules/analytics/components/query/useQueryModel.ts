// The Query builder's whole form model — state + parse (query def → form) + build
// (form → query def) + validation + the schema-derived option lists. Returned as ONE
// reactive object so the kind field-editors can bind to model.x directly. The function
// bodies are unchanged from the original single-file component; they close over the
// refs below, so only the *access* (model.x in templates) moved out of the SFC.
import { ref, computed, reactive, watch } from 'vue'
import { KIND_HINTS } from './constants'
import { factKeyOptions } from '../../../../shared/query/constants'
import { coerceScalar, eventArr, newCondition as sharedNewCondition, buildClause, parseClause, parseFilter, buildFilter } from '../../../../shared/query/clause'

export interface QueryBuilderProps { widget: any; schema: any }

export function useQueryModel(props: QueryBuilderProps) {
  const title = ref('')
  const kind = ref('stat')
  const about = ref('')
  const combinator = ref<'all' | 'any'>('all')
  const conditions = ref<any[]>([])
  // Clauses the row builder cannot represent — nested all/any groups, a `not`
  // around one — held verbatim so build() can put them back. A query composed
  // through MCP can use the whole recursive filter DSL; this form is one
  // combinator over a flat list. Without this, editing the title of such a
  // query rebuilt its filter from the visible rows alone and the rest was gone.
  const unrepresented = ref<any[]>([])
  const judgeCriteria = ref('')
  const judgeConfidence = ref(0.7)
  const tsEvents = ref<string[]>([])   // timeseries: event action(s)
  const tsAgg = ref('count')
  const grain = ref('week')
  const breakdownDim = ref('')         // 'channel' | 'session:utm_*' | 'attr:event' | 'fact:<key>'
  const breakdownValues = ref<any[]>([]) // only for a fact dimension — picked from the fact's discovered values
  const breakdownMeasure = ref('people')
  const distSource = ref<'fact' | 'event'>('fact')   // distribution: bin a numeric fact, or an event's per-person count
  const distKey = ref('')              // the fact key or event action to bin
  const distBins = ref('')             // optional explicit bucket edges, comma-separated (else auto)
  const scatterX = ref('')             // scatter: numeric fact on the X axis
  const scatterY = ref('')             // scatter: numeric fact on the Y axis
  const scatterColor = ref('')         // scatter: optional categorical fact to colour dots by
  // compare (multi-series): split the base measure into several named series
  const compareOn = ref(false)
  const compareMode = ref<'split' | 'custom'>('split')
  const splitKey = ref('')             // fact key whose values become the series
  const splitVals = ref('')            // those values, comma-separated
  const customSeries = ref<any[]>([])  // [{ name, c }] — each series is a named cohort over the base
  const newSeries = () => ({ name: '', c: newCondition() })
  const stackMode = ref<'group' | 'stack' | 'pct'>('group')   // compare bars/area: grouped, stacked, or 100%
  const target = ref<number | null>(null)   // stat (KPI): an optional goal to show progress against
  const cohortEvent = ref('')          // cohort: the activity that defines a cohort (blank = any activity)
  const cohortGrain = ref('month')
  const cohortPeriods = ref(6)
  const question = ref('')
  const steps = ref<any[]>([])         // funnel stages, in order: { name, event }
  const newStep = () => ({ name: '', event: '' })

  // option lists from the discovered schema
  const factKeys = computed(() => factKeyOptions(props.schema))
  const eventOpts = computed(() => (props.schema?.events || []).map((e: string) => ({ label: e, value: e })))
  const campaignOpts = computed(() => (props.schema?.campaigns || []).map((c: string) => ({ label: c, value: c })))
  // Acquisition sources and channels — already in the discovered schema and
  // already offered as breakdown dimensions; the condition row could not filter
  // on either until now.
  const sourceOpts = computed(() => (props.schema?.sources || []).map((c: string) => ({ label: c, value: c })))
  const channelOpts = computed(() => (props.schema?.channels || []).map((c: string) => ({ label: c, value: c })))
  // The dimension is picked in two steps instead of one long prefixed list:
  // first the KIND ("Fact", "Event attribute", …), then — only for the two
  // kinds that have many members — WHICH key. breakdownDim stays the single
  // stored value ('fact:<key>' | 'attr:<key>' | 'channel' | 'session:utm_*'),
  // so nothing about the saved query shape changes; these are just two views
  // onto it. Kinds with no sub-choice resolve to breakdownDim immediately.
  const BREAKDOWN_SLICES = [
    { label: 'Fact', value: 'fact' },
    { label: 'Event attribute', value: 'attr' },
    { label: 'Event action', value: 'attr:event' },
    { label: 'Channel', value: 'channel' },
    { label: 'Acquisition source', value: 'session:utm_source' },
    { label: 'Campaign', value: 'session:utm_campaign' },
  ]
  // 'attr:event' is a leaf kind, so it must be matched before the 'attr:' prefix.
  const deriveSlice = (dim: string) =>
    !dim ? ''
      : dim === 'attr:event' ? 'attr:event'
        : dim.startsWith('fact:') ? 'fact'
          : dim.startsWith('attr:') ? 'attr'
            : dim
  const sliceRef = ref('')
  const attrSourceRef = ref('')   // event-attribute source filter; '' = don't narrow
  const breakdownSlices = computed(() => BREAKDOWN_SLICES)
  const breakdownSlice = computed({
    get: () => sliceRef.value,
    set: (v: string) => {
      sliceRef.value = v
      breakdownValues.value = []
      attrSourceRef.value = ''   // the source narrows the attribute list only; a new slice starts wide
      // leaf kinds ARE the dimension; the two-part kinds wait for a key
      breakdownDim.value = v === 'fact' || v === 'attr' ? '' : v
    },
  })
  const needsBreakdownKey = computed(() => sliceRef.value === 'fact' || sliceRef.value === 'attr')
  // Attributes aren't a designed vocabulary — they're whatever payload each
  // plugin attached to awareness.record() — so the flat list mixes a crm
  // `treatment` in with an engagement image `width`, and picking one means
  // scanning ~20 unrelated names. Narrowing by the collecting subsystem first
  // makes it a two-step choice over a list that's actually related.
  //
  // This is a PICKER filter only: the stored dimension stays `attr:<key>`, so
  // the query shape never sees the source and an existing widget round-trips
  // unchanged. One attribute can be written by several subsystems (`kind`
  // comes from conversions, crm AND engagement), so this narrows a list — it
  // doesn't partition one.
  const attrSources = computed(() => {
    const seen = new Set<string>()
    for (const a of props.schema?.attrKeys || []) {
      if (typeof a !== 'string') for (const p of a.plugins || []) seen.add(p)
    }
    // "All sources" isn't just a convenience: attributes from before the
    // provenance column existed have no plugin at all, and this is the only
    // way to reach them.
    return [{ label: 'All sources', value: '' }, ...[...seen].sort().map((s) => ({ label: s, value: s }))]
  })
  // Event attributes carry a provenance hint — which subsystem wrote the key
  // and how many distinct values it takes — because the key name alone doesn't
  // say whether it's a real dimension or incidental payload (`treatment` and
  // `width` look alike in a plain list). Facts get their discovered sample
  // values as the hint. Tolerates attrKeys still being a bare string[] — a
  // server running the pre-provenance schema, or a cached one.
  const attrKeyOpts = computed(() => (props.schema?.attrKeys || [])
    .filter((a: any) => !attrSourceRef.value
      || (typeof a !== 'string' && (a.plugins || []).includes(attrSourceRef.value)))
    .map((a: any) => {
      if (typeof a === 'string') return { label: a, value: a, hint: '' }
      const n = a.distinct
      // lead with the collecting subsystem — `source` is only a content label
      // the plugin chose ('text', 'booking'), which doesn't say who wrote it.
      const who = (a.plugins || []).length ? a.plugins.join(', ') : (a.sources || []).join(', ')
      return {
        label: a.key,
        value: a.key,
        hint: [who, n == null ? '' : `${n} value${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      }
    }))
  const factKeyOpts = computed(() => (props.schema?.factKeys || []).map((k: any) => ({
    label: k.key,
    value: k.key,
    hint: (k.sample || []).slice(0, 3).join(', '),
  })))
  const breakdownKeyOpts = computed(() =>
    sliceRef.value === 'fact' ? factKeyOpts.value
      : sliceRef.value === 'attr' ? attrKeyOpts.value
        : [])
  const breakdownKey = computed({
    get: () => {
      const p = sliceRef.value + ':'
      return breakdownDim.value.startsWith(p) ? breakdownDim.value.slice(p.length) : ''
    },
    set: (v: string) => { breakdownValues.value = []; breakdownDim.value = v ? sliceRef.value + ':' + v : '' },
  })
  // Defined after breakdownKey because narrowing the source has to drop a
  // chosen attribute the new source doesn't actually write — otherwise the
  // dimension stays set to a key that's no longer in the list below it, which
  // reads as the picker lying about what's selected.
  const attrSource = computed({
    get: () => attrSourceRef.value,
    set: (v: string) => {
      attrSourceRef.value = v
      if (breakdownKey.value && !attrKeyOpts.value.some((o) => o.value === breakdownKey.value)) breakdownKey.value = ''
    },
  })
  const needsAttrSource = computed(() => sliceRef.value === 'attr')
  const isFactDim = computed(() => breakdownDim.value.startsWith('fact:'))
  // the distinct values the server discovered for the chosen fact. `values` is
  // the COMPLETE set for a categorical key and empty for a high-cardinality one
  // (compose.js's discoverSchema); `sample` is the 8-value prompt illustration,
  // used only as the fallback so a high-cardinality fact still offers a few
  // choices rather than none. Either way, union in whatever the widget already
  // holds so a saved value outside the list still shows as selected rather
  // than silently disappearing when the widget is re-saved.
  const breakdownValueOpts = computed(() => {
    if (!isFactDim.value) return []
    const key = breakdownDim.value.slice(5)
    const k = (props.schema?.factKeys || []).find((f: any) => f.key === key)
    const known = k?.values?.length ? k.values : (k?.sample || [])
    const seen = [...known, ...breakdownValues.value].map((v: any) => String(v))
    return [...new Set(seen)].filter((v) => v !== '').sort().map((v) => ({ label: v, value: v }))
  })
  // donut + radar + pivot + heatmap share the breakdown builder (rows) — only the rendering differs.
  const isBreakdownLike = computed(() => ['breakdown', 'donut', 'radar', 'pivot', 'heatmap'].includes(kind.value))
  // per-kind wording for the shared breakdown UI (verb / the noun for one bucket)
  const bdVerb = computed(() => ({ donut: 'Slice by', radar: 'Axis by' }[kind.value] || 'Break down by'))
  const bdUnit = computed(() => ({ donut: 'slice', radar: 'axis' }[kind.value] || 'bar'))
  // distribution over a fact needs a NUMERIC fact; over an event it picks an event action.
  const numericFactKeys = computed(() => (props.schema?.factKeys || [])
    .filter((k: any) => (k.sample || []).length && k.sample.every((v: any) => v !== '' && v != null && !isNaN(Number(v))))
    .map((k: any) => ({ label: k.key, value: k.key })))
  const distKeyOpts = computed(() => (distSource.value === 'event' ? eventOpts.value : numericFactKeys.value))
  // compare (overlay several series) applies to shared-axis measures + the 2-D grids
  // (pivot/heatmap), where the compare series become the matrix columns
  const canCompare = computed(() => ['timeseries', 'breakdown', 'radar', 'stat', 'pivot', 'heatmap'].includes(kind.value))
  // stacking applies to bars (breakdown) and area (timeseries), not radar/stat
  const canStack = computed(() => compareOn.value && ['breakdown', 'timeseries'].includes(kind.value))
  const kindHint = computed(() => KIND_HINTS[kind.value] || '')

  // wraps the shared newCondition() so every existing zero-arg call site
  // still gets a fresh row defaulted to the first known fact key
  const newCondition = () => sharedNewCondition(factKeys.value[0]?.value || '')

  // ── dirtiness (regenerate the summary only when the query changed) ──────────────
  let originalQuery = ''
  const stableStr = (o: any): string =>
    o === null || typeof o !== 'object' ? JSON.stringify(o)
      : Array.isArray(o) ? '[' + o.map(stableStr).join(',') + ']'
        : '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStr(o[k])).join(',') + '}'
  // title isn't part of build()'s own query shape, but it's still a field this
  // editor can leave unsaved — dirtiness has to cover it too, not just the query.
  const withTitle = () => ({ title: title.value, query: build() })
  function captureOriginal() { originalQuery = stableStr(withTitle()) }
  function isDirty() { return stableStr(withTitle()) !== originalQuery }

  // ── parse: query def → form ────────────────────────────────────────────────────
  function parse(w: any) {
    title.value = w.title || ''
    kind.value = w.kind || 'stat'
    const q = w.query || {}
    // a custom-series compare stores the base measure inside each series' query — read
    // the kind fields from the first series' query (bq); read the compare config from q.
    const bq = (Array.isArray(q.series) && q.series[0]?.query) ? q.series[0].query : q
    about.value = bq.selector?.about || ''
    combinator.value = 'all'; conditions.value = []; unrepresented.value = []
    judgeCriteria.value = bq.selector?.judge?.criteria || ''
    judgeConfidence.value = bq.selector?.judge?.confidence ?? 0.7
    tsEvents.value = []; tsAgg.value = 'count'; grain.value = 'week'
    breakdownDim.value = ''; breakdownValues.value = []; breakdownMeasure.value = 'people'; sliceRef.value = ''; attrSourceRef.value = ''
    distSource.value = 'fact'; distKey.value = ''; distBins.value = ''
    scatterX.value = ''; scatterY.value = ''; scatterColor.value = ''
    compareOn.value = false; compareMode.value = 'split'; splitKey.value = ''; splitVals.value = ''; customSeries.value = []; stackMode.value = 'group'; target.value = null
    cohortEvent.value = ''; cohortGrain.value = 'month'; cohortPeriods.value = 6
    question.value = ''; steps.value = []

    if (kind.value === 'answer') question.value = bq.question || ''
    else if (kind.value === 'funnel' || kind.value === 'dropoff') {
      steps.value = (bq.funnel?.steps || []).map((s: any) => {
        const e = s.select?.filter?.metric?.attrs?.event
        return { name: s.name || '', event: typeof e === 'string' ? e : '' }
      })
    } else if (kind.value === 'timeseries') {
      const m = bq.selector?.filter?.metric || {}
      tsEvents.value = eventArr(m.attrs?.event); tsAgg.value = m.sum ? 'sum' : 'count'; grain.value = bq.group?.by || 'week'
    } else if (kind.value === 'distribution') {
      const dd = bq.distribution || {}
      distSource.value = dd.source === 'event' ? 'event' : 'fact'
      distKey.value = dd.key || ''
      distBins.value = Array.isArray(dd.bins) ? dd.bins.join(', ') : ''
    } else if (kind.value === 'scatter') {
      const sc = bq.scatter || {}
      scatterX.value = sc.x || ''; scatterY.value = sc.y || ''; scatterColor.value = sc.colorBy || ''
    } else if (kind.value === 'cohort') {
      const co = bq.cohort || {}
      cohortEvent.value = co.event || ''; cohortGrain.value = co.grain || 'month'; cohortPeriods.value = co.periods || 6
    } else if (isBreakdownLike.value) {
      if (bq.breakdownFact) { breakdownDim.value = 'fact:' + bq.breakdownFact.key; sliceRef.value = 'fact'; breakdownValues.value = (bq.breakdownFact.values || []).map((v: any) => String(v)) }
      else if (bq.group?.by) { breakdownDim.value = bq.group.by; sliceRef.value = deriveSlice(bq.group.by); breakdownMeasure.value = bq.selector?.filter?.metric?.distinct_passports ? 'people' : 'events' }
    } else {
      const parsed = parseFilter(bq.selector?.filter)
      combinator.value = parsed.combinator
      conditions.value = parsed.conditions
      unrepresented.value = parsed.unrepresented
    }

    // compare config (splitBy sugar, or explicit named series)
    if (q.splitBy?.key) {
      compareOn.value = true; compareMode.value = 'split'
      splitKey.value = q.splitBy.key; splitVals.value = (q.splitBy.values || []).join(', ')
    } else if (Array.isArray(q.series) && q.series.length) {
      compareOn.value = true; compareMode.value = 'custom'
      customSeries.value = q.series.map((s: any) => ({ name: s.name || '', c: parseClause(s.query?.scope?.filter) || newCondition() }))
    }
    stackMode.value = q.stack || 'group'
    target.value = typeof bq.target === 'number' ? bq.target : null
    captureOriginal()
  }

  function reset() {
    title.value = ''; kind.value = 'stat'; about.value = ''
    combinator.value = 'all'; conditions.value = []; unrepresented.value = []; judgeCriteria.value = ''; judgeConfidence.value = 0.7
    tsEvents.value = []; tsAgg.value = 'count'; grain.value = 'week'
    breakdownDim.value = ''; breakdownValues.value = []; breakdownMeasure.value = 'people'; sliceRef.value = ''; attrSourceRef.value = ''
    distSource.value = 'fact'; distKey.value = ''; distBins.value = ''
    scatterX.value = ''; scatterY.value = ''; scatterColor.value = ''
    compareOn.value = false; compareMode.value = 'split'; splitKey.value = ''; splitVals.value = ''; customSeries.value = []; stackMode.value = 'group'; target.value = null
    cohortEvent.value = ''; cohortGrain.value = 'month'; cohortPeriods.value = 6
    question.value = ''; steps.value = []
    captureOriginal()
  }
  function addSeries() { customSeries.value.push(newSeries()) }
  function removeSeries(i: number) { customSeries.value.splice(i, 1) }

  // ── build: form → query def ────────────────────────────────────────────────────
  function eventClause(events: string[]) { return events.length === 1 ? events[0] : { in: events } }

  // buildFilter, plus the clauses the row builder could not show, put back
  // under the combinator they arrived under. Editing a title on an MCP-composed
  // query must not amputate the half of its filter this form cannot draw.
  //
  // The combinator toggle is disabled while these exist (QueryEditor), because
  // moving hidden clauses from `all` to `any` would silently rewrite a query
  // the user cannot see — the one edit here that is worse than refusing.
  function buildFilterPreserving(): any {
    const built = buildFilter(combinator.value, conditions.value)
    if (!unrepresented.value.length) return built
    const visible = built ? (built[combinator.value] ?? [built]) : []
    return { [combinator.value]: [...visible, ...unrepresented.value] }
  }

  function buildBase(): any {
    if (kind.value === 'answer') return { question: question.value }
    if (kind.value === 'cohort') return { cohort: { ...(cohortEvent.value ? { event: cohortEvent.value } : {}), grain: cohortGrain.value, periods: Number(cohortPeriods.value) || 6 } }
    if (kind.value === 'distribution') {
      const d: any = { source: distSource.value, key: distKey.value }
      const edges = distBins.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
      if (edges.length >= 2) d.bins = edges.sort((a, b) => a - b)
      return { distribution: d }
    }
    if (kind.value === 'scatter') {
      const s: any = { x: scatterX.value, y: scatterY.value }
      if (scatterColor.value) s.colorBy = scatterColor.value
      return { scatter: s }
    }
    if (isBreakdownLike.value) {   // breakdown + donut: identical query, different chart
      if (isFactDim.value) {
        return { breakdownFact: { key: breakdownDim.value.slice(5), values: breakdownValues.value.map((s: any) => coerceScalar(String(s).trim())).filter((v: any) => v !== '') } }
      }
      const metric: any = breakdownMeasure.value === 'events' ? { count: {} } : { distinct_passports: {} }
      // session dimensions: restrict to known values so a null bucket doesn't dominate
      if (breakdownDim.value === 'session:utm_campaign') metric.session = { utm_campaign: props.schema?.campaigns || [] }
      else if (breakdownDim.value === 'session:utm_source') metric.session = { utm_source: props.schema?.sources || [] }
      return { selector: { filter: { metric } }, group: { by: breakdownDim.value } }
    }
    if (kind.value === 'timeseries') {
      const ev = tsEvents.value.length ? { attrs: { event: eventClause(tsEvents.value) } } : {}
      const agg = tsAgg.value === 'sum' ? { sum: { field: 'value' } } : { count: {} }
      return { selector: { filter: { metric: { ...ev, ...agg } } }, projection: 'knowledge', group: { by: grain.value } }
    }
    if (kind.value === 'funnel' || kind.value === 'dropoff') {
      return { funnel: { steps: steps.value.filter((s) => s.event).map((s) => ({
        ...(s.name.trim() ? { name: s.name.trim() } : {}),
        select: { filter: { metric: { attrs: { event: s.event }, count: { gte: 1 } } } },
      })) } }
    }
    // stat / table → people, full selector
    const filter = buildFilterPreserving()
    const selector: any = {}
    if (about.value.trim()) selector.about = about.value.trim()
    if (filter) selector.filter = filter
    if (judgeCriteria.value.trim()) selector.judge = { criteria: judgeCriteria.value.trim(), confidence: Number(judgeConfidence.value) || 0.7 }
    const out: any = { selector, projection: 'people' }
    if (kind.value === 'stat' && target.value) out.target = target.value   // KPI goal
    return out
  }

  // Wrap the base measure with a comparison when "Compare" is on: splitBy a fact's
  // values, or an explicit list of named cohort series (each = base + that scope).
  function build(): any {
    const base = buildBase()
    if (!canCompare.value || !compareOn.value) return base
    let out: any = base
    if (compareMode.value === 'split') {
      const values = splitVals.value.split(',').map((s) => coerceScalar(s.trim())).filter((v: any) => v !== '')
      if (splitKey.value && values.length) out = { ...base, splitBy: { key: splitKey.value, values } }
    } else {
      const valid = customSeries.value.filter((s) => (s.c.type === 'metric' ? (s.c.events.length || s.c.campaigns.length) : s.c.key))
      if (valid.length) out = { series: valid.map((s, i) => ({
        name: (s.name || '').trim() || `Series ${i + 1}`,
        query: { ...base, scope: { filter: buildClause(s.c) } },
      })) }
    }
    // stack mode is a presentation hint on bars/area comparisons
    if (out !== base && stackMode.value !== 'group' && ['breakdown', 'timeseries'].includes(kind.value)) out.stack = stackMode.value
    return out
  }

  function baseHasContent() {
    if (kind.value === 'answer') return !!question.value.trim()
    if (kind.value === 'cohort') return true   // a cohort over any activity is valid
    if (kind.value === 'distribution') return !!distKey.value
    if (kind.value === 'scatter') return !!scatterX.value && !!scatterY.value
    if (isBreakdownLike.value) return !!breakdownDim.value && (!isFactDim.value || !!breakdownValues.value.length)
    if (kind.value === 'timeseries') return tsEvents.value.length > 0
    if (kind.value === 'funnel' || kind.value === 'dropoff') return steps.value.some((s) => s.event)
    return !!about.value.trim() || !!judgeCriteria.value.trim() || conditions.value.some((c) => (c.type === 'metric' ? (c.events.length || c.campaigns.length) : c.key))
  }
  function compareHasContent() {
    return compareMode.value === 'split'
      ? (!!splitKey.value && !!splitVals.value.trim())
      : customSeries.value.some((s) => (s.c.type === 'metric' ? (s.c.events.length || s.c.campaigns.length) : s.c.key))
  }
  function hasContent() {
    if (canCompare.value && compareOn.value) {
      // a stat compare just counts people per series, so the base needs no measure; the others do
      return compareHasContent() && (kind.value === 'stat' || baseHasContent())
    }
    return baseHasContent()
  }
  function addStep() { steps.value.push(newStep()) }
  function removeStep(i: number) { steps.value.splice(i, 1) }

  watch(() => props.widget?.id, () => (props.widget ? parse(props.widget) : reset()), { immediate: true })

  // One reactive object: nested refs/computeds are auto-unwrapped on access (model.x),
  // so children bind v-model="model.x" and the writes flow back to the refs above.
  return reactive({
    // state
    title, kind, about, combinator, conditions, unrepresented, judgeCriteria, judgeConfidence,
    tsEvents, tsAgg, grain, breakdownDim, breakdownValues, breakdownMeasure,
    distSource, distKey, distBins, scatterX, scatterY, scatterColor,
    compareOn, compareMode, splitKey, splitVals, customSeries, stackMode, target,
    cohortEvent, cohortGrain, cohortPeriods, question, steps,
    // option lists / derived
    factKeys, eventOpts, campaignOpts, sourceOpts, channelOpts, breakdownValueOpts, numericFactKeys, distKeyOpts,
    breakdownSlices, breakdownSlice, breakdownKey, breakdownKeyOpts, needsBreakdownKey,
    attrSource, attrSources, needsAttrSource,
    isFactDim, isBreakdownLike, bdVerb, bdUnit, canCompare, canStack, kindHint,
    // actions
    parse, reset, build, hasContent, isDirty, captureOriginal,
    addStep, removeStep, addSeries, removeSeries,
  })
}

export type QueryModel = ReturnType<typeof useQueryModel>
