/**
 * 峰谷时段条「动态」样式:按需加载分块(启动包经 require.async('./client.peak.js')
 * 取回 `mount()`,由 ui-peak.ts 的 PeakLazy 挂载)。
 *
 * 主包贴着 256 KiB 单文件上限,而这段渲染逻辑还要自带样式表;整体搬进本分块后
 * 主包零增量,只有把「峰谷时段条样式」切到「动态」时才会加载一次。分块自带样式
 * 注入,并按 config + now 自算相位/时轴/文案,只依赖主包传入的本地化函数。
 *
 * 时轴 = 该时刻所在北京日(00:00–24:00,与 DeepSeek 计价窗口同一时区);
 * 分段按各段真实时长取宽度(默认 00-09 谷蓝、09-12 峰橙、12-14 谷蓝、14-18 峰橙、
 * 18-24 谷蓝);刻度胶囊取反色——亮色主题用暗色、暗色主题用亮色,靠宿主 Web UI
 * 打在 body 上的 data-ds-dark-theme 标记翻转,不自行探测明暗主题。
 *
 * 迁移自旧 `src/peak/index.js`(逐字对照,行为/文案不变);旧文件的
 * `window.__ModuleLoader__.load({ chunk: 'client.peak.js', factory })` 外壳已由
 * scripts/build.mjs 统一套上(esbuild cjs + banner/footer),故这里只写普通 ESM。
 * 倒计时与相位标签键改用 peak-core 的同口径实现(旧分块当时无法 import 主包)。
 *
 * 分块不得 import 其它分块入口(index.ts / settings.ts / statistics.ts / openrouter.ts)。
 *
 * TODO(types): 组件 props(config/t/rail/now)属宿主边界,暂用 any;后续可用
 * peak-core 的 PeakConfigLike / PeakTranslate 逐步收紧。
 */
// 平台种子:react 由宿主注入(seeds.d.ts 提供类型)。
import React from 'react'
import { countdownText, phaseLabelKeys } from './peak-core.js'
import type { PeakPhase } from './peak-core.js'

const { createElement: el, useEffect, useState } = React

// TODO(types): 峰谷配置子集暂用 any(与 peak-core.PeakConfigLike 同形)。
type ChunkConfig = any
type ChunkT = (key: string, params?: Record<string, unknown>) => string

// 与其它分块同口径的样式注入:按内容比对,兼容 HMR 换代码后复用旧节点。
const CSS_ID = 'dsh-cost-meter-peak-style'
const css = [
  // 轨道高度对齐「简洁」样式(6px),只用一层 --cm-pkw-* 变量承载明暗两套取值。
  '.cm-pkw-track{--cm-pkw-rim:var(--dsw-alias-brand-primary);position:relative;display:flex;flex:1;height:6px;min-width:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);box-sizing:border-box}',
  '.cm-pkw-seg{flex:none;overflow:hidden}',
  '.cm-pkw-seg.peak{background:#ff9800}',
  '.cm-pkw-seg.off{background:var(--dsw-alias-state-business-primary)}',
  // 刻度滑块:空心胶囊——不填充,只留醒目描边(亮色主题近黑、暗色主题近白),
  // 宽度窄、长度略高于轨道,像滑块轮廓一样扣在分色带上;宽度固定,不改分段比例。
  '.cm-pkw-cap{position:absolute;top:50%;width:4px;height:calc(100% + 7px);min-height:13px;border-radius:999px;border:1.5px solid var(--cm-pkw-rim);box-sizing:border-box;transform:translate(-50%,-50%);transition:left .4s ease;z-index:2;pointer-events:none}',
  // 周末/法定假日全天谷价:整条淡显(颜色仍是同一套橙/蓝),文案照常。
  '.cm-peak-strip.weekend .cm-pkw-seg,.cm-peak-rail.wiper.weekend .cm-pkw-rail-seg{opacity:.35}',
  // 窄栏(rail)态:沿用主包 .cm-peak-rail 的外框,只补竖排分段与滑块(比例同宽栏)。
  '.cm-peak-rail.wiper .cm-peak-rail-track{--cm-pkw-rim:var(--dsw-alias-brand-primary);position:relative;display:flex;flex-direction:column;flex:none;width:6px;height:56px;border-radius:999px;overflow:visible;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);box-sizing:border-box}',
  '.cm-peak-rail.wiper .cm-pkw-rail-seg{flex:none;width:100%;min-height:0}',
  '.cm-peak-rail.wiper .cm-pkw-rail-seg.peak{background:#ff9800}',
  '.cm-peak-rail.wiper .cm-pkw-rail-seg.off{background:var(--dsw-alias-state-business-primary)}',
  '.cm-peak-rail.wiper .cm-pkw-rail-cap{position:absolute;left:50%;height:4px;width:calc(100% + 8px);min-width:13px;border-radius:999px;border:1.5px solid var(--cm-pkw-rim);box-sizing:border-box;transform:translate(-50%,-50%);transition:top .4s ease;z-index:2;pointer-events:none}',
].join('\n')

