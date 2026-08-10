import { Resvg } from '@resvg/resvg-js'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { LineChart, BarChart, FunnelChart, PieChart, RadarChart, ScatterChart, HeatmapChart } from 'echarts/charts'
import { GridComponent, RadarComponent, LegendComponent, VisualMapComponent } from 'echarts/components'
import { chartOption } from './chart-option.js'

// An option → an SVG string. The second of the three layers: chart-option.js
// decides what the chart is, this draws it, and neither knows who is asking —
// an MCP result and a mailed report both arrive here.
//
// No browser, no canvas, no puppeteer. ECharts renders to SVG in-process, which
// is why this can sit in a request path at all.
//
// Registration mirrors ui BaseChart.vue, minus what a still image cannot use:
// the SVG renderer instead of canvas, and no TooltipComponent, because
// chart-option.js emits no tooltip. Registering by hand rather than importing
// all of `echarts` keeps the plugin from carrying every chart type it does not
// draw.
echarts.use([
    SVGRenderer,
    LineChart, BarChart, FunnelChart, PieChart, RadarChart, ScatterChart, HeatmapChart,
    GridComponent, RadarComponent, LegendComponent, VisualMapComponent,
])

// Rendered at 2x and declared at 1x, or the chart is soft on every retina
// screen and in every mail client that respects an img's width attribute.
export const DEFAULT_SCALE = 2

// 600 is the conventional mail content width and reads well in a chat client
// too; a chart is the same picture in both. Height is the shorter axis of a
// card in the app, which is what these options' margins were tuned against.
export const DEFAULT_WIDTH = 600
export const DEFAULT_HEIGHT = 320

// An ECharts instance holds native handles even in SSR mode, so it is disposed
// in a finally — a throwing option must not leak one per failed render.
export function renderOption(option, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
    if (!option) return null
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
    try {
        chart.setOption(option)
        return chart.renderToSVGString()
    } finally {
        chart.dispose()
    }
}

// The whole pipeline for a caller that has a widget's resolved data: pick the
// chart, draw it, or answer null when the kind has no chart (stat, table) or
// there is nothing in the data. Callers treat null as "send the figures alone"
// rather than as an error — a report with an empty widget should still send.
export function renderChart(kind, data, { width, height, stack, png = false, scale = DEFAULT_SCALE } = {}) {
    const option = chartOption(kind, data, { stack })
    if (!option) return null
    const svg = renderOption(option, { width, height })
    if (!svg) return null
    const out = { svg, width: width ?? DEFAULT_WIDTH, height: height ?? DEFAULT_HEIGHT }
    // The PNG is `scale` times those dimensions in pixels; the caller keeps
    // declaring the logical size, which is what makes it sharp rather than big.
    if (png) out.png = toPng(svg, { scale })
    return out
}

// SVG → PNG, because an SVG is not a picture everywhere it matters. Mail
// clients largely refuse to render one, and an MCP client may store it as a
// file rather than draw it — both leave the reader with an attachment instead
// of a chart.
//
// The PNG is rasterised FROM THE SVG this module already produced, never drawn
// by a second path. One geometry, one option, so the two formats cannot
// disagree about the same widget.
export function toPng(svg, { scale = DEFAULT_SCALE } = {}) {
    if (!svg) return null
    assertTextRenders()
    return new Resvg(svg, {
        font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
        fitTo: { mode: 'zoom', value: scale },
    }).render().asPng()
}

// Fonts are the failure this whole file has to survive, and they fail SILENTLY.
//
// resvg has no notion of `system-ui` and does not error when it resolves
// nothing — it simply draws no glyphs. The SVG looks perfect in a browser and
// the PNG comes back wordless: no axis labels, no funnel steps, no legend, and
// no error anywhere to say so. On a host with no font packages at all, every
// chart in every mailed report is a coloured shape with nothing written on it.
//
// So: prove it once, at the first PNG, by rasterising the same tiny SVG twice —
// once with a glyph, once empty. If a font was found the two differ; if none
// was, they are byte-identical, which is exactly the state worth refusing.
//
// The glyph is Cyrillic on purpose. gpoint's categories are Bulgarian, and a
// Latin-only fallback would pass a check written with "A" and then draw boxes
// for every real label.
let fontCheck = null

function assertTextRenders() {
    if (fontCheck === true) return
    if (fontCheck instanceof Error) throw fontCheck

    const probe = (label) => new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">` +
        `<rect width="120" height="40" fill="#fff"/>` +
        `<text x="6" y="26" font-family="DejaVu Sans, sans-serif" font-size="16" fill="#000">${label}</text></svg>`,
        { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } },
    ).render().asPng()

    if (probe('Крака').equals(probe(''))) {
        fontCheck = new Error(
            'chart-render: no usable font — rasterised charts would have no text at all. ' +
            'Install a Cyrillic-capable font on this host (Debian/Ubuntu: apt-get install fonts-dejavu-core).',
        )
        throw fontCheck
    }
    fontCheck = true
}

// Test affordance: the probe result is cached for the process, so a test that
// exercises the failure path has to be able to clear it.
export function __resetFontCheckForTests() { fontCheck = null }
