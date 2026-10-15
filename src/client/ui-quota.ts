/**
 * 额度类侧边栏卡片:Go 额度 / MiniMax Token Plan / Coding Plan / Codex 周额度 /
 * 网关(CLIProxyAPI)额度 / 输入框上方额度横条。
 *
 * 迁移自旧片段 `src/client/02-validators-helpers-sidebar.js` 第 2270–2956 行。
 * 纯计算(百分比/倒计时文案)保持原实现;组件 props(state/config/api)属宿主边界,暂用 any。
 */

// 平台种子:react 由宿主注入(scripts/build.mjs 把 react 标为 external);
// 类型来自 src/client/seeds.d.ts(仓库不安装 react 与 primitives,避免版本漂移)。
// TODO(types): 后续装 @types/react 与真实的 primitives 类型后,可删除 seeds.d.ts 的兜底声明。
import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  barDirectionOf, displayCostOf, formatMoneyUsd, formatMoneyValue, simpleBarByDirection,
  GATEWAY_PROVIDER_LABELS,
} from './logic.js'
import { makeT, resolveLocale, PERIOD_KEYS } from './t.js'
import { CODING_PLAN_ROWS } from './constants.js'
import { sidebarTodayValue } from './today.js'
// 点击刷新的三个工具与 ui-balance 同源(旧片段 1611–1660 行属该模块区段);单向依赖,无环。
import { useClickRefresh, clickableRefreshProps, clickRefreshTipLines } from './ui-balance.js'
// 预算图框收起态不需要钱包图标(WalletIcon 属 ui-sidebar 的 BudgetBoxContent),故不引 ui-credential。
// 预算图框尾部挂峰谷条(ui-peak 只依赖 peak-core/logic/t,不反向引本模块,无环)。
import { peakNoticeEl } from './ui-peak.js'

const { createElement: el, Fragment, useState, useEffect } = React

// TODO(types): props / state / config 属宿主边界,暂用 any;后续接 wire.ts 的 parseState 结果类型。
type CmState = any
type CmConfig = any
type T = (key: string, params?: Record<string, unknown>) => string

// CODING_PLAN_ROWS 已抽到 constants.ts(启动包额度卡与设置分块共用同一份,不再各放副本);
// 这里转出以兼容既有引用(ui-sidebar/guides 仍从 './ui-quota.js' 导入)。
export { CODING_PLAN_ROWS }

// ── 预算图框 ────────────────────────────────────────────────────────────────

/** 预算图框内容(不含外框),供单独显示与「Go+预算」合并卡片复用;详细信息按 budget.detail 开关。 */
export function budgetBoxBody(state: CmState, config: CmConfig, t: T) {
  const today = state.today
  const budget = config.budget ?? { enabled: false, amount: 100, period: 'month' }
  const rate = Number(config.exchangeRate)
  const budgetUsedUsd = state.budgetUsed ?? (
    budget.period === 'day' ? displayCostOf(state.today, config)
      : budget.period === 'all' ? displayCostOf(state.total, config)
        : displayCostOf(state.month, config))
  const used = budgetUsedUsd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
  const amount = Math.max(0, Number(budget.amount) || 0)
  const pct = amount > 0 ? Math.min(999, used / amount * 100) : null
  // 条形方向(issue #67):默认已用方向(#57 口径);剩余方向时填充与标签显示剩余%。
  const barView = simpleBarByDirection(pct === null ? null : Math.min(100, pct), barDirectionOf(config, 'budget'))
  const todayUsed = displayCostOf(today, config) * (Number.isFinite(rate) && rate > 0 ? rate : 1)
  const todayPct = amount > 0 ? Math.min(999, todayUsed / amount * 100) : null
  const detail = budget.detail !== false
  return {
    level: pct === null ? 'ok' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok',
    rail: barView.label === null ? '—' : Math.round(barView.label) + '%',
    body: el(Fragment, null,
      el('div', { className: 'cm-bbox-head' },
        el('span', { className: 'cm-bbox-label' }, t('budget')),
        el('span', { className: 'cm-bbox-pct cm-num' }, barView.label === null ? '—' : barView.label.toFixed(1) + '%')),
      el('div', { className: 'cm-bbox-bar' },
        el('div', { className: 'cm-bbox-fill', style: { width: barView.width + '%' } })),
      detail
        ? el(Fragment, null,
          // 今日金额行受 hideTodayCost 门控(issue #46);金额为真金白银口径(issue #64)。
          config.hideTodayCost === true ? null : el('div', { className: 'cm-bbox-line cm-num' },
            config.sidebarTodayMetric === 'tokens'
              ? t('today') + ' ' + sidebarTodayValue(today, config, t)
              : t('todayShare', {
                amount: formatMoneyUsd(displayCostOf(today, config), config),
                pct: todayPct === null ? '—' : todayPct.toFixed(1) + '%',
              })),
          el('div', { className: 'cm-bbox-line cm-num' },
            t('usedOf', { used: formatMoneyValue(used, config), amount: formatMoneyValue(amount, config) })))
        : null,
      peakNoticeEl(state, config, t)),
  }
}

// ── OpenCode Go 额度 ────────────────────────────────────────────────────────

