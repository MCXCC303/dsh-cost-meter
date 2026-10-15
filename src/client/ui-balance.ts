/**
 * 侧边栏余额:余额行、余额图框与分段计算。
 *
 * 迁移自原 `02-validators-helpers-sidebar.js` 1508–1729 行:
 * `BALANCE_CURRENCY_SYMBOLS` / `formatBalanceMoney` / `resolveBalanceCap` /
 * `todayOfficialUsd` / `todayUsedInBalanceCurrency` / `computeBalanceSegments` /
 * `segmentsForCustomBalance` / `segmentsForOfficialBalance` / `BalanceBar` /
 * `balanceBarTooltipLines` / `useClickRefresh` / `clickableRefreshProps` /
 * `clickRefreshTipLines` / `DEEPSEEK_RECHARGE_URL` / `rechargeLinkEl` /
 * `BalanceRowContent` / `BalanceBox`。
 *
 * 注意:`customBalanceUnitOf` 属自定义余额模块(ui-custom-balance.ts),这里按
 * 归属反向 import,形成 ui-balance ↔ ui-custom-balance 的循环依赖;两侧导出的
 * 都是函数声明(调用发生在渲染期,不在模块初始化期),ESM 循环安全。
 *
 * 余额是官方接口返回的记账币种金额(如 CNY),不经过汇率换算;`state` /
 * `config` 来自宿主注入,边界先按 any 收口。
 */

// TODO(types): 平台种子 react 由 src/client/seeds.d.ts 以 any 兜底,待补真实类型后收紧。
import React from 'react'
// TODO(types): ui-primitives 仅取 Tooltip,待补真实类型后收紧。
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { barDirectionOf, formatMoneyValue } from './logic.js'
import { makeT, resolveLocale } from './t.js'
import { WalletIcon } from './ui-credential.js'
import { customBalanceUnitOf } from './ui-custom-balance.js'

const { createElement: el, Fragment, useState } = React

/** 记账币种代码 → 符号(官方/自定义余额金额不经汇率换算,符号必须与数值同币种)。 */
export const BALANCE_CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€' }

/**
 * 用记账币种格式化余额金额。
 *
 * TODO(types): config 为插件配置(prices/decimals/symbol),currency 为服务端下发的币种代码。
 */
export function formatBalanceMoney(value: any, config: any, currency: any): string {
  // 余额是官方接口返回的记账币种金额(如 CNY),不经过汇率换算;
  // 此前恒用显示币种符号(¥53 渲染成 $53),数值未换算而符号错位近汇率倍。
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  const fallbackSymbol = typeof config?.symbol === 'string' && config.symbol.length > 0 ? config.symbol : '$'
  return formatMoneyValue(value, {
    symbol: BALANCE_CURRENCY_SYMBOLS[code] ?? fallbackSymbol,
    decimals: Math.max(2, Math.min(10, Math.floor(Number(config?.decimals) || 2))),
  })
}

/**
 * 解析余额图框上限:手动配置优先,其次接口返回的 maxBudget;无上限返回 null。
 *
 * TODO(types): custom 为自定义余额快照(含 maxBudget)。
 */
export function resolveBalanceCap(config: any, custom: any): number | null {
  const manual = Number(config?.balance?.budgetCap)
  if (Number.isFinite(manual) && manual > 0) return manual
  const apiMax = Number(custom?.maxBudget)
  if (Number.isFinite(apiMax) && apiMax > 0) return apiMax
  return null
}

// issue #36:官方余额进度条的「当日已用」只统计会扣 DeepSeek 开放平台余额的调用
// (byProviderModel 中 provider 前缀为官方渠道的条目:账本记账时未标注 provider 的
// 'deepseek'、API Key 路由 'deepseek-official' 与 Desktop 登录账号路由
// 'deepseek-account';宿主 llm- 前缀与裸名同义,一并剥离,与服务端同口径)。
// Coding Plan / 自定义 Provider 等渠道的费用只体现在各自的额度条/余额条上。
// 账本无按渠道拆分的旧数据(byProviderModel 缺失/为空)退回全量,保持升级前行为。
export function todayOfficialUsd(state: any): number {
  const today = state.today
  const by = today?.byProviderModel
  if (by === null || typeof by !== 'object' || Object.keys(by).length === 0) return Number(today?.cost) || 0
  let sum = 0
  for (const [key, value] of Object.entries(by) as [string, any][]) {
    const idx = key.indexOf(':')
    let provider = idx >= 0 ? key.slice(0, idx) : key
    if (provider.startsWith('llm-')) provider = provider.slice(4)
    if (!/^deepseek(?:-official|-account)?$/.test(provider)) continue
    sum += Number(value?.cost) || 0
  }
  return sum
}