function ensureCss() {
  const current = document.querySelector<HTMLStyleElement>('style[data-plugin-css="' + CSS_ID + '"]')
  if (current !== null && current.textContent === css) return
  const node = current ?? document.createElement('style')
  node.dataset.pluginCss = CSS_ID
  node.textContent = css
  if (current === null && document.head !== null) document.head.appendChild(node)
}

/** 官方峰谷窗口(UTC 小时,半开区间 [start, end)):与 lib/pricing.js 同值。 */
const DEFAULT_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }]

// 周末/法定假日全谷价规则:与 lib/pricing.js 的 weekendZoneAt / holidayZoneAt 同口径
// (北京日历日、日界 UTC+8;bundle 无法导入,修改时两处需同步)。
const WEEKEND_AT = Date.parse('2026-08-22T16:00:00Z')
const DEFAULT_HOLIDAYS = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']

/** 北京日历日索引(日界 UTC+8):1970-01-01 为周四,故 (day + 4) % 7 为星期。 */
const bjDayIndex = (atMs: number) => Math.floor((atMs + 8 * 3600000) / 86400000)

/** 公众假期(北京日历日)判定:名单可按配置覆盖。 */
function holidayAt(atMs: number, holidays: any): boolean {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_AT) return false
  const key = new Date(bjDayIndex(atMs) * 86400000).toISOString().slice(0, 10)
  return (Array.isArray(holidays) ? holidays : DEFAULT_HOLIDAYS).includes(key)
}

/** 周末(北京周六/周日)判定。 */
const weekendAt = (atMs: number) => Number.isFinite(atMs) && atMs >= WEEKEND_AT && [0, 6].includes((bjDayIndex(atMs) + 4) % 7)

/**
 * 当前相位:周末或法定假日全天谷价;否则按峰窗(UTC 小时)判定,并给出下一次
 * 相位切换时刻与切换方向,供倒计时使用。
 */
export function phaseOf(config: ChunkConfig, now: number): PeakPhase {
  const windows: number[][] = (Array.isArray(config?.peakWindows) && config.peakWindows.length > 0 ? config.peakWindows : DEFAULT_WINDOWS)
    .map((w: any) => [Number(w?.start), Number(w?.end)])
    .filter(([s, e]: number[]) => Number.isFinite(s) && Number.isFinite(e))
  if (windows.length === 0) return { inPeak: false, weekend: false, prevAtMs: now, nextAtMs: now, nextIntoPeak: false }
  const effectiveAtMs = Date.parse(config?.peakEffectiveAt ?? '')
  const offDay = holidayAt(now, config?.peakHolidays) ? 'holiday' : weekendAt(now) ? 'weekend' : null
  const hour = new Date(now).getUTCHours()
  const starts: number[] = []
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
  for (let day = -1; day <= 1; day += 1) {
    for (const [s, e] of windows) {
      starts.push(dayStart + day * 86400000 + s * 3600000)
      starts.push(dayStart + day * 86400000 + (e <= s ? e + 24 : e) * 3600000)
    }
  }
  starts.sort((a, b) => a - b)
  let prev = now
  let next = now
  for (const at of starts) {
    if (at <= now) prev = at
    if (at > now && (next === now || at < next)) next = at
  }
  const enabled = !(Number.isFinite(effectiveAtMs) && now < effectiveAtMs)
  const inPeak = enabled && offDay === null
    && windows.some(([s, e]) => (s < e ? hour >= s && hour < e : hour >= s || hour < e))
  return {
    inPeak,
    weekend: offDay === 'weekend',
    holiday: offDay === 'holiday',
    prevAtMs: prev,
    nextAtMs: next,
    nextIntoPeak: !inPeak,
  }
}

/** 把配置窗口折算成北京日内的分段(起止小时 + 相位),相邻同相位段合并。 */
export function bandsOf(windows: any) {
  const list = (Array.isArray(windows) && windows.length > 0 ? windows : DEFAULT_WINDOWS)
    .filter((w: any) => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)))
  const bounds = [0, 24]
  const peaks: number[][] = []
  for (const w of list) {
    // 窗口是 UTC 小时:加 8 小时即北京日内刻度,跨午夜自动拆成尾段与首段。
    const s = (((Number(w.start) + 8) % 24) + 24) % 24
    const e = (((Number(w.end) + 8) % 24) + 24) % 24
    if (s === e) continue
    for (const span of e > s ? [[s, e]] : [[s, 24], [0, e]]) {
      peaks.push(span)
      bounds.push(span[0], span[1])
    }
  }
  bounds.sort((a, b) => a - b)
  const bands: Array<{ start: number; end: number; peak: boolean }> = []
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end - start < 1e-9) continue
    const mid = (start + end) / 2
    const peak = peaks.some(p => mid > p[0] && mid < p[1])
    const last = bands[bands.length - 1]
    if (last !== undefined && last.peak === peak) last.end = end
    else bands.push({ start, end, peak })
  }
  return bands.length > 0 ? bands : [{ start: 0, end: 24, peak: false }]
}