/** OpenCode Go 额度图框内容(不含外框),与预算图框同风格;主档位可配(默认 5h),其余档位在下方一行展示;详细信息按 goQuota.detail 开关。 */
export function goBoxBody(state: CmState, config: CmConfig, t: T) {
  const goQuota = state.goQuota
  const mainKey = config?.goQuota?.main === 'weekly' || config?.goQuota?.main === 'monthly' ? config.goQuota.main : 'rolling'
  const mainWin = goQuota[mainKey]
  const pct = mainWin !== null && typeof mainWin?.percent === 'number' ? Math.max(0, Math.min(100, Number(mainWin.percent) || 0)) : 0
  const pctOf = (win: any) => (win !== null && typeof win?.percent === 'number') ? Math.round(Math.max(0, Math.min(100, win.percent))) + '%' : '—'
  const shortOf = (k: string) => k === 'rolling' ? t('goShortRolling') : k === 'weekly' ? t('goShortWeekly') : t('goShortMonthly')
  const others = ['rolling', 'weekly', 'monthly'].filter(k => k !== mainKey)
  const resets = mainWin !== null && typeof mainWin?.resetsAt === 'string' && mainWin.resetsAt.length > 0
    ? t('goResetAt', { time: new Date(mainWin.resetsAt).toLocaleString() })
    : ''
  const detail = config?.goQuota?.detail !== false
  // 条形方向(issue #67):默认已用方向;剩余方向时填充与标签显示剩余%。
  const barView = simpleBarByDirection(pct, barDirectionOf(config, 'go'))
  return {
    level: pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok',
    rail: barView.label === null ? '—' : Math.round(barView.label) + '%',
    body: el(Fragment, null,
      el('div', { className: 'cm-bbox-head' },
        el('span', { className: 'cm-bbox-label' }, t('goQuotaRowLabel') + ' ' + shortOf(mainKey)),
        el('span', { className: 'cm-bbox-pct cm-num' }, barView.label === null ? '—' : Math.round(barView.label) + '%')),
      el('div', { className: 'cm-bbox-bar' },
        el('div', { className: 'cm-bbox-fill', style: { width: barView.width + '%' } })),
      detail
        ? el(Fragment, null,
          el('div', { className: 'cm-bbox-line cm-num' },
            others.map(k => shortOf(k) + ' ' + pctOf(goQuota[k])).join(' · ')),
          resets ? el('div', { className: 'cm-bbox-line' }, resets) : null)
        : null),
  }
}

export function GoQuotaBox(props: any) {
  const { state, wide } = props
  const goQuota = state.goQuota
  const t: T = makeT(resolveLocale(state.config))
  if (!goQuota || goQuota.status !== 'ok') return null
  const mainKey = state.config?.goQuota?.main === 'weekly' || state.config?.goQuota?.main === 'monthly' ? state.config.goQuota.main : 'rolling'
  if (goQuota[mainKey] === null || typeof goQuota[mainKey]?.percent !== 'number') return null
  const view = goBoxBody(state, state.config, t)
  const detail = [
    t('goQuotaTitle'),
    t('goWindowRolling') + ': ' + (goQuota.rolling === null ? '—' : Math.round(goQuota.rolling.percent) + '%'),
    t('goWindowWeekly') + ': ' + (goQuota.weekly === null ? '—' : Math.round(goQuota.weekly.percent) + '%'),
    t('goWindowMonthly') + ': ' + (goQuota.monthly === null ? '—' : Math.round(goQuota.monthly.percent) + '%'
      + (goQuota.monthly !== null && typeof goQuota.monthly.resetsAt === 'string' && goQuota.monthly.resetsAt.length > 0
        ? ' · ' + t('goResetAt', { time: new Date(goQuota.monthly.resetsAt).toLocaleString() })
        : '')),
    t('goQuotaFetchedAt', { time: goQuota.fetchedAt > 0 ? new Date(goQuota.fetchedAt).toLocaleTimeString() : '—' }),
  ].join('; ')
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-bbox' + (view.level === 'ok' ? '' : ' ' + view.level) + (wide ? '' : ' rail') },
      wide ? view.body : el('div', { className: 'cm-bbox-rail cm-num' }, view.rail)))
}

// ── MiniMax Token Plan ─────────────────────────────────────────────────────

/** MiniMax Token Plan 窗口的已用百分比(与其它厂商同口径:windows.percent 即已用)。 */
export function planWindowUsedPct(win: any): number | null {
  if (win === null || typeof win !== 'object' || win.unlimited || typeof win.percent !== 'number') return null
  return Math.max(0, Math.min(100, Math.round(Number(win.percent) || 0)))
}

export function miniMaxWindowsOf(windows: any) {
  const map = windows !== null && typeof windows === 'object' ? windows : {}
  return {
    five: map['5h'] ?? null,
    seven: map['7d'] ?? map.week ?? map.weekly ?? null,
  }
}

export function formatResetCountdown(resetsAt: any, t: T, now = Date.now()): string {
  if (typeof resetsAt !== 'string' || !resetsAt) return ''
  const end = Date.parse(resetsAt)
  if (!Number.isFinite(end)) return ''
  const diff = end - now
  if (diff <= 0) return t('resetReached')
  const minutes = Math.ceil(diff / 60000)
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return t('resetDays', { d, h })
  if (h > 0) return t('resetHours', { h, m })
  return t('resetMinutes', { m })
}

export function miniMaxResetText(win: any, t: T, now = Date.now()): string {
  const countdown = formatResetCountdown(win?.resetsAt, t, now)
  if (!countdown) return ''
  return t('goResetAt', { time: new Date(win.resetsAt).toLocaleString() }) + ' (' + countdown + ')'
}

export function quotaValueText(value: number | null, direction: string, t: T): string {
  return value === null ? '—' : t(direction === 'remaining' ? 'quotaRemaining' : 'quotaUsed', { pct: value })
}

