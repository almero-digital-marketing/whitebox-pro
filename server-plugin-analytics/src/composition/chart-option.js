// A widget's resolved data → an ECharts option, server-side.
//
//   normalise(data)             → { points, multi, axes }
//   chartOption(kind, data)     → an option, or null when there is nothing to draw
//
// Pure: no DOM, no database, no rendering. The caller turns the option into SVG
// or PNG (chart-render.js); this file only decides what the chart IS.
//
// A REPRODUCTION of ui/src/modules/analytics/components/charts/*, not a new
// design. Every option below is the same option the corresponding Vue component
// builds, so a chart in a mail or an MCP result reads as the same chart the app
// shows. Two deliberate differences, both because the output is a still image:
//
//   · No `tooltip`, `emphasis`, or selection dimming. There is nothing to hover
//     and nothing selected, so all of it would be dead weight in the option.
//   · Theme tokens are literals rather than CSS variables. getComputedStyle has
//     no meaning here.
//
// Where the UI relies on a tooltip to carry values — a bar or a line — this
// image carries none. That is a known gap, not an oversight: the MCP tools
// return the figures as a text block alongside the image, so the numbers are
// there. A mailed report has no such companion, and whether bars gain value
// labels is a decision for that step rather than a style change smuggled in
// here.

// The app's own tokens, taken from ui/src/style.css — NOT from charts/theme.ts,
// whose fallbacks have drifted to a different neutral family (zinc #71717a /
// #e4e4e7 / #f4f4f5 against slate #64748b / #e2e8f0 / #f1f5f9). Those fallbacks
// only fire when a CSS variable is missing, which never happens in the app, so
// the drift is invisible there and would have made every chart rendered here a
// slightly different grey.
const C = {
    muted: '#64748b',    // --p-text-muted-color
    border: '#e2e8f0',   // --p-content-border-color
    grid: '#f1f5f9',     // --p-surface-100
    panel: '#ffffff',    // --p-content-background
}
// PrimeVue's 500 ramp, in the order charts/theme.ts reads it.
const PALETTE = [
    '#6366f1', '#14b8a6', '#f97316', '#ec4899', '#a855f7',
    '#06b6d4', '#f59e0b', '#10b981', '#f43f5e', '#0ea5e9',
]
const LOSS = '#f43f5e'   // --p-rose-500, the drop-off bars

// Pinned rather than inherited. The app resolves --p-font-family to a system-ui
// stack, and a headless server has no such stack — a rasterizer handed
// `system-ui` finds nothing and drops the text silently. So the family is named
// here and must match a font the renderer actually loads.
const FONT = 'DejaVu Sans, sans-serif'

const at = (i) => PALETTE[i % PALETTE.length]

// Ported verbatim from charts/theme.ts — already DOM-free there.
const nfmt = (n) =>
    (Math.abs(n) >= 1000 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : String(n))

const legendBase = () =>
    ({ top: 0, type: 'scroll', icon: 'roundRect', itemHeight: 8, itemWidth: 12, itemGap: 14, textStyle: { color: C.muted, fontSize: 11 } })

// Align named series onto a shared bucket axis (union, first-appearance order;
// missing buckets → 0).
function alignSeries(ser) {
    const axis = []
    const seen = new Set()
    for (const s of ser) for (const p of s.points) if (!seen.has(p.bucket)) { seen.add(p.bucket); axis.push(p.bucket) }
    const series = ser.map((s) => {
        const m = new Map(s.points.map((p) => [p.bucket, p.value]))
        return { name: s.name, values: axis.map((b) => m.get(b) ?? 0) }
    })
    return { axis, series }
}

// runQuery's return shapes, flattened the way the UI flattens them (WidgetCard):
// timeseries gives a bare [{bucket,value}]; breakdown/funnel give { series:[…] };
// scatter gives { points:[{x,y,…}], x, y }; a compare gives { multi, series:[…] }.
//
// This is the one part that carries meaning rather than styling — it decides
// which numbers become which marks — so it is a literal port, not a rewrite.
export function normalise(data) {
    const d = data
    const multi = d?.multi ? d : null
    const points = multi ? []
        : Array.isArray(d) ? d
            : d?.points ? d.points
                : d?.series ? d.series
                    : []
    const axes = d?.x && d?.y ? { x: d.x, y: d.y } : undefined
    return { points, multi, axes }
}

