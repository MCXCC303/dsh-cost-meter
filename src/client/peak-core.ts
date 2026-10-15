/**
 * 峰谷纯计算核心:谷价区间、峰时判定、相位快照与倒计时文案。
 *
 * 与 lib/pricing.js 的 peakPhaseAt/tierFor 同逻辑(bundle 无法导入 Node 模块,
 * 修改时两处需同步)。本模块是纯逻辑,不得 import React。
 */

/** 单个峰窗:[start, end) 半开区间(UTC 小时),兼容跨午夜窗口。 */
export interface PeakWindow { start: number; end: number }

/** 全天谷价区间(周末/法定假日):[start, end) 毫秒时间戳。 */
export interface OffPeakZone { start: number; end: number }

/** 峰谷相位快照:prevAtMs/nextAtMs 为相邻切换点,nextIntoPeak = 下一相位是否进入峰时。 */
export interface PeakPhase {
  inPeak: boolean
  weekend: boolean
  holiday?: boolean
  prevAtMs: number
  nextAtMs: number
  nextIntoPeak: boolean
}

/** 相位标签词典键(chip = 展开态文案,short = 收起态短词,notice = 悬停说明)。 */
export interface PhaseLabelKeys { short: string; chip: string; notice: string }

/** 翻译函数形态(与 t.ts 的 makeT 返回值一致)。 */
export type PeakTranslate = (key: string, params?: Record<string, unknown>) => string

/** 峰谷相位计算所需的配置子集(与原片段直接取 config 字段同口径)。 */
export interface PeakConfigLike {
  peakNotice?: boolean
  peakEnabled?: boolean
  peakEffectiveAt?: string
  peakWindows?: PeakWindow[]
  peakHolidays?: string[]
}