// 悬停/聚焦刷新提示;显示常驻倒计时的卡片每分钟更新一次,不请求网络。
export function useQuotaHoverRefresh(resetsAt?: unknown) {
  const [, setNow] = useState(0)
  const refresh = () => setNow(Date.now())
  useEffect(() => {
    if (!resetsAt) return
    const timer = setInterval(refresh, 60000)
    return () => clearInterval(timer)
  }, [resetsAt])
  return { onMouseEnter: refresh, onFocus: refresh }
}

/**
 * 单窗口进度行。进度条与百分比一律按「已用」方向填充——v1.5.44 及以前本卡片按
 * 「余量」填充,与通用卡片/额度横条的「已用」方向相反,同屏并列时引起误读
 * (issue #57);现统一为已用口径,告警阈值也与 CodingPlanBox 一致(≥80 warn / ≥100 over)。
 */
export function miniMaxRow(label: string, win: any, direction: string, t: T) {
  const pct = planWindowUsedPct(win)
  const level = pct === null ? 'ok' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
  const barView = simpleBarByDirection(pct, direction)
  const text = win?.unlimited ? '∞' : barView.label === null ? '—' : barView.label + '%'
  return {
    level,
    pct,
    text,
    label: barView.label,
    row: el('div', { className: 'cm-mm-row' + (level === 'ok' ? '' : ' ' + level) },
      el('span', { className: 'cm-bbox-label' }, label),
      el('div', { className: 'cm-bbox-bar' },
        el('div', { className: 'cm-bbox-fill', style: { width: barView.width + '%' } })),
      el('span', { className: 'cm-bbox-pct cm-num' }, text)),
  }
}

export function MiniMaxPlanCard(props: any) {
  const { five, seven, fetchedAt, t, wide, refresh, direction = 'used' } = props
  const hoverProps = useQuotaHoverRefresh(five?.resetsAt)
  const countdown = formatResetCountdown(five?.resetsAt, t)
  const fiveView = miniMaxRow(t('codingPlanRemain5h'), five, direction, t)
  const sevenView = miniMaxRow(t('codingPlanRemain7d'), seven, direction, t)
  const level = fiveView.level === 'over' || sevenView.level === 'over' ? 'over'
    : fiveView.level === 'warn' || sevenView.level === 'warn' ? 'warn' : 'ok'
  const lineOf = (label: string, win: any, view: any) => {
    const pct = win?.unlimited ? t('quotaUnlimited') : quotaValueText(view.label, direction, t)
    const reset = miniMaxResetText(win, t)
    return label + ' ' + pct + (reset ? ' · ' + reset : '')
  }
  const detail = [
    t('codingPlanMinimaxTitle'),
    lineOf(t('codingPlanRemain5h'), five, fiveView),
    lineOf(t('codingPlanRemain7d'), seven, sevenView),
    fetchedAt > 0 ? t('goQuotaFetchedAt', { time: new Date(fetchedAt).toLocaleTimeString() }) : null,
    ...(refresh ? clickRefreshTipLines(t, refresh) : []),
  ].filter(Boolean).join('\n')
  const body = el(Fragment, null,
    el('div', { className: 'cm-mm-title' }, t('codingPlanMinimaxTitle')),
    fiveView.row,
    sevenView.row,
    countdown ? el('div', { className: 'cm-mm-reset' }, '5h · ' + countdown) : null)
  const rail = el(Fragment, null,
    el('div', { className: 'cm-bbox-rail cm-num' }, fiveView.text),
    el('div', { className: 'cm-bbox-rail cm-num' }, sevenView.text))
  return el(Tooltip, { label: el('span', { style: { whiteSpace: 'pre-line' } }, detail), side: 'right', delayMs: 300 },
    el('div', {
      ...hoverProps, className: 'cm-bbox cm-mm' + (level === 'ok' ? '' : ' ' + level) + (wide === false ? ' rail' : '')
        + (refresh ? ' clickable' + (refresh.busy ? ' busy' : '') : ''),
      ...(refresh ? clickableRefreshProps(refresh.busy, refresh.run) : {}),
    },
    wide === false ? rail : body))
}

export function MiniMaxPlanBox(props: any) {
  const { state, wide, api } = props
  const live = state.codingPlans?.minimax
  const t: T = makeT(resolveLocale(state.config))
  const refresh = useClickRefresh(api ? () => api.refreshCodingPlan('minimax') : null)
  if (!live || live.status !== 'ok') return null
  const { five, seven } = miniMaxWindowsOf(live.windows)
  if (five == null && seven == null) return null
  return el(MiniMaxPlanCard, { five, seven, fetchedAt: live.fetchedAt, t, wide, refresh, direction: barDirectionOf(state.config, 'plan') })
}

// ── ChatGPT PLUS(Codex)周额度(issue #59)──────────────────────────────
// 数据源是 dsh-codex-connect 插件(dsh-openai-codex)暴露在 web 同源的只读状态路由,
// 不读凭据、不配置 Key;插件不在/未登录时探测失败,相关 UI 自动隐藏。
// 宿主进程无法感知 web 端口,故由浏览器端同源 fetch(与 .tmp 社区补丁同思路,收敛为独立模块)。

export const CODEX_STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
export const CODEX_WEEK_SECONDS = 7 * 24 * 3600

/** Codex 周额度窗口(与 coding plan 同构;percent = 已用)。 */
export type CodexQuotaWindow = { percent: number; resetsAt: string }
/** 解析结果:目前只有 7 天窗口。 */
export type CodexQuotaWindows = { weekly?: CodexQuotaWindow }

