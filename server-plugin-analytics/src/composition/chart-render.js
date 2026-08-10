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
export function renderChart(kind, data, { width, height, stack } = {}) {
    const option = chartOption(kind, data, { stack })
    if (!option) return null
    const svg = renderOption(option, { width, height })
    return svg && { svg, width: width ?? DEFAULT_WIDTH, height: height ?? DEFAULT_HEIGHT }
}