const cartesian = (kind, points) => {
    const isBar = kind === 'breakdown' || kind === 'distribution'
    const isDist = kind === 'distribution'
    const cats = points.map((p) => p.bucket)
    const longest = Math.max(0, ...cats.map((c) => String(c).length))
    // Past ~16 categories the labels overlap into a smear at any rotation, so
    // they come off entirely and the bars get the height instead. The UI leans
    // on its tooltip for the names at that density; a still image cannot, which
    // is the sharpest instance of the gap noted at the top of this file.
    const DENSE = 16
    const dense = isBar && cats.length > DENSE
    const rotate = !dense && isBar && (cats.length > 5 || longest > 9) ? 30 : 0
    return {
        grid: { left: 40, right: 14, top: 16, bottom: dense ? 24 : rotate ? 50 : 30 },
        xAxis: {
            type: 'category',
            data: cats,
            axisLabel: { show: !dense, color: C.muted, fontSize: 10, interval: isBar ? 0 : 'auto', hideOverlap: !isBar, rotate },
            axisTick: { show: !dense },
            axisLine: { lineStyle: { color: C.border } },
        },
        yAxis: { type: 'value', axisLabel: { color: C.muted, fontSize: 10 }, splitLine: { lineStyle: { color: C.grid } } },
        color: PALETTE,
        series: [{
            type: isBar ? 'bar' : 'line',
            data: isBar
                ? points.map((p, i) => ({ value: p.value, itemStyle: { color: isDist ? PALETTE[0] : at(i), borderRadius: [3, 3, 0, 0] } }))
                : points.map((p) => p.value),
            smooth: !isBar,
            showSymbol: points.length <= 40,
            symbolSize: 6,
            barWidth: isDist ? '96%' : '60%',
            lineStyle: isBar ? undefined : { color: PALETTE[0], width: 2 },
            itemStyle: isBar ? undefined : { color: PALETTE[0] },
            areaStyle: isBar ? undefined : { color: PALETTE[0], opacity: 0.12 },
        }],
    }
}

const multiCartesian = (kind, multi, stack) => {
    const line = kind === 'timeseries'
    const pct = stack === 'pct'
    const stacked = stack === 'stack' || pct
    let { axis, series } = alignSeries(multi?.series || [])
    if (pct) {
        series = series.map((s) => ({ ...s, values: [...s.values] }))
        for (let i = 0; i < axis.length; i++) {
            const sum = series.reduce((a, s) => a + (s.values[i] || 0), 0) || 1
            series.forEach((s) => { s.values[i] = Math.round((s.values[i] / sum) * 1000) / 10 })
        }
    }
    const longest = Math.max(0, ...axis.map((a) => String(a).length))
    const rotate = !line && (axis.length > 5 || longest > 9) ? 30 : 0
    return {
        grid: { left: pct ? 46 : 44, right: 14, top: 30, bottom: rotate ? 54 : 30 },
        legend: legendBase(),
        xAxis: { type: 'category', data: axis, axisLabel: { color: C.muted, fontSize: 10, interval: line ? 'auto' : 0, hideOverlap: line, rotate }, axisLine: { lineStyle: { color: C.border } } },
        yAxis: { type: 'value', max: pct ? 100 : undefined, axisLabel: { color: C.muted, fontSize: 10, formatter: pct ? '{value}%' : undefined }, splitLine: { lineStyle: { color: C.grid } } },
        color: PALETTE,
        series: series.map((s, i) => (line ? {
            name: s.name, type: 'line', data: s.values, smooth: !stacked, showSymbol: !stacked && axis.length <= 40, symbolSize: 5,
            stack: stacked ? 'total' : undefined,
            lineStyle: { color: at(i), width: 2 }, itemStyle: { color: at(i) },
            areaStyle: stacked ? { color: at(i), opacity: 0.5 } : undefined,
        } : {
            name: s.name, type: 'bar', barMaxWidth: stacked ? 44 : 30,
            stack: stacked ? 'total' : undefined,
            itemStyle: { color: at(i), borderRadius: stacked ? 0 : [3, 3, 0, 0] },
            data: s.values,
        })),
    }
}