/** 解析 dsh-codex-connect 的 auth/status 响应 → 与 coding plan 同构的窗口对象(percent=已用)。 */
export function parseCodexStatus(data: any): CodexQuotaWindows | null {
  if (data === null || typeof data !== 'object' || data.status !== 'signed-in') return null
  const limits = data.usage !== null && typeof data.usage === 'object' ? data.usage.rateLimits : null
  if (!Array.isArray(limits)) return null
  const bucket = limits.find((l: any) => l !== null && typeof l === 'object' && l.id === 'codex')
  if (!bucket || !Array.isArray(bucket.windows)) return null
  const win = bucket.windows.find((w: any) => w !== null && typeof w === 'object' && Number(w.windowSeconds) === CODEX_WEEK_SECONDS)
  if (!win || typeof win.remainingPercent !== 'number' || !Number.isFinite(Number(win.remainingPercent))) return null
  const usedPct = Math.max(0, Math.min(100, Math.round((100 - Number(win.remainingPercent)) * 10) / 10))
  const resetSec = Number(win.resetAt)
  const resetsAt = Number.isFinite(resetSec) && resetSec > 0 ? new Date(resetSec * 1000).toISOString() : ''
  return { weekly: { percent: usedPct, resetsAt } }
}

/** 模块级 Codex 额度缓存 + 订阅者(探测一次,多处复用;避免每个卡片各打一次同源路由)。 */
export const codexQuotaCache: {
  status: 'idle' | 'ok' | 'unavailable'
  windows: CodexQuotaWindows
  fetchedAt: number
  inFlight: Promise<void> | null
  listeners: Array<() => void>
} = { status: 'idle', windows: {}, fetchedAt: 0, inFlight: null, listeners: [] }

export const subscribeCodexQuota = (fn: () => void): (() => void) => {
  codexQuotaCache.listeners.push(fn)
  return () => { codexQuotaCache.listeners = codexQuotaCache.listeners.filter(f => f !== fn) }
}

export const notifyCodexQuota = (): void => {
  for (const fn of codexQuotaCache.listeners) { try { fn() } catch { /* 订阅方异常不扩散 */ } }
}

/**
 * 探测 Codex 周额度。结果写模块缓存并广播;非 force 时 5 分钟内直接用缓存
 * (404/未登录/网络错误都按 unavailable 缓存,避免每次渲染反复打同一空路由)。
 */