/**
 * 今日已用(按余额所在币种):官方模式只取 deepseek 渠道费用;自定义模式维持全量。
 *
 * TODO(types): mode 为 'official' | 'custom',entryCfg 为多配置形态的条目配置。
 */
export function todayUsedInBalanceCurrency(state: any, config: any, mode: string, custom: any, entryCfg: any = null): number {
  // 官方模式只取 deepseek 渠道费用;自定义 Provider 余额无渠道映射,维持全量(与既有行为一致)。
  const usd = mode === 'official' ? todayOfficialUsd(state) : Number(state.today?.cost) || 0
  const unit = mode === 'custom' ? customBalanceUnitOf(config, custom, entryCfg) : state.balance?.currency
  if (unit === 'USD') return usd
  // 积分不能由美元花费换算。
  if (unit === 'CREDITS') return 0
  const rate = Number(config?.exchangeRate)
  return usd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
}

/** 余额条三段(剩余/今日/往期)百分比;无上限时占满剩余段。 */
export function computeBalanceSegments({ remaining, spend, todayUsed, cap }: { remaining: any; spend: any; todayUsed: any; cap: number | null }) {
  if (cap === null || cap <= 0) {
    return { remainingPct: 100, todayPct: 0, spentPct: 0, hasCap: false, pastSpend: 0, today: 0 }
  }
  const rem = Math.max(0, Number(remaining) || 0)
  const totalSpend = Math.max(0, Number(spend) || 0)
  const today = Math.max(0, Math.min(totalSpend, Number(todayUsed) || 0))
  const pastSpend = Math.max(0, totalSpend - today)
  const remainingPct = Math.max(0, Math.min(100, rem / cap * 100))
  const todayPct = Math.max(0, Math.min(100 - remainingPct, today / cap * 100))
  const spentPct = Math.max(0, Math.min(100 - remainingPct - todayPct, pastSpend / cap * 100))
  return { remainingPct, todayPct, spentPct, hasCap: true, pastSpend: pastSpend, today }
}

/**
 * 自定义 Provider 余额的分段(上限只认同响应/同条目的 maxBudget,积分除外)。
 *
 * TODO(types): custom 缺省时回落 state.customBalance(旧宿主快照形态)。
 */
export function segmentsForCustomBalance(state: any, config: any, custom: any = null, entryCfg: any = null) {
  const target = custom ?? state.customBalance
  // 全局 budgetCap 是货币金额,不适用于积分;积分只接受同一响应的上限。
  const cap = resolveBalanceCap(customBalanceUnitOf(config, target, entryCfg) === 'CREDITS' ? null : config, target)
  const remaining = Number(target?.remaining) || 0
  const spend = Number(target?.spend) || 0
  const todayUsed = todayUsedInBalanceCurrency(state, config, 'custom', target, entryCfg)
  return { cap, ...computeBalanceSegments({ remaining, spend, todayUsed, cap }) }
}

/** 官方余额的分段:上限用全局 budgetCap,已花 = 上限 − 剩余。 */
export function segmentsForOfficialBalance(state: any, config: any) {
  const balance = state.balance
  const cap = resolveBalanceCap(config, null)
  const remaining = Number(balance?.totalBalance) || 0
  const todayUsed = todayUsedInBalanceCurrency(state, config, 'official', null)
  const spend = cap !== null ? Math.max(0, cap - remaining) : 0
  return { cap, ...computeBalanceSegments({ remaining, spend, todayUsed, cap }) }
}

/**
 * 余额分段条(剩余/今日/往期三段,支持 used 方向反转)。
 *
 * TODO(types): segments 为 computeBalanceSegments 的返回值;direction 为
 * 'remaining' | 'used'(issue #67)。
 */