const donut = (points) => ({
    color: PALETTE,
    series: [{
        type: 'pie',
        radius: ['46%', '72%'], center: ['50%', '50%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: C.panel, borderWidth: 2 },
        label: { show: true, color: C.muted, fontSize: 11, formatter: '{b}  {d}%' },
        labelLine: { length: 10, length2: 8, lineStyle: { color: C.border } },
        data: points.map((p, i) => ({ name: p.bucket, value: p.value, itemStyle: { color: at(i) } })),
    }],
})

const funnel = (points) => ({
    color: PALETTE,
    series: [{
        type: 'funnel',
        top: 12, bottom: 12, left: '6%', width: '88%',
        sort: 'none', gap: 2, minSize: '24%',   // DEFINED step order: slice position == step index
        funnelAlign: 'center',
        label: { show: true, position: 'inside', color: '#fff', fontSize: 11, fontWeight: 600, formatter: '{b}\n{c}' },
        labelLine: { show: false },
        itemStyle: { borderColor: C.panel, borderWidth: 2 },
        data: points.map((p, i) => ({ name: p.bucket, value: p.value, itemStyle: { color: at(i) } })),
    }],
})

const dropoff = (points) => {
    const pts = points || []
    const rows = []
    for (let i = 0; i < pts.length - 1; i++) {
        const from = pts[i].value || 0
        const lost = Math.max(0, from - (pts[i + 1].value || 0))
        rows.push({ label: `${pts[i].bucket} → ${pts[i + 1].bucket}`, lost, pct: from ? Math.round((lost / from) * 100) : 0 })
    }
    return {
        grid: { left: 8, right: 64, top: 8, bottom: 8, containLabel: true },
        xAxis: { type: 'value', axisLabel: { color: C.muted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
        yAxis: {
            type: 'category', inverse: true, data: rows.map((r) => r.label),
            axisLabel: { color: C.muted, fontSize: 11 }, axisLine: { lineStyle: { color: C.border } }, axisTick: { show: false },
        },
        series: [{
            type: 'bar', barWidth: '54%',
            label: { show: true, position: 'right', fontSize: 11, fontWeight: 600, color: C.muted },
            // The per-item label text is a literal rather than a formatter
            // function, so the whole option stays JSON-serialisable — which is
            // what lets a test compare options instead of pixels.
            data: rows.map((r) => ({
                value: r.lost,
                itemStyle: { color: LOSS, borderRadius: [0, 4, 4, 0] },
                label: { formatter: `${r.lost.toLocaleString()}  ·  ${r.pct}%` },
            })),
        }],
    }
}

const heatmap = (multi) => {
    const { axis, series } = alignSeries(multi?.series || [])   // axis = rows, series = columns
    const rows = axis
    const cols = series.map((s) => s.name)
    const pct = multi?.unit === '%'
    const data = []
    let maxV = 0
    series.forEach((s, ci) => s.values.forEach((v, ri) => { data.push([ci, ri, v]); if (v > maxV) maxV = v }))
    const mid = pct ? 50 : Math.max(1, maxV) * 0.5
    return {
        grid: { left: 76, right: 12, top: 10, bottom: 30, containLabel: false },
        xAxis: { type: 'category', data: cols, axisLabel: { color: C.muted, fontSize: 10, hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false } },
        yAxis: { type: 'category', data: rows, inverse: true, axisLabel: { color: C.muted, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
        visualMap: { show: false, min: 0, max: pct ? 100 : Math.max(1, maxV), inRange: { color: [C.grid, PALETTE[0]] } },
        series: [{
            type: 'heatmap',
            // Cell colour comes from visualMap, so only the label colour needs
            // to know about contrast. Resolved per cell here rather than by a
            // formatter callback, keeping the option serialisable.
            data: data.map(([ci, ri, v]) => ({
                value: [ci, ri, v],
                label: { formatter: `${v}${pct ? '%' : ''}`, color: v >= mid ? '#fff' : C.muted },
            })),
            label: { show: rows.length * cols.length <= 70, fontSize: 10 },
            itemStyle: { borderColor: C.panel, borderWidth: 2, borderRadius: 3 },
        }],
    }
}

const radar = (points) => {
    const vals = points.map((p) => p.value)
    const max = Math.max(...vals, 1)
    return {
        radar: {
            indicator: points.map((p) => ({ name: p.bucket, max })),
            center: ['50%', '55%'], radius: '64%', splitNumber: 4,
            axisName: { color: C.muted, fontSize: 11 },
            splitLine: { lineStyle: { color: C.grid } },
            splitArea: { show: false },
            axisLine: { lineStyle: { color: C.grid } },
        },
        series: [{
            type: 'radar', symbolSize: 4,
            data: [{ value: vals, lineStyle: { color: PALETTE[0], width: 2 }, itemStyle: { color: PALETTE[0] }, areaStyle: { color: PALETTE[0], opacity: 0.18 } }],
        }],
    }
}

const multiRadar = (multi) => {
    const { axis, series } = alignSeries(multi?.series || [])
    const max = Math.max(1, ...series.flatMap((s) => s.values))
    return {
        legend: legendBase(),
        radar: {
            indicator: axis.map((name) => ({ name, max })),
            center: ['50%', '56%'], radius: '60%', splitNumber: 4,
            axisName: { color: C.muted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } },
            splitArea: { show: false }, axisLine: { lineStyle: { color: C.grid } },
        },
        series: [{
            type: 'radar', symbolSize: 4,
            data: series.map((s, i) => ({
                name: s.name, value: s.values,
                lineStyle: { color: at(i), width: 2 }, itemStyle: { color: at(i) }, areaStyle: { color: at(i), opacity: 0.1 },
            })),
        }],
    }
}

const scatter = (points, axes) => {
    const xName = axes?.x || 'x'
    const yName = axes?.y || 'y'
    const hasGroups = points.some((p) => p.group != null)
    const dot = (p) => ({ value: [p.x, p.y], id: p.id })
    const series = hasGroups
        ? [...new Set(points.map((p) => p.group ?? '—'))].map((g, i) => ({
            name: String(g), type: 'scatter', symbolSize: 8,
            itemStyle: { color: at(i), opacity: 0.75 },
            data: points.filter((p) => (p.group ?? '—') === g).map(dot),
        }))
        : [{ type: 'scatter', symbolSize: 8, itemStyle: { color: PALETTE[0], opacity: 0.7 }, data: points.map(dot) }]
    return {
        grid: { left: 52, right: 16, top: hasGroups ? 28 : 14, bottom: 38 },
        legend: hasGroups ? { top: 0, icon: 'circle', itemHeight: 8, itemWidth: 8, textStyle: { color: C.muted, fontSize: 11 } } : undefined,
        xAxis: {
            type: 'value', name: xName, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.muted, fontSize: 11 },
            axisLabel: { color: C.muted, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } }, splitLine: { lineStyle: { color: C.grid } },
        },
        yAxis: {
            type: 'value', name: yName, nameLocation: 'middle', nameGap: 38, nameTextStyle: { color: C.muted, fontSize: 11 },
            axisLabel: { color: C.muted, fontSize: 10 }, splitLine: { lineStyle: { color: C.grid } },
        },
        series,
    }
}

// Kinds with no chart at all. `stat` is one number, `table` and `pivot` read
// fine as text, and `answer` is prose — an image of any of them is worse than
// the text the caller already has.
const TEXT_ONLY = new Set(['stat', 'table', 'pivot', 'answer'])

// The same selection WidgetChart.vue makes, in the same order: a heatmap/cohort
// is always a matrix, a compare result overrides the kind, and everything
// unrecognised falls through to cartesian.
export function chartOption(kind, data, { stack } = {}) {
    if (TEXT_ONLY.has(kind)) return null
    const { points, multi, axes } = normalise(data)
    if (!points.length && !multi?.series?.length) return null

    const option = (() => {
        if (kind === 'heatmap' || kind === 'cohort') return heatmap(multi)
        if (multi?.series?.length) return kind === 'radar' ? multiRadar(multi) : multiCartesian(kind, multi, stack)
        if (kind === 'dropoff') return dropoff(points)
        if (kind === 'funnel') return funnel(points)
        if (kind === 'donut') return donut(points)
        if (kind === 'radar') return radar(points)
        if (kind === 'scatter') return scatter(points, axes)
        return cartesian(kind, points)
    })()

    // One place to set the family, so no per-kind option can forget it and
    // silently rasterise without text.
    return { ...option, textStyle: { fontFamily: FONT }, animation: false, backgroundColor: C.panel }
}

export { C as CHART_TOKENS, PALETTE as CHART_PALETTE, FONT as CHART_FONT, nfmt, alignSeries }