/** 周末全谷价生效时刻(UTC):2026-08-23(周日)00:00 北京时间(与 lib/pricing.js 同步)。 */
export const WEEKEND_OFFPEAK_EFFECTIVE_MS = Date.parse('2026-08-22T16:00:00Z')
/** 某时刻所处的周末全谷价区间(北京日历周六/周日,生效后);非周末/生效前返回 null。 */
export function weekendZoneAt(atMs: number): OffPeakZone | null {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_MS) return null
  const day = Math.floor((atMs + 8 * 3600000) / 86400000)
  const weekday = (day + 4) % 7
  if (weekday !== 6 && weekday !== 0) return null
  const satDay = weekday === 6 ? day : day - 1
  const start = Math.max(satDay * 86400000 - 8 * 3600000, WEEKEND_OFFPEAK_EFFECTIVE_MS)
  return { start, end: (satDay + 2) * 86400000 - 8 * 3600000 }
}
export function holidayZoneAt(atMs: number, holidays: string[] | undefined): OffPeakZone | null {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_MS || !Array.isArray(holidays)) return null
  const day = Math.floor((atMs + 8 * 3600000) / 86400000)
  if (!holidays.includes(new Date(day * 86400000).toISOString().slice(0, 10))) return null
  return { start: day * 86400000 - 8 * 3600000, end: (day + 1) * 86400000 - 8 * 3600000 }
}
export const offPeakZoneAt = (atMs: number, holidays: string[] | undefined): OffPeakZone | null => holidayZoneAt(atMs, holidays) ?? weekendZoneAt(atMs)
export function isPeakHour(atMs: number, effectiveAtMs: number | undefined, windows: PeakWindow[] | undefined, holidays: string[] | undefined): boolean {
  if (!Array.isArray(windows) || windows.length === 0) return false
  if (offPeakZoneAt(atMs, holidays) !== null) return false
  if (effectiveAtMs !== undefined && Number.isFinite(effectiveAtMs) && atMs < effectiveAtMs) return false
  const hour = new Date(atMs).getUTCHours()
  return windows.some(w => {
    const start = Number(w.start)
    const end = Number(w.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    return start < end ? hour >= start && hour < end : hour >= start || hour < end
  })
}
/** 峰谷时代分界(与 lib/pricing.js LEGACY_BASE_BOUNDARY 同步):此前按当时基础价计费。 */
export const LEGACY_BASE_BOUNDARY_MS = Date.parse('2026-08-16T16:00:00Z')

/**
 * 峰谷相位与相邻切换点(与 lib/pricing.js 的 peakPhaseAt 同逻辑;bundle 无法导入,
 * 修改时两处需同步)。窗口半开区间 [start, end),兼容跨午夜窗口。
 * 周末/公众假期全天谷价；返回 weekend 或 holiday 标记，跳过期间的峰窗。
 */
export function peakPhaseAt(atMs: number, windows: PeakWindow[] | undefined, holidays: string[] | undefined): PeakPhase | null {
  if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(atMs)) return null
  const hourAt = (dayOffset: number, hour: number): number => {
    const date = new Date(atMs)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    date.setUTCHours(hour, 0, 0, 0)
    return date.getTime()
  }
  const candidates = new Set<number>()
  const span = Math.max(12, Math.min(380, (Array.isArray(holidays) ? holidays.length : 0) + 7))
  for (let day = -span; day <= span; day += 1) {
    candidates.add(hourAt(day, 16))
    for (const w of windows) {
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      candidates.add(hourAt(day, start))
      candidates.add(hourAt(end <= start ? day + 1 : day, end))
    }
  }
  const points = [...candidates].sort((a, b) => a - b).flatMap(at => {
    const before = isPeakHour(at - 1, undefined, windows, holidays)
    const after = isPeakHour(at, undefined, windows, holidays)
    return before === after ? [] : [{ at, intoPeak: after }]
  })
  let prev: { at: number; intoPeak: boolean } | null = null
  let next: { at: number; intoPeak: boolean } | null = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || p.at < next.at)) next = p
  }
  const holiday = holidayZoneAt(atMs, holidays)
  const wk = holiday ?? weekendZoneAt(atMs)
  if (wk !== null) {
    if (next === null) return null
    return { inPeak: false, weekend: holiday === null, ...(holiday ? { holiday: true } : {}), prevAtMs: wk.start, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
  }
  if (prev === null || next === null) return null
  const inPeak = isPeakHour(atMs, undefined, windows, holidays)
  return { inPeak, weekend: false, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}
/** 峰谷显示门控:peakNotice 开关 + peakEnabled + peakEffectiveAt + 非空窗口;不满足返回 null。 */
export function peakView(config: PeakConfigLike | null | undefined, now: number): PeakPhase | null {
  if (!config || config.peakNotice === false || config.peakEnabled !== true) return null
  const effectiveAtMs = Date.parse(config.peakEffectiveAt || '')
  if (Number.isFinite(effectiveAtMs) && now < effectiveAtMs) return null
  const windows = Array.isArray(config.peakWindows) ? config.peakWindows : []
  return peakPhaseAt(now, windows, config.peakHolidays)
}

/** 相位标签键:周末全谷价 / 峰时 / 谷时(chip = 展开态文案,short = 收起态短词,notice = 悬停说明)。 */
export function phaseLabelKeys(view: PeakPhase): PhaseLabelKeys {
  if (view.holiday === true) return { short: 'holidayShort', chip: 'holidayChip', notice: 'holidayAllOffPeak' }
  if (view.weekend === true) return { short: 'weekendShort', chip: 'weekendChip', notice: 'weekendAllOffPeak' }
  return view.inPeak
    ? { short: 'peakShort', chip: 'peakShort', notice: 'peakNotice' }
    : { short: 'offPeakShort', chip: 'offPeakShort', notice: 'offPeakActive' }
}

/** 倒计时文本(距下次相位切换,向上取整到分钟)。 */
export function countdownText(view: PeakPhase, now: number, t: PeakTranslate): string {
  const duration = Math.max(0, view.nextAtMs - now)
  const minutes = Math.max(1, Math.ceil(duration / 60000))
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return hours > 0
    ? (mins > 0 ? t('countdownHourMinute', { h: hours, m: mins }) : t('countdownHoursOnly', { h: hours }))
    : t('countdownMinute', { m: minutes })
}