export function BalanceBar(props: any) {
  const { segments, direction = 'remaining' } = props
  const { remainingPct, todayPct, spentPct } = segments
  const kids: any[] = []
  if (remainingPct > 0) kids.push(el('div', { className: 'cm-bbox-fill', style: { width: remainingPct + '%' } }))
  if (todayPct > 0) kids.push(el('div', { className: 'cm-bbox-seg-today', style: { width: todayPct + '%' } }))
  if (spentPct > 0) kids.push(el('div', { className: 'cm-bbox-seg-spent', style: { width: spentPct + '%' } }))
  if (kids.length === 0) kids.push(el('div', { className: 'cm-bbox-fill', style: { width: '100%' } }))
  // 已用方向(issue #67):分段顺序反转——消耗段从左端推进、剩余退到右端;
  // 默认(剩余方向)保持蓝在左、消耗从右端生长的原设计。
  const ordered = direction === 'used' ? [...kids].reverse() : kids
  return el('div', { className: 'cm-bbox-bar segments' + (direction === 'used' ? ' rev' : '') }, ...ordered)
}

/**
 * 余额条 tooltip 行(剩余 + 今日已用 + 往期消耗 + 预算上限)。
 *
 * TODO(types): t 为翻译函数,formatAmount 为币种格式化闭包,segments 为分段结果。
 */
export function balanceBarTooltipLines(t: any, formatAmount: any, segments: any, remainingAmount: any, cap: any): string {
  const lines = [t('balanceBarRemaining', { amount: remainingAmount })]
  if (segments.today > 0) lines.push(t('balanceBarToday', { amount: formatAmount(segments.today) }))
  if (segments.pastSpend > 0) lines.push(t('balanceBarSpent', { amount: formatAmount(segments.pastSpend) }))
  if (cap !== null && cap > 0) lines.push(t('balanceBudgetCapLabel') + ': ' + formatAmount(cap))
  return lines.join(' · ')
}

/**
 * 点击立即刷新(issue #37):侧边栏余额/额度图框点击触发一次手动刷新;
 * busy 期间忽略连点防并发;失败保持原值(fast-fail 抛错不会写入 store),
 * 错误信息供 tooltip 展示,下次刷新开始时清除。
 *
 * TODO(types): call 为宿主 RPC 刷新闭包(可能为 null,表示 API 不可用)。
 */
export function useClickRefresh(call: any): { busy: boolean; err: string | null; run: () => void } {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const run = () => {
    if (busy || typeof call !== 'function') return
    setBusy(true)
    setErr(null)
    Promise.resolve().then(call)
      .catch((error: any) => { setErr(error?.message ?? String(error)) })
      .finally(() => { setBusy(false) })
  }
  return { busy, err, run }
}

/** 可点击图框的通用 a11y/事件属性(键盘 Enter/Space 同样触发;aria-busy 标记刷新中)。 */
export const clickableRefreshProps = (busy: any, run: any) => ({
  role: 'button',
  tabIndex: 0,
  'aria-busy': busy ? 'true' : 'false',
  onClick: run,
  onKeyDown: (event: any) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run() }
  },
})

/** 点击刷新的 tooltip 附加行:提示语 + 刷新中 + 最近一次失败原因。 */
export function clickRefreshTipLines(t: any, refresh: any): string[] {
  const lines = [t('clickToRefresh')]
  if (refresh.busy) lines.push(t('refreshing'))
  if (refresh.err) lines.push('⚠ ' + t('balanceRefreshFailed', { message: refresh.err }))
  return lines
}

// DeepSeek 充值直达(issue #59):官方余额旁的「↗」新开平台账单/充值页;
// stopPropagation 避免触发外层图框的点击刷新(issue #37)。
export const DEEPSEEK_RECHARGE_URL = 'https://platform.deepseek.com/usage'

