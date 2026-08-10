import { describe, it, expect } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { renderChart, renderOption, DEFAULT_WIDTH, DEFAULT_HEIGHT } from '../src/composition/chart-render.js'
import { chartOption, CHART_FONT } from '../src/composition/chart-option.js'

// One case per kind, shaped the way runQuery returns it.
const CASES = [
  ['timeseries', [{ bucket: 'Aug', value: 412 }, { bucket: 'Sep', value: 388 }, { bucket: 'Oct', value: 455 }]],
  ['breakdown', [{ bucket: 'Sofia', value: 812 }, { bucket: 'Plovdiv', value: 463 }]],
  ['distribution', [{ bucket: '0-2', value: 120 }, { bucket: '3-5', value: 210 }]],
  ['donut', [{ bucket: 'Web', value: 640 }, { bucket: 'Phone', value: 220 }]],
  ['funnel', [{ bucket: 'Sent', value: 1000 }, { bucket: 'Opened', value: 600 }, { bucket: 'Booked', value: 96 }]],
  ['dropoff', [{ bucket: 'Sent', value: 1000 }, { bucket: 'Opened', value: 600 }, { bucket: 'Booked', value: 96 }]],
  ['radar', [{ bucket: 'Mail', value: 70 }, { bucket: 'SMS', value: 45 }, { bucket: 'Web', value: 88 }]],
  ['scatter', { points: [{ x: 3, y: 120 }, { x: 8, y: 410 }], x: 'visits', y: 'spend' }],
  ['cohort', { multi: true, series: [
    { name: 'wk0', points: [{ bucket: 'Jan', value: 100 }, { bucket: 'Feb', value: 90 }] },
    { name: 'wk1', points: [{ bucket: 'Jan', value: 64 }] },
  ] }],
  ['timeseries·compare', { multi: true, series: [
    { name: 'Gold', points: [{ bucket: 'Jan', value: 40 }, { bucket: 'Feb', value: 52 }] },
    { name: 'Silver', points: [{ bucket: 'Jan', value: 88 }] },
  ] }],
]
const kindOf = (label) => label.split('·')[0]

// Cyrillic, an ampersand and a quote — gpoint's real category names are Bulgarian,
// and every one of these is a character that can break XML if it reaches an
// attribute or a text node unescaped.
const AWKWARD = [
  { bucket: 'Крака (м.) - бедра', value: 12 },
  { bucket: 'Fire & Ice', value: 8 },
  { bucket: 'O\'clock "special"', value: 5 },
  { bucket: '<script>', value: 3 },
]

describe('renderChart', () => {
  it('draws every kind', () => {
    for (const [label, data] of CASES) {
      const out = renderChart(kindOf(label), data)
      expect(out, label).toBeTruthy()
      expect(out.svg.startsWith('<svg'), label).toBe(true)
      expect(out.width, label).toBe(DEFAULT_WIDTH)
      expect(out.height, label).toBe(DEFAULT_HEIGHT)
    }
  })

  it('answers null where there is no chart, so a caller sends figures alone', () => {
    expect(renderChart('stat', [{ bucket: 'a', value: 1 }])).toBeNull()
    expect(renderChart('table', [{ bucket: 'a', value: 1 }])).toBeNull()
    expect(renderChart('timeseries', [])).toBeNull()
    expect(renderOption(null)).toBeNull()
  })

  it('honours an explicit size', () => {
    const out = renderChart('timeseries', CASES[0][1], { width: 900, height: 200 })
    expect(out.width).toBe(900)
    expect(out.svg).toContain('width="900"')
    expect(out.svg).toContain('height="200"')
  })

  it('actually plots the data rather than an empty frame', () => {
    // A chart that renders but draws nothing is the failure a byte-count test
    // misses: assert real marks, and that a value reached the axis.
    const { svg } = renderChart('breakdown', [{ bucket: 'Sofia', value: 812 }, { bucket: 'Plovdiv', value: 463 }])
    expect((svg.match(/<path\b/g) || []).length).toBeGreaterThan(4)
    expect(svg).toContain('Sofia')
    expect(svg).toContain('Plovdiv')
  })
})

describe('the output is strict XML', () => {
  // The property that matters most, and the one a browser will not tell you
  // about. A rasterizer is a strict parser: markup a browser silently repairs
  // becomes dropped text or a hard failure there. This caught a real bug — a
  // font stack quoted with double quotes closed ECharts' own style="…"
  // attribute, and the SVG still looked perfect in a browser.
  const parse = (svg, label) => {
    const errors = []
    const doc = new DOMParser({
      onError: (level, msg) => { if (level !== 'warning') errors.push(msg) },
    }).parseFromString(svg, 'text/xml')
    expect(errors, `${label}: ${errors.join('; ')}`).toEqual([])
    return doc
  }

  it('every kind parses with no errors', () => {
    for (const [label, data] of CASES) parse(renderChart(kindOf(label), data).svg, label)
  })

  it('survives Cyrillic, ampersands, quotes and angle brackets in labels', () => {
    for (const kind of ['breakdown', 'donut', 'funnel', 'radar']) {
      const { svg } = renderChart(kind, AWKWARD)
      parse(svg, kind)
      expect(svg, kind).not.toContain('<script>')   // escaped, not embedded
    }
  })

  it('the font stack never uses double quotes', () => {
    // The regression guard for the bug above: ECharts writes this into a
    // double-quoted attribute, so a double quote here truncates it.
    expect(CHART_FONT).not.toContain('"')
    expect(CHART_FONT).toContain('sans-serif')
    for (const [label, data] of CASES) {
      const o = chartOption(kindOf(label), data)
      expect(JSON.stringify(o.textStyle), label).not.toContain('\\"')
    }
  })
})