/**
 * 时间轴数据:now 所在北京日的已过比例 br(刻度位置)、当前段序号 i 与
 * 相位类名 key(peak / off / weekend)。分段来自配置窗口,故与计价同源。
 */
export function axisOf(config: ChunkConfig, now: number, phase: PeakPhase | null) {
  const bands = bandsOf(config?.peakWindows)
  const at = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  const hour = (now - at) / 3600000
  let i = 0
  for (let n = 0; n < bands.length; n += 1) if (hour >= bands[n].start) i = n
  const offDay = phase !== null && (phase.weekend === true || phase.holiday === true)
  return { bands, i, br: Math.min(100, Math.max(0, hour / 24 * 100)), key: offDay ? 'weekend' : phase !== null && phase.inPeak === true ? 'peak' : 'off' }
}

// TODO(types): 分块内部组件 props 属边界,暂用 any。
/** 分段轨道:宽栏水平 / 窄栏竖向同构;够宽的段内嵌起止时刻。 */
function Track(props: any) {
  const { axis, rail } = props
  const prefix = rail ? 'cm-pkw-rail' : 'cm-pkw'
  return el('div', { className: rail ? 'cm-peak-rail-track' : 'cm-pkw-track' },
    axis.bands.map((band: any, i: number) => el('div', {
      key: 'band' + i,
      className: prefix + '-seg ' + (band.peak ? 'peak' : 'off'),
      style: rail ? { height: (band.end - band.start) / 24 * 100 + '%' } : { width: (band.end - band.start) / 24 * 100 + '%' },
    })),
    el('div', { className: prefix + '-cap', style: rail ? { top: axis.br + '%' } : { left: axis.br + '%' } }))
}

/** 小时刻度文案(整点省略 0 分):用于悬停说明里的区间起止。 */
const pkClock = (hours: number) => {
  const mm = Math.round((hours % 1) * 60)
  return Math.floor(hours) + (mm > 0 ? ':' + String(mm).padStart(2, '0') : ':00')
}

/**
 * 悬停说明:完整峰谷区间(逐段起止 + 相位,即官方时段占比的来源)+ 当前相位
 * 说明 + 倒计时;分段由配置窗口折算,与计价同源。
 */
function hoverText(t: ChunkT, axis: any, phase: PeakPhase | null, left: string): string {
  const offDay = phase !== null && (phase.weekend === true || phase.holiday === true)
  const bands = axis.bands
    .map((band: any) => pkClock(band.start) + '–' + pkClock(band.end) + t(band.peak ? 'peakShort' : 'offPeakShort'))
    .join('、')
  return [
    bands,
    left,
    t(offDay ? 'weekendAllOffPeak' : phase !== null && phase.inPeak === true ? 'peakNotice' : 'offPeakActive'),
  ].join('; ')
}

/** 宽栏「动态」样式:比例分段轨道 + 反色刻度胶囊 + 相位芯片与倒计时。 */
function PeakSwiper(props: any) {
  const { axis, phase, left, chip, t } = props
  const label = hoverText(t, axis, phase, left)
  return el('div', { className: 'cm-peak-strip ' + axis.key, 'aria-label': label },
    el(Track, { axis }),
    el('span', { className: 'cm-peak-chip' }, chip))
}

/** 窄栏(rail)「动态」样式:竖排时轴 + 反色胶囊滑块 + 横排短词。 */
function PeakSwiperRail(props: any) {
  const { axis, phase, left, t } = props
  const label = hoverText(t, axis, phase, left)
  return el('div', { className: 'cm-peak-rail wiper ' + axis.key, 'aria-label': label },
    el(Track, { axis, rail: true }),
    el('span', { className: 'cm-peak-rail-label' }, t('peakShort')))
}

/**
 * 分块挂载入口:返回渲染组件。主客户端只负责按需加载;相位、时轴、倒计时、
 * 文案与 30 秒时刻心跳都在分块内自算,不依赖主包传时刻。
 */
export function mount() {
  return function PeakDynamic(props: any) {
    const [tick, setTick] = useState(Date.now())
    useEffect(() => {
      const timer = window.setInterval(() => setTick(Date.now()), 30000)
      return () => window.clearInterval(timer)
    }, [])
    // props.now 供测试与外部注入固定时刻;生产路径由内建心跳驱动。
    const now = Number.isFinite(props.now) ? props.now : tick
    ensureCss()
    const phase = phaseOf(props.config, now)
    const axis = axisOf(props.config, now, phase)
    // 相位标签键与主包同口径(peak-core.phaseLabelKeys;weekend/holiday 互斥,取值一致)。
    const keys = phaseLabelKeys(phase)
    const left = phase.nextIntoPeak
      ? props.t('nextPeakIn', { time: countdownText(phase, now, props.t) })
      : props.t('nextOffPeakIn', { time: countdownText(phase, now, props.t) })
    const data = { ...props, now, phase, axis, left, chip: props.t(keys.chip) }
    return props.rail
      ? el(PeakSwiperRail, { ...data, short: props.t(keys.short) })
      : el(PeakSwiper, data)
  }
}