/** 官方余额旁的充值直达链接(新窗口打开,阻止事件冒泡)。 */
export function rechargeLinkEl(t: any) {
  return el('a', {
    className: 'cm-bal-link',
    href: DEEPSEEK_RECHARGE_URL,
    target: '_blank',
    rel: 'noreferrer noopener',
    title: t('balanceRechargeLink'),
    'aria-label': t('balanceRechargeLink'),
    onClick: (event: any) => event.stopPropagation(),
    onKeyDown: (event: any) => event.stopPropagation(),
  }, el('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    el('path', { d: 'M8 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4M11 3h6v6M9 11l8-8' })))
}

/**
 * 余额行(侧边栏页脚):宽屏显示「余额 + 金额」,窄屏(rail)显示钱包图标。
 *
 * TODO(types): props = { state, wide, api },state 为宿主 cost store 快照。
 */
export function BalanceRowContent(props: any) {
  const { state, wide, api } = props
  const balance = state.balance
  const t = makeT(resolveLocale(state.config))
  const refresh = useClickRefresh(api ? () => api.refreshBalance() : null)
  if (!balance || balance.status === 'off') return null
  if (balance.status === 'error') {
    return el(Tooltip, { label: [t('balanceQueryFailed', { message: balance.message || t('unknownError') }), ...clickRefreshTipLines(t, refresh)].join('; '), side: 'right', delayMs: 300 },
      el('div', { className: 'cm-foot clickable' + (wide ? '' : ' cm-foot-rail') + ' cm-bal-err' + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
        wide ? el(Fragment, null, t('balance'), ' ', el('span', { className: 'cm-num' }, t('queryFailed'))) : '⚠'))
  }
  const detail = [
    t('balanceTitle'),
    t('totalBalance', { amount: formatBalanceMoney(balance.totalBalance, state.config, balance.currency) }),
    t('grantedToppedUp', {
      granted: formatBalanceMoney(balance.grantedBalance, state.config, balance.currency),
      toppedUp: formatBalanceMoney(balance.toppedUpBalance, state.config, balance.currency),
    }),
    t('updatedAt', { time: balance.fetchedAt > 0 ? new Date(balance.fetchedAt).toLocaleTimeString() : '—' }),
    ...(state.reconcile?.ok === false ? ['⚠ ' + state.reconcile.message] : []),
    ...clickRefreshTipLines(t, refresh),
  ].join('; ')
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-foot clickable' + (wide ? '' : ' cm-foot-rail') + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
      wide ? el(Fragment, null, el('span', { className: 'cm-balance-name' }, t('balance'), rechargeLinkEl(t)), el('span', { className: 'cm-num cm-bal-amt' }, formatBalanceMoney(balance.totalBalance, state.config, balance.currency)), state.reconcile?.ok === false ? ' ⚠' : '') : el(WalletIcon, { size: 16 })))
}

/**
 * 官方余额图框(宽屏显示进度条,rail 显示剩余百分比)。
 *
 * TODO(types): props = { state, wide, api }。
 */
export function BalanceBox(props: any) {
  const { state, wide, api } = props
  const config = state.config
  const balance = state.balance
  const t = makeT(resolveLocale(config))
  const refresh = useClickRefresh(api ? () => api.refreshBalance() : null)
  if (!balance || balance.status !== 'ok') return null
  const segments = segmentsForOfficialBalance(state, config)
  const remaining = formatBalanceMoney(balance.totalBalance, config, balance.currency)
  const formatAmt = (v: any) => formatBalanceMoney(v, config, balance.currency)
  const detail = [
    t('balanceTitle'),
    balanceBarTooltipLines(t, formatAmt, segments, remaining, segments.cap),
    t('grantedToppedUp', {
      granted: formatBalanceMoney(balance.grantedBalance, config, balance.currency),
      toppedUp: formatBalanceMoney(balance.toppedUpBalance, config, balance.currency),
    }),
    t('updatedAt', { time: balance.fetchedAt > 0 ? new Date(balance.fetchedAt).toLocaleTimeString() : '—' }),
    ...(state.reconcile?.ok === false ? ['⚠ ' + state.reconcile.message] : []),
    ...clickRefreshTipLines(t, refresh),
  ].join('; ')
  const body = el(Fragment, null,
    el('div', { className: 'cm-bbox-head' },
      el('span', { className: 'cm-balance-name' }, el('span', { className: 'cm-bbox-label' }, t('balance')), rechargeLinkEl(t)),
      el('span', { className: 'cm-bbox-pct cm-num cm-bal-amt' }, remaining)),
    el(BalanceBar, { segments, direction: barDirectionOf(config, 'balance') }))
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-bbox clickable' + (wide ? '' : ' rail') + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
      wide ? body : el('div', { className: 'cm-bbox-rail cm-num' }, Math.round(segments.remainingPct) + '%')))
}
