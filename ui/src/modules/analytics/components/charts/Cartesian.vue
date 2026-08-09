<script setup lang="ts">
// Cartesian — the single-series bar/line family: breakdown + distribution are categorical
// bars (distribution = a contiguous histogram of one variable, one colour), timeseries is
// a smooth line with a soft area fill.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme } from './theme'
const props = defineProps<{ kind: string; points: any[]; selectedIndex?: number | null }>()
const emit = defineEmits<{ select: [sel: any] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const isBar = computed(() => props.kind === 'breakdown' || props.kind === 'distribution')
const isDist = computed(() => props.kind === 'distribution')
// a bar → a segment. breakdown = the bucket value; distribution = the bin's numeric
// range (lo/hi carried on the point). timeseries (a line) isn't selectable.
function onClick(p: any) {
  if (p?.dataIndex == null) return
  const pt = props.points[p.dataIndex]
  if (props.kind === 'breakdown') emit('select', { kind: 'breakdown', bucket: p.name, index: p.dataIndex })
  else if (props.kind === 'distribution') emit('select', { kind: 'distribution', bucket: p.name, index: p.dataIndex, lo: pt?.lo, hi: pt?.hi, last: p.dataIndex === props.points.length - 1 })
}
const option = computed(() => {
  const cats = props.points.map((p) => p.bucket)
  // a breakdown/distribution shows EVERY bar's label; rotate when many/long so they
  // don't overlap (a line keeps auto-thinning its labels).
  const longest = Math.max(0, ...cats.map((c) => String(c).length))

  // …up to a point. `interval: 0` means "never thin these out", which is right for the
  // eight buckets a breakdown usually has and wrong the moment a real dimension is
  // plotted: gpoint's service mix is 50 categories with names like "Крака (м.) - бедра,
  // подбедрици". At that width the labels overlap into a smear at any rotation, and a
  // smear is worse than nothing — it costs a third of the chart's height and reads as
  // damage rather than as data.
  //
  // Past the threshold the axis labels come off entirely and the tooltip carries the
  // name. That is not a loss of information: `trigger: 'axis'` already shows the bucket
  // and its value on hover, so the name was always one pointer-move away — it was the
  // permanent, illegible copy that was redundant.
  //
  // Threshold on COUNT, not on total width: what breaks readability is bars becoming
  // narrower than their labels, which is a function of how many share the axis. 16 is
  // about where a 10px rotated label stops fitting a bar in a card-width chart.
  const DENSE = 16
  const dense = isBar.value && cats.length > DENSE
  const rotate = !dense && isBar.value && (cats.length > 5 || longest > 9) ? 30 : 0
  return {
  // dense reclaims the rotated-label gutter — the bars get the height instead.
  grid: { left: 40, right: 14, top: 16, bottom: dense ? 24 : rotate ? 50 : 30 },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: cats,
    axisLabel: {
      show: !dense,
      color: C.muted,
      fontSize: 10,
      interval: isBar.value ? 0 : 'auto',
      hideOverlap: !isBar.value,
      rotate,
    },
    axisTick: { show: !dense },
    axisLine: { lineStyle: { color: C.border } },
  },
  yAxis: {
    type: 'value',
    axisLabel: { color: C.muted, fontSize: 10 },
    splitLine: { lineStyle: { color: C.grid } },
  },
  color: PALETTE,
  series: [{
    type: isBar.value ? 'bar' : 'line',
    // breakdown: each category a palette color. distribution: one colour (a histogram of
    // one variable). line: a single accent color.
    data: isBar.value
      ? props.points.map((p, i) => ({ value: p.value, itemStyle: { color: isDist.value ? PALETTE[0] : PALETTE[i % PALETTE.length], borderRadius: [3, 3, 0, 0], opacity: props.selectedIndex == null || props.selectedIndex === i ? 1 : 0.18 } }))
      : props.points.map((p) => p.value),
    smooth: !isBar.value,
    showSymbol: props.points.length <= 40,   // markers visible so a lone point isn't an invisible (empty-looking) line
    symbolSize: 6,
    barWidth: isDist.value ? '96%' : '60%',   // contiguous bars → histogram
    lineStyle: isBar.value ? undefined : { color: PALETTE[0], width: 2 },
    itemStyle: isBar.value ? undefined : { color: PALETTE[0] },
    areaStyle: isBar.value ? undefined : { color: PALETTE[0], opacity: 0.12 },
  }],
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
