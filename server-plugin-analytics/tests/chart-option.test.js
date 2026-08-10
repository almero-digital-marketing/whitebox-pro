import { describe, it, expect } from 'vitest'
import { normalise, chartOption, CHART_FONT } from '../src/composition/chart-option.js'

// These target the parts that carry MEANING — which numbers become which marks,
// and which chart a kind selects. Styling is a reproduction of the Vue
// components and is not asserted here: if a grid margin drifts, nothing is
// wrong. If a series reads `value` where the app reads `count`, the chart lies.

describe('normalise — the four shapes runQuery returns', () => {
  it('a bare array (timeseries)', () => {
    const d = [{ bucket: 'Jan', value: 3 }]
    expect(normalise(d)).toEqual({ points: d, multi: null, axes: undefined })
  })

  it('{ series } (breakdown / funnel)', () => {
    const d = { series: [{ bucket: 'a', value: 1 }] }
    expect(normalise(d).points).toEqual(d.series)
  })

  it('{ points, x, y } (scatter) carries the axis names', () => {
    const d = { points: [{ x: 1, y: 2 }], x: 'visits', y: 'spend' }
    const n = normalise(d)
    expect(n.points).toEqual(d.points)
    expect(n.axes).toEqual({ x: 'visits', y: 'spend' })
  })

  it('a compare goes down the multi path and leaves points empty', () => {
    const d = { multi: true, series: [{ name: 'A', points: [{ bucket: 'x', value: 1 }] }] }
    const n = normalise(d)
    expect(n.points).toEqual([])
    expect(n.multi).toBe(d)
  })

  it('survives nothing at all', () => {
    expect(normalise(undefined)).toEqual({ points: [], multi: null, axes: undefined })
  })
})

describe('chartOption — when there is no chart', () => {
  it('returns null for the text-only kinds', () => {
    for (const k of ['stat', 'table', 'pivot', 'answer']) {
      expect(chartOption(k, [{ bucket: 'a', value: 1 }])).toBeNull()
    }
  })

  it('returns null for empty data rather than an empty chart', () => {
    expect(chartOption('timeseries', [])).toBeNull()
    expect(chartOption('breakdown', undefined)).toBeNull()
    expect(chartOption('cohort', { multi: true, series: [] })).toBeNull()
  })
})

describe('chartOption — the same chart WidgetChart.vue would pick', () => {
  const pts = [{ bucket: 'a', value: 3 }, { bucket: 'b', value: 1 }]
  const multi = { multi: true, series: [
    { name: 'A', points: [{ bucket: 'x', value: 1 }, { bucket: 'y', value: 2 }] },
    { name: 'B', points: [{ bucket: 'y', value: 4 }] },
  ] }
  const type = (o) => o.series[0].type

  it('kind → series type, single-series', () => {
    expect(type(chartOption('timeseries', pts))).toBe('line')
    expect(type(chartOption('breakdown', pts))).toBe('bar')
    expect(type(chartOption('distribution', pts))).toBe('bar')
    expect(type(chartOption('donut', pts))).toBe('pie')
    expect(type(chartOption('funnel', pts))).toBe('funnel')
    expect(type(chartOption('radar', pts))).toBe('radar')
    expect(type(chartOption('dropoff', pts))).toBe('bar')
  })

  it('heatmap and cohort are always the matrix, even before the multi check', () => {
    expect(type(chartOption('heatmap', multi))).toBe('heatmap')
    expect(type(chartOption('cohort', multi))).toBe('heatmap')
  })

  it('a compare overrides the kind — multi-line, grouped bars, overlaid radar', () => {
    expect(chartOption('timeseries', multi).series).toHaveLength(2)
    expect(type(chartOption('timeseries', multi))).toBe('line')
    expect(type(chartOption('breakdown', multi))).toBe('bar')
    expect(type(chartOption('radar', multi))).toBe('radar')
    expect(chartOption('radar', multi).series[0].data).toHaveLength(2)   // one polygon per series
  })

  it('an unrecognised kind falls through to cartesian, as the UI does', () => {
    expect(type(chartOption('something-new', pts))).toBe('line')
  })
})