async function fetchCodexQuota(force = false, enabled = false): Promise<void> {
  if (!enabled) return
  if (codexQuotaCache.inFlight !== null) return codexQuotaCache.inFlight
  if (!force && codexQuotaCache.fetchedAt > 0 && Date.now() - codexQuotaCache.fetchedAt < 5 * 60_000) return undefined
  const task = (async () => {
    try {
      const resp = await fetch(CODEX_STATUS_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      let windows: CodexQuotaWindows = {}
      if (resp.ok) {
        const parsed = parseCodexStatus(await resp.json().catch(() => null))
        if (parsed !== null) windows = parsed
      }
      codexQuotaCache.status = Object.keys(windows).length > 0 ? 'ok' : 'unavailable'
      codexQuotaCache.windows = windows
    } catch {
      codexQuotaCache.status = 'unavailable'
    } finally {
      codexQuotaCache.fetchedAt = Date.now()
      codexQuotaCache.inFlight = null
      notifyCodexQuota()
    }
  })()
  codexQuotaCache.inFlight = task
  return task
}

export function useCodexQuota(enabled: boolean) {
  const [snap, setSnap] = useState(() => ({
    status: codexQuotaCache.status,
    windows: codexQuotaCache.windows,
    fetchedAt: codexQuotaCache.fetchedAt,
  }))
  useEffect(() => {
    if (!enabled) return
    let mounted = true
    const sync = () => {
      if (mounted) setSnap({ status: codexQuotaCache.status, windows: codexQuotaCache.windows, fetchedAt: codexQuotaCache.fetchedAt })
    }
    const unsubscribe = subscribeCodexQuota(sync)
    sync()
    void fetchCodexQuota(false, true)
    return () => { mounted = false; unsubscribe() }
  }, [enabled])
  return snap
}

/** Codex 周额度侧边栏卡片:复用 MiniMax 行渲染(已用口径,issue #57 统一后的方向)。 */
export function CodexPlanBox(props: any) {
  const hoverProps = useQuotaHoverRefresh()
  const { state, wide } = props
  const t: T = makeT(resolveLocale(state.config))
  const enabled = state.config?.codexQuotaEnabled === true && state.config?.codexQuotaSidebar !== false
  const snap = useCodexQuota(enabled)
  const refresh = useClickRefresh(() => fetchCodexQuota(true, enabled))
  if (!enabled || snap.status !== 'ok') return null
  const win = snap.windows.weekly ?? null
  if (win === null) return null
  const direction = barDirectionOf(state.config, 'plan')
  const view = miniMaxRow(t('goShortWeekly'), win, direction, t)
  const detail = [
    t('codexQuotaTitle'),
    quotaValueText(view.label, direction, t),
    miniMaxResetText(win, t),
    snap.fetchedAt > 0 ? t('goQuotaFetchedAt', { time: new Date(snap.fetchedAt).toLocaleTimeString() }) : null,
    ...clickRefreshTipLines(t, refresh),
  ].filter(Boolean).join('\n')
  const body = el(Fragment, null,
    el('div', { className: 'cm-mm-title' }, t('codexQuotaTitle')),
    view.row)
  const rail = el('div', { className: 'cm-bbox-rail cm-num' }, view.label === null ? '—' : view.label + '%')
  return el(Tooltip, { label: el('span', { style: { whiteSpace: 'pre-line' } }, detail), side: 'right', delayMs: 300 },
    el('div', {
      ...hoverProps, className: 'cm-bbox cm-mm clickable' + (view.level === 'ok' ? '' : ' ' + view.level)
        + (wide === false ? ' rail' : '') + (refresh.busy ? ' busy' : ''),
      ...clickableRefreshProps(refresh.busy, refresh.run),
    },
    wide === false ? rail : body))
}

// ── 通用 Coding Plan ───────────────────────────────────────────────────────

/** 通用 Coding Plan 侧边栏卡片(issue #31):每窗口一行进度条;文本窗口(余额等)整行文本。 */
export function codingPlanWindowLabel(name: string, t: T): string {
  if (name === 'fiveHour' || name === '5h') return '5h'
  if (name === 'weekly' || name === 'week' || name === '7d') return name === '7d' ? '7d' : t('goShortWeekly')
  if (name === 'monthly' || name === 'month') return t('goShortMonthly')
  if (name === 'daily' || name === 'day') return t('goShortDaily')
  if (name === 'plan') return t('mimoWindowPlan')
  if (name === 'compensation') return t('mimoWindowCompensation')
  if (name === 'balance') return t('codingPlanWindowBalance')
  return String(name).replace(/_/g, ' ')
}

export function CodingPlanBox(props: any) {
  const hoverProps = useQuotaHoverRefresh()
  const { id, state, wide, api } = props
  const live = state.codingPlans?.[id]
  const t: T = makeT(resolveLocale(state.config))
  const refresh = useClickRefresh(api ? () => api.refreshCodingPlan(id) : null)
  const rowDef = CODING_PLAN_ROWS.find(r => r.id === id)
  if (!rowDef || !live || live.status !== 'ok') return null
  const windows = live.windows !== null && typeof live.windows === 'object' ? live.windows : {}
  const entries = Object.entries(windows)
  if (entries.length === 0) return null
  const pctOf = (win: any): number | null => win !== null && typeof win === 'object' && typeof win.percent === 'number'
    ? Math.max(0, Math.min(100, Math.round(Number(win.percent) || 0))) : null
  // 条形方向(issue #67):Plan 卡默认已用方向,剩余方向时填充与标签显示剩余%。
  const planDirection = barDirectionOf(state.config, 'plan')
  const rows = entries.map(([name, win]) => {
    const pct = pctOf(win)
    if (pct === null) {
      return el('div', { key: name, className: 'cm-mm-row wide' },
        el('span', { className: 'cm-mm-text' }, typeof (win as any)?.text === 'string' ? (win as any).text : '—'))
    }
    const level = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
    const barView = simpleBarByDirection(pct, planDirection)
    return el('div', { key: name, className: 'cm-mm-row wide' + (level === 'ok' ? '' : ' ' + level) },
      el('span', { className: 'cm-bbox-label' }, codingPlanWindowLabel(name, t)),
      el('div', { className: 'cm-bbox-bar' },
        el('div', { className: 'cm-bbox-fill', style: { width: barView.width + '%' } })),
      el('span', { className: 'cm-bbox-pct cm-num' }, barView.label === null ? '—' : barView.label + '%'))
  })
  const detailParts = entries.map(([name, win]) => {
    const w = win as any
    const pct = pctOf(win)
    const reset = miniMaxResetText(w, t)
    const value = pct === null ? (typeof w?.text === 'string' ? w.text : '—')
      : quotaValueText(simpleBarByDirection(pct, planDirection).label, planDirection, t)
    return codingPlanWindowLabel(name, t) + ' ' + value + (reset ? ' · ' + reset : '')
  })
  if (live.fetchedAt > 0) detailParts.push(t('goQuotaFetchedAt', { time: new Date(live.fetchedAt).toLocaleTimeString() }))
  detailParts.push(...clickRefreshTipLines(t, refresh))
  const detail = [t(rowDef.labelKey), ...detailParts].join('\n')
  const pcts = entries.map(([, win]) => pctOf(win)).filter((p): p is number => p !== null)
  const level = pcts.some(p => p >= 100) ? 'over' : pcts.some(p => p >= 80) ? 'warn' : 'ok'
  const railText = pcts.length > 0
    ? pcts.slice(0, 2).map(p => simpleBarByDirection(p, planDirection).label + '%').join(' ')
    : (typeof (entries[0][1] as any)?.text === 'string' ? (entries[0][1] as any).text : '—')
  return el(Tooltip, { label: el('span', { style: { whiteSpace: 'pre-line' } }, detail), side: 'right', delayMs: 300 },
    el('div', { ...hoverProps, className: 'cm-bbox cm-mm clickable' + (level === 'ok' ? '' : ' ' + level) + (wide === false ? ' rail' : '') + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
      wide === false
        ? el('div', { className: 'cm-bbox-rail cm-num' }, railText)
        : el(Fragment, null,
          el('div', { className: 'cm-mm-title' }, t(rowDef.labelKey)),
          ...rows)))
}

// ── 网关(CLIProxyAPI)额度 ─────────────────────────────────────────────────

export const readGatewayAccountLS = (id: string): string => {
  try { return window.localStorage?.getItem?.('cm.gw.' + id) ?? '' } catch { return '' }
}
export const writeGatewayAccountLS = (id: string, accountId: string): void => {
  try { window.localStorage?.setItem?.('cm.gw.' + id, accountId) } catch { /* 隐私模式静默 */ }
}

// ── 网关(CLIProxyAPI)额度侧边栏卡片(issue #96)─────────────────────────
// 此前 display=sidebar/both 是未接线开关:宿主每刷新周期正常下发 state.gatewayQuotas,
// 但侧边栏渲染路径没有任何 gateway 分支,配置侧边栏显示后什么也看不到。
// 现与余额/计划卡同口径门控:来源启用 + display 侧边栏/两者 + 快照有账号数据
// (ok/partial/stale;error/loading/off 留在设置页展示)才出卡;行渲染复用 MiniMax
// 卡(已用口径,≥80 warn / ≥100 over);多账号时行标签加 Provider 前缀,行数上限 4
// 防撑爆;仅有 credits 无窗口的账号(如 WorkBuddy)退化为文本行。
export function GatewayQuotaBox(props: any) {
  const hoverProps = useQuotaHoverRefresh()
  const { source, snapshot, state, wide, api } = props
  const t: T = makeT(resolveLocale(state.config))
  const [selection, setSelection] = useState(() => ({ source: source.id, id: readGatewayAccountLS(source.id) }))
  const refresh = useClickRefresh(api ? () => api.refreshGatewayQuota(source.id) : null)
  const direction = barDirectionOf(state.config, 'plan')
  const multi = snapshot.accounts.length > 1
  const selectedId = selection.source === source.id ? selection.id : readGatewayAccountLS(source.id)
  const selectedIdx = snapshot.accounts.findIndex((a: any) => a.id === selectedId)
  const activeIdx = selectedIdx >= 0 ? selectedIdx : Math.max(0, snapshot.accounts.findIndex((a: any) => a.windows.length > 0 || a.credits != null))
  const currentAccount = snapshot.accounts[activeIdx] ?? snapshot.accounts[0]
  const currentAccountName = currentAccount?.label || currentAccount?.id || ''
  const prefix = (account: any) => multi ? (GATEWAY_PROVIDER_LABELS[account.provider] ?? account.provider) + ' · ' : ''
  const accountsToRender = multi && currentAccount ? [currentAccount] : snapshot.accounts
  const rows: any[] = []
  for (const account of accountsToRender) {
    if (rows.length >= 4) break
    for (const win of account.windows) {
      if (rows.length >= 4) break
      const name = prefix(account) + (win.label || win.id || t('gatewaySourceUnknown'))
      rows.push({ win, name, view: miniMaxRow(name, win, direction, t) })
    }
    if (account.windows.length === 0 && account.credits != null) {
      rows.push({ win: null, name: prefix(account) + (account.credits.unit || 'credits'), text: (account.credits.used ?? '—') + ' / ' + (account.credits.limit ?? '—') })
    }
  }
  if (rows.length === 0) rows.push({ name: t('gatewayQuotaEmpty'), text: '—' })
  const level = rows.some(r => r.view?.level === 'over') ? 'over' : rows.some(r => r.view?.level === 'warn') ? 'warn' : 'ok'
  const detailParts = rows.map(r => {
    if (r.text != null) return r.name + ' ' + r.text
    const reset = miniMaxResetText(r.win, t)
    return r.name + ' ' + quotaValueText(r.view.label, direction, t) + (reset ? ' · ' + reset : '')
  })
  if (snapshot.fetchedAt > 0) detailParts.push(t('goQuotaFetchedAt', { time: new Date(snapshot.fetchedAt).toLocaleTimeString() }))
  detailParts.push(...clickRefreshTipLines(t, refresh))
  const accHeader = multi && currentAccountName
    ? `${source.label || source.id} (${activeIdx + 1}/${snapshot.accounts.length} · ${currentAccountName})`
    : (source.label || source.id)
  const detail = [accHeader, ...detailParts].join('\n')
  const bodyRows = rows.map((r, i) => r.text != null
    ? el('div', { key: i, className: 'cm-mm-row wide' }, el('span', { className: 'cm-bbox-label' }, r.name), el('span', { className: 'cm-mm-text cm-num' }, r.text))
    : el(Fragment, { key: i }, r.view.row))

  const onSwitch = (e: any) => {
    if (!e.key || e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
      e.preventDefault?.()
      const next = snapshot.accounts[(activeIdx + 1) % snapshot.accounts.length]
      writeGatewayAccountLS(source.id, next.id)
      setSelection({ source: source.id, id: next.id })
    }
  }

  const switchBtn = multi ? el('span', {
    className: 'cm-gw-switcher',
    'aria-label': t('gatewaySwitchAccount', { account: currentAccountName || (activeIdx + 1) }),
    onClick: onSwitch,
    onKeyDown: onSwitch,
    role: 'button',
    tabIndex: 0,
  }, `${activeIdx + 1}/${snapshot.accounts.length} ⇄`) : null

  const titleRow = multi
    ? el('div', { className: 'cm-bbox-head' }, el('div', { className: 'cm-mm-title' }, source.label || source.id), switchBtn)
    : el('div', { className: 'cm-mm-title' }, source.label || source.id)
  const accSub = multi && currentAccountName
    ? el('div', { className: 'cm-gw-sub' }, currentAccountName)
    : null

  const body = el(Fragment, null, titleRow, accSub, ...bodyRows)
  const pcts = rows.filter(r => r.view).map(r => r.view.label).filter((p: number | null) => p !== null)
  const railText = pcts.length > 0 ? pcts.slice(0, 2).map((p: number) => p + '%').join(' ') : (rows[0].text ?? '—')
  const rail = el('div', { className: 'cm-bbox-rail cm-num' }, railText)
  return el(Tooltip, { label: el('span', { style: { whiteSpace: 'pre-line' } }, detail), side: 'right', delayMs: 300 },
    el('div', {
      ...hoverProps, className: 'cm-bbox cm-mm clickable' + (level === 'ok' ? '' : ' ' + level) + (wide === false ? ' rail' : '') + (refresh.busy ? ' busy' : ''),
      ...clickableRefreshProps(refresh.busy, refresh.run),
    }, wide === false ? el(Fragment, null, rail, switchBtn) : body))
}

/** 侧边栏网关卡片列表:按来源配置(display/enabled)与快照状态过滤,见 GatewayQuotaBox 注释。 */
export function gatewaySidebarCards(state: CmState, config: CmConfig, wide: boolean, api: any) {
  const snaps = Array.isArray(state.gatewayQuotas) ? state.gatewayQuotas : []
  const nodes: any[] = []
  for (const source of config.gatewayQuotas?.sources ?? []) {
    if (source.enabled === false || (source.display !== 'sidebar' && source.display !== 'both')) continue
    const live = snaps.find((q: any) => q.id === source.id)
    if (!live || (live.status !== 'ok' && live.status !== 'partial' && live.status !== 'stale') || live.accounts.length === 0) continue
    nodes.push(el(GatewayQuotaBox, { source, snapshot: live, state, wide, api }))
  }
  return nodes
}

// ── 输入框上方额度横条 ─────────────────────────────────────────────────────

// 输入框上方额度横条:横排 chips(短标签 + 迷你进度条 + 百分比);预算/Go/Coding Plan
// 三类内容各自开关,无可用数据(未启用/未配置/查询失败)时整条自动隐藏。
export const STRIP_VENDOR_SHORT: Record<string, string> = {
  anthropic: 'Claude',
  zai: 'Z.ai',
  minimax: 'MM',
  kimi: 'Kimi',
  openrouter: 'OR',
  siliconflow: 'SF',
  commandcode: 'CC',
  scnet: 'SCNet',
  volcengine: 'Ark',
  qwen: 'Qwen',
  mimo: 'MiMo',
}

export function QuotaStrip(props: any) {
  const costStore = props.useCost ? props.useCost((s: CmState) => s) : undefined
  useCodexQuota(costStore?.state?.config?.codexQuotaEnabled === true)
  // Hook 先于一切条件返回(React 规则):横条会因 state 缺失/开关关闭随时提前 return null。
  const [busyKey, setBusyKey] = useState(null as string | null)
  const [errs, setErrs] = useState({} as Record<string, string | null>)
  const state = costStore?.state
  const api = props.api
  if (!state) return null
  const config = state.config
  const strip = config.quotaStrip ?? { enabled: false, budget: true, go: true, plans: true }
  if (strip.enabled !== true) return null
  const t: T = makeT(resolveLocale(config))
  const chips: any[] = []
  // 预算 chip:与预算图框同口径(≥80% 预警、≥100% 超支);点击 reload 重取状态(issue #52)。
  if (strip.budget !== false) {
    const budget = config.budget ?? { enabled: false, amount: 100, period: 'month' }
    if (budget.enabled === true) {
      const rate = Number(config.exchangeRate)
      const usedUsd = state.budgetUsed ?? (
        budget.period === 'day' ? displayCostOf(state.today, config)
          : budget.period === 'all' ? displayCostOf(state.total, config)
            : displayCostOf(state.month, config))
      const used = usedUsd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
      const amount = Math.max(0, Number(budget.amount) || 0)
      if (amount > 0) {
        const pct = Math.min(999, used / amount * 100)
        const level = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
        chips.push({
          key: 'budget',
          label: t('budgetShort'),
          level,
          tip: t('budgetOf', { period: t(PERIOD_KEYS[budget.period] ?? 'periodMonth') }) + ' · '
            + t('usedOf', { used: formatMoneyValue(used, config), amount: formatMoneyValue(amount, config) })
            + ' · ' + pct.toFixed(1) + '%',
          // 迷你条与对应图框同方向(issue #67):remaining 时填充剩余%。
          segs: [{ name: 'main', pct: Math.round(simpleBarByDirection(Math.min(100, pct), barDirectionOf(config, 'budget')).width) }],
        })
      }
    }
  }
  // Go chip:主窗口一档(与右下角 chips 的主窗口口径一致)。
  if (strip.go !== false) {
    const goQuota = state.goQuota
    if (config?.goQuota?.enabled !== false && goQuota?.status === 'ok') {
      const mainKey = config.goQuota.main === 'weekly' || config.goQuota.main === 'monthly' ? config.goQuota.main : 'rolling'
      const win = mainKey === 'rolling' ? goQuota.rolling : mainKey === 'weekly' ? goQuota.weekly : goQuota.monthly
      if (win !== null && typeof win === 'object' && typeof win.percent === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(Number(win.percent) || 0)))
        const level = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
        const resets = typeof win.resetsAt === 'string' && win.resetsAt.length > 0
          ? ' · ' + t('goResetAt', { time: new Date(win.resetsAt).toLocaleString() }) : ''
        chips.push({
          key: 'go',
          label: 'Go ' + t(mainKey === 'rolling' ? 'goShortRolling' : mainKey === 'weekly' ? 'goShortWeekly' : 'goShortMonthly'),
          level,
          tip: 'Go: ' + pct + '%' + resets,
          segs: [{ name: 'main', pct: Math.round(simpleBarByDirection(pct, barDirectionOf(config, 'go')).width) }],
        })
      }
    }
  }
  // Coding Plan chip:每家厂商一条(多窗口融合为段,竖线分隔;点击刷新整家,issue #52)。
  if (strip.plans !== false) {
    for (const rowDef of CODING_PLAN_ROWS) {
      const live = state.codingPlans?.[rowDef.id]
      if (config.codingPlans?.[rowDef.id]?.enabled !== true || !live || live.status !== 'ok') continue
      const windows = live.windows !== null && typeof live.windows === 'object' ? live.windows : {}
      const entries = Object.entries(windows)
      if (entries.length === 0) continue
      const vendor = STRIP_VENDOR_SHORT[rowDef.id] ?? rowDef.id
      const segs: any[] = []
      const detailParts: string[] = []
      let worst = 0 // 0 ok < 1 warn < 2 over;chip 告警级别取所有窗口的最差
      let shown = 0
      for (const [name, win] of entries) {
        const w = win as any
        const label = codingPlanWindowLabel(name, t)
        const reset = typeof w?.resetsAt === 'string' && w.resetsAt.length > 0
          ? ' · ' + t('goResetAt', { time: new Date(w.resetsAt).toLocaleString() }) : ''
        const pct = win !== null && typeof win === 'object' && typeof w.percent === 'number'
          ? Math.max(0, Math.min(100, Math.round(Number(w.percent) || 0))) : null
        detailParts.push(label + ' '
          + (pct === null ? (typeof w?.text === 'string' ? w.text : '—') : pct + '%') + reset)
        if (pct === null) {
          // 文本窗口(余额等无百分比的量):以文本段展示,不占进度条名额。
          segs.push({ name, pct: null, text: typeof w?.text === 'string' ? w.text : '—' })
          continue
        }
        if (shown >= 2) continue // 每家最多两个百分比段,更多窗口进悬停提示
        shown += 1
        segs.push({ name, pct: Math.round(simpleBarByDirection(pct, barDirectionOf(config, 'plan')).width) })
        worst = Math.max(worst, pct >= 100 ? 2 : pct >= 80 ? 1 : 0)
      }
      if (live.fetchedAt > 0) detailParts.push(t('goQuotaFetchedAt', { time: new Date(live.fetchedAt).toLocaleTimeString() }))
      if (segs.length === 0) continue
      chips.push({
        key: rowDef.id,
        label: vendor,
        level: ['ok', 'warn', 'over'][worst],
        tip: detailParts.join('; '),
        segs,
      })
    }
  }
  // Codex chip(issue #59):dsh-codex-connect 在位且已登录时出现;已用口径与各家一致。
  // 独立于 Coding Plan 开关:即使 strip.plans 为 false,Codex chip 仍应渲染。
  const codexWin = config.codexQuotaEnabled === true && codexQuotaCache.status === 'ok' ? codexQuotaCache.windows.weekly ?? null : null
  if (codexWin !== null && typeof codexWin.percent === 'number') {
    const pct = Math.max(0, Math.min(100, Math.round(Number(codexWin.percent) || 0)))
    const resets = typeof codexWin.resetsAt === 'string' && codexWin.resetsAt.length > 0
      ? ' · ' + t('goResetAt', { time: new Date(codexWin.resetsAt).toLocaleString() }) : ''
    chips.push({
      key: 'codex',
      label: 'Codex',
      level: pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok',
      tip: t('codexQuotaTitle') + ': ' + pct + '%' + resets,
      segs: [{ name: 'weekly', pct: Math.round(simpleBarByDirection(pct, barDirectionOf(config, 'plan')).width) }],
    })
  }
  if (chips.length === 0) return null
  // 点击 chip 即刷新对应数据源(issue #52):budget → getState、go → Go 额度、
  // codex → 客户端重探 dsh-codex-connect(issue #59)、厂商 → 该家 Coding Plan 全部窗口
  // 一次刷新;busy 互斥防连点。
  const doRefresh = (key: string) => {
    if (busyKey !== null || !api) return
    setBusyKey(key)
    setErrs(m => ({ ...m, [key]: null }))
    Promise.resolve()
      .then(() => (key === 'budget' ? api.reload()
        : key === 'go' ? api.refreshGoQuota()
          : key === 'codex' ? fetchCodexQuota(true, config.codexQuotaEnabled === true)
            : api.refreshCodingPlan(key)))
      .catch((error: any) => { setErrs(m => ({ ...m, [key]: error?.message ?? String(error) })) })
      .finally(() => setBusyKey(null))
  }
  return el('div', { className: 'cm-qstrip' },
    chips.map(c => {
      const busy = busyKey === c.key
      const err = errs[c.key]
      const kids: any[] = [el('span', { className: 'cm-qlabel', key: 'l' }, c.label)]
      if (busy) {
        kids.push(el('span', { className: 'cm-qtext', key: 'busy' }, t('refreshing')))
      } else {
        c.segs.forEach((s: any, i: number) => {
          if (i > 0) kids.push(el('span', { className: 'cm-qsep', key: 'sep' + i, 'aria-hidden': 'true' }))
          if (s.pct === null) {
            kids.push(el('span', { className: 'cm-qtext', key: s.name }, s.text))
          } else {
            kids.push(el('span', { className: 'cm-qseg', key: s.name },
              el('span', { className: 'cm-qbar' }, el('span', { className: 'cm-qfill', style: { width: s.pct + '%' } })),
              el('span', null, s.pct + '%')))
          }
        })
      }
      const tipLines = [c.tip]
      if (!busy && api) tipLines.push(t('clickToRefresh'))
      if (busy) tipLines.push(t('refreshing'))
      if (err) tipLines.push('⚠ ' + t('balanceRefreshFailed', { message: err }))
      return el(Tooltip, { key: c.key, label: tipLines.join('; '), side: 'bottom', delayMs: 400 },
        el('span', {
          className: 'cm-qchip' + (api ? ' action' : '') + (c.level === 'ok' ? '' : ' ' + c.level),
          ...(api ? clickableRefreshProps(busy, () => doRefresh(c.key)) : {}),
        }, kids))
    }))
}
