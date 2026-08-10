import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'

// runQuery is the seam: the chart tools must reuse it, not query on their own,
// so a chart and the numbers beside it can never come from different reads.
// Stubbed here to return a known series, which also proves the data reaches the
// renderer rather than being re-fetched.
const runQuery = vi.fn()
const getWidget = vi.fn()

vi.mock('../src/composition/routes.js', () => ({
  runQuery: (...a) => runQuery(...a),
  enrichPeople: async (d) => d,
  composeReport: async () => ({}),
  widgetSummary: async () => ({}),
  compactForExplain: (k, d) => d,
  KINDS: new Set(['stat', 'timeseries', 'breakdown', 'donut', 'funnel', 'dropoff', 'radar', 'scatter', 'heatmap', 'cohort', 'distribution', 'table', 'pivot', 'answer']),
}))
vi.mock('../src/composition/store.js', () => ({
  getWidget: (...a) => getWidget(...a),
  listReports: async () => [], getReport: async () => null, addWidget: async () => ({}),
  updateWidget: async () => ({}), deleteWidget: async () => 0, deleteReport: async () => 0,
  createReport: async () => ({}), updateReport: async () => ({}), reorderWidgets: async () => {},
  personFacts: async () => ({}), personActivity: async () => [],
}))

const { registerMcp } = await import('../src/composition/mcp.js')

function makeMcp() {
  const tools = new Map()
  return { tool: (s) => tools.set(s.name, s), resource: () => {}, prompt: () => {}, tools }
}
function register() {
  const mcp = makeMcp()
  registerMcp({ mcp }, { selector: {}, awareness: {}, passports: {}, logger: { warn: () => {}, error: () => {} } })
  return mcp
}

const SERIES = [{ bucket: 'Aug', value: 412 }, { bucket: 'Sep', value: 388 }, { bucket: 'Oct', value: 455 }]

beforeEach(() => { runQuery.mockReset(); getWidget.mockReset() })

describe('the chart tools are registered alongside the resolves', () => {
  it('both exist and carry the read scope', () => {
    const mcp = register()
    for (const name of ['analytics_chart', 'analytics_widget_chart']) {
      expect(mcp.tools.has(name), name).toBe(true)
      expect(mcp.tools.get(name).scope, name).toBe('analytics:read')
    }
  })

  it('drawing is a READ — neither may be reachable with only analytics:read revoked', () => {
    // Guards the accident of pasting a chart tool in beside the writers: a
    // render persists nothing, and a read-only token must be able to look.
    const mcp = register()
    expect(mcp.tools.get('analytics_chart').scope).not.toBe('analytics:write')
  })
})

describe('analytics_chart', () => {
  it('returns the figures and the picture, in that order', async () => {
    runQuery.mockResolvedValue(SERIES)
    const mcp = register()
    const res = await mcp.tools.get('analytics_chart').handler({ query: { selector: {} }, kind: 'timeseries' })

    expect(res.content).toHaveLength(2)
    expect(res.content[0].type).toBe('text')
    expect(JSON.parse(res.content[0].text)).toEqual(SERIES)
    expect(res.content[1].type).toBe('image')
    expect(res.content[1].mimeType).toBe('image/png')
  })

  it('the image is a real PNG, not the SVG it was rasterised from', async () => {
    // An SVG image block was tried against a real client and stored as a file
    // rather than drawn. PNG is what renders.
    runQuery.mockResolvedValue(SERIES)
    const res = await register().tools.get('analytics_chart').handler({ query: {}, kind: 'timeseries' })
    const png = Buffer.from(res.content[1].data, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1200)   // 600 logical at 2x
  })

  it('sends the figures alone when the kind has no chart', async () => {
    runQuery.mockResolvedValue({ count: 153245 })
    const mcp = register()
    const res = await mcp.tools.get('analytics_chart').handler({ query: {}, kind: 'stat' })
    expect(res.content).toHaveLength(1)
    expect(res.content[0].type).toBe('text')
  })

  it('sends the figures alone when the query resolved empty', async () => {
    runQuery.mockResolvedValue([])
    const mcp = register()
    const res = await mcp.tools.get('analytics_chart').handler({ query: {}, kind: 'timeseries' })
    expect(res.content).toHaveLength(1)
  })

  it('reuses runQuery rather than reading on its own', async () => {
    runQuery.mockResolvedValue(SERIES)
    const mcp = register()
    await mcp.tools.get('analytics_chart').handler({ query: { selector: { filter: { fact: { a: { eq: 1 } } } } }, kind: 'timeseries' })
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(runQuery.mock.calls[0][1]).toEqual({ selector: { filter: { fact: { a: { eq: 1 } } } } })
  })

  it('accepts a query handed over as a JSON string, like the resolves do', async () => {
    // Some MCP clients serialise structured args; coerce() already handles it
    // for the other tools and must for these too, or a chart would silently be
    // drawn from an unfiltered resolve.
    runQuery.mockResolvedValue(SERIES)
    const mcp = register()
    await mcp.tools.get('analytics_chart').handler({ query: '{"selector":{"filter":{"fact":{"a":{"eq":1}}}}}', kind: 'timeseries' })
    expect(runQuery.mock.calls[0][1]).toEqual({ selector: { filter: { fact: { a: { eq: 1 } } } } })
  })

  it('honours an explicit size', async () => {
    runQuery.mockResolvedValue(SERIES)
    const mcp = register()
    const res = await mcp.tools.get('analytics_chart').handler({ query: {}, kind: 'timeseries', width: 900, height: 200 })
    const png = Buffer.from(res.content[1].data, 'base64')
    expect(png.readUInt32BE(16)).toBe(1800)   // 900 logical at 2x
  })
})

describe('analytics_widget_chart', () => {
  it('draws a saved widget with its own kind and stack', async () => {
    getWidget.mockResolvedValue({ id: 'w1', kind: 'breakdown', query: { selector: {}, stack: 'pct' } })
    runQuery.mockResolvedValue({ multi: true, series: [
      { name: 'A', points: [{ bucket: 'x', value: 1 }] },
      { name: 'B', points: [{ bucket: 'x', value: 3 }] },
    ] })
    const mcp = register()
    const res = await mcp.tools.get('analytics_widget_chart').handler({ id: 'w1' })

    expect(res.content[1].type).toBe('image')

    // The stored `stack: 'pct'` must reach the option builder, and the only
    // honest way to show that is against the tool's OWN output: rasterise the
    // same data both ways and check which one the tool produced. Asserting on a
    // chart the test renders itself would prove nothing about the tool.
    const { renderChart } = await import('../src/composition/chart-render.js')
    const data = { multi: true, series: [
      { name: 'A', points: [{ bucket: 'x', value: 1 }] },
      { name: 'B', points: [{ bucket: 'x', value: 3 }] },
    ] }
    const stacked = renderChart('breakdown', data, { stack: 'pct', png: true })
    const plain = renderChart('breakdown', data, { png: true })
    expect(stacked.png.equals(plain.png)).toBe(false)          // the two really differ
    const got = Buffer.from(res.content[1].data, 'base64')
    expect(got.equals(stacked.png)).toBe(true)                 // and the tool drew the stacked one
  })

  it('404s on an unknown widget rather than drawing an empty chart', async () => {
    getWidget.mockResolvedValue(null)
    const mcp = register()
    await expect(mcp.tools.get('analytics_widget_chart').handler({ id: 'nope' }))
      .rejects.toMatchObject({ status: 404 })
  })
})