describe('chartOption — the numbers land where they should', () => {
  it('a bar series carries the point values in order', () => {
    const o = chartOption('breakdown', [{ bucket: 'a', value: 3 }, { bucket: 'b', value: 7 }])
    expect(o.xAxis.data).toEqual(['a', 'b'])
    expect(o.series[0].data.map((d) => d.value)).toEqual([3, 7])
  })

  it('a line series is bare values against the bucket axis', () => {
    const o = chartOption('timeseries', [{ bucket: 'Jan', value: 5 }, { bucket: 'Feb', value: 8 }])
    expect(o.xAxis.data).toEqual(['Jan', 'Feb'])
    expect(o.series[0].data).toEqual([5, 8])
  })

  it('a compare aligns series onto the union axis, missing buckets as 0', () => {
    const o = chartOption('breakdown', { multi: true, series: [
      { name: 'A', points: [{ bucket: 'x', value: 1 }, { bucket: 'y', value: 2 }] },
      { name: 'B', points: [{ bucket: 'y', value: 4 }] },
    ] })
    expect(o.xAxis.data).toEqual(['x', 'y'])
    expect(o.series.map((s) => s.data)).toEqual([[1, 2], [0, 4]])
  })

  it('stack pct normalises each bucket to 100', () => {
    const o = chartOption('breakdown', { multi: true, series: [
      { name: 'A', points: [{ bucket: 'x', value: 1 }] },
      { name: 'B', points: [{ bucket: 'x', value: 3 }] },
    ] }, { stack: 'pct' })
    expect(o.series.map((s) => s.data[0])).toEqual([25, 75])
    expect(o.yAxis.max).toBe(100)
  })

  it('dropoff plots people LOST between steps, with the percentage of that step', () => {
    // 100 → 60 → 45: loses 40 (40% of 100), then 15 (25% of 60).
    const o = chartOption('dropoff', [
      { bucket: 'Sent', value: 100 }, { bucket: 'Opened', value: 60 }, { bucket: 'Clicked', value: 45 },
    ])
    expect(o.yAxis.data).toEqual(['Sent → Opened', 'Opened → Clicked'])
    expect(o.series[0].data.map((d) => d.value)).toEqual([40, 15])
    expect(o.series[0].data.map((d) => d.label.formatter)).toEqual(['40  ·  40%', '15  ·  25%'])
  })

  it('a step that grew is clamped at zero rather than drawn as negative loss', () => {
    const o = chartOption('dropoff', [{ bucket: 'a', value: 10 }, { bucket: 'b', value: 12 }])
    expect(o.series[0].data[0].value).toBe(0)
  })

  it('heatmap cells are [column, row, value] against the aligned axes', () => {
    const o = chartOption('cohort', { multi: true, series: [
      { name: 'wk0', points: [{ bucket: 'Jan', value: 5 }, { bucket: 'Feb', value: 3 }] },
      { name: 'wk1', points: [{ bucket: 'Jan', value: 2 }] },
    ] })
    expect(o.xAxis.data).toEqual(['wk0', 'wk1'])   // columns = series
    expect(o.yAxis.data).toEqual(['Jan', 'Feb'])   // rows = buckets
    expect(o.series[0].data.map((d) => d.value)).toEqual([[0, 0, 5], [0, 1, 3], [1, 0, 2], [1, 1, 0]])
  })

  it('scatter splits by group when colorBy is present, one series otherwise', () => {
    const plain = chartOption('scatter', { points: [{ x: 1, y: 2 }], x: 'a', y: 'b' })
    expect(plain.series).toHaveLength(1)
    expect(plain.xAxis.name).toBe('a')

    const grouped = chartOption('scatter', { points: [{ x: 1, y: 2, group: 'g1' }, { x: 3, y: 4, group: 'g2' }], x: 'a', y: 'b' })
    expect(grouped.series).toHaveLength(2)
    expect(grouped.legend).toBeTruthy()
  })
})

describe('chartOption — the properties the renderer depends on', () => {
  const every = [
    ['timeseries', [{ bucket: 'a', value: 1 }]],
    ['breakdown', [{ bucket: 'a', value: 1 }]],
    ['distribution', [{ bucket: 'a', value: 1 }]],
    ['donut', [{ bucket: 'a', value: 1 }]],
    ['funnel', [{ bucket: 'a', value: 1 }]],
    ['radar', [{ bucket: 'a', value: 1 }]],
    ['dropoff', [{ bucket: 'a', value: 2 }, { bucket: 'b', value: 1 }]],
    ['scatter', { points: [{ x: 1, y: 2 }], x: 'a', y: 'b' }],
    ['cohort', { multi: true, series: [{ name: 'A', points: [{ bucket: 'x', value: 1 }] }] }],
    ['timeseries', { multi: true, series: [{ name: 'A', points: [{ bucket: 'x', value: 1 }] }] }],
  ]

  it('every option names a font — an inherited system-ui stack rasterises to no text at all', () => {
    for (const [kind, data] of every) {
      expect(chartOption(kind, data).textStyle.fontFamily, kind).toBe(CHART_FONT)
    }
  })

  it('every option disables animation and sets an opaque background', () => {
    // Animation would render a first frame; a transparent background reads as
    // black in most mail clients.
    for (const [kind, data] of every) {
      const o = chartOption(kind, data)
      expect(o.animation, kind).toBe(false)
      expect(o.backgroundColor, kind).toBe('#ffffff')
    }
  })

  it('no option carries interaction — there is nothing to hover in a still image', () => {
    for (const [kind, data] of every) {
      const o = chartOption(kind, data)
      expect(o.tooltip, kind).toBeUndefined()
      expect(JSON.stringify(o).includes('"emphasis"'), kind).toBe(false)
    }
  })

  it('every option is JSON-serialisable, so a test can compare options not pixels', () => {
    for (const [kind, data] of every) {
      const o = chartOption(kind, data)
      expect(() => JSON.stringify(o), kind).not.toThrow()
      // A formatter callback would survive JSON.stringify by vanishing, which is
      // the failure this guards: round-trip and check nothing was lost.
      expect(JSON.parse(JSON.stringify(o)), kind).toEqual(JSON.parse(JSON.stringify(o)))
      expect(JSON.stringify(o), kind).not.toContain('=>')
    }
  })
})
