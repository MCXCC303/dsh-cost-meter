/**
 * 自定义 Provider 余额卡片(单条/多配置形态)。
 *
 * 迁移自原 `02-validators-helpers-sidebar.js` 1731–1880 行:
 * `resolveCustomBalanceLabel` / `customBalanceUnitOf` / `formatCustomBalanceMoney` /
 * `customBalanceDetailText` / `customBalanceBoxBody` / `visibleCustomEntries` /
 * `CustomBalanceBox` / `CustomBalanceEntryBox` / `CustomBalanceRowContent` /
 * `CustomBalanceEntryRow`。
 *
 * 多配置形态(v1.7.0,issue #79):`unit` / `label` 优先读条目自身配置,旧单条
 * `customBalance` 作为回落(兼容旧快照/旧宿主);渲染助手按「单条快照 + 单条配置」
 * 参数化(custom, entryCfg)。
 *
 * 注意:本模块与 ui-balance.ts 互为 import(那边用 customBalanceUnitOf,这边用
 * segmentsForCustomBalance/BalanceBar/点击刷新一族);导出的都是函数声明,调用
 * 发生在渲染期,ESM 循环安全。
 */

import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { barDirectionOf, emptyCustomSnapshot, fixedAmount, formatMoneyValue } from './logic.js'
import { makeT, resolveLocale } from './t.js'
import { BalanceBar, balanceBarTooltipLines, clickableRefreshProps, clickRefreshTipLines, segmentsForCustomBalance, useClickRefresh } from './ui-balance.js'
import { WalletIcon } from './ui-credential.js'

const { createElement: el, Fragment } = React

/** 自定义余额标题:中英配置取当前语言,缺省回落内置文案。 */
export function resolveCustomBalanceLabel(cfg: any, locale: string): string {
  const zh = typeof cfg?.label === 'string' ? cfg.label : ''
  const en = typeof cfg?.labelEn === 'string' ? cfg.labelEn : ''
  if (locale === 'en') return en || zh || 'Custom balance'
  return zh || en || '自定义余额'
}

// 多配置形态(v1.7.0,issue #79):unit/label 优先读条目自身配置,旧单条
// customBalance 作为回落(兼容旧快照/旧宿主)。

/**
 * 解析条目记账单位:条目配置 > 旧单条配置 > 快照单位 > USD。
 *
 * TODO(types): config 为插件配置,custom 为快照,entryCfg 为多配置条目(可空)。
 */
export function customBalanceUnitOf(config: any, custom: any, entryCfg: any = null): string {
  if ((entryCfg ?? config?.customBalance)?.adapter === 'aliyun' && ['CNY', 'USD', 'EUR'].includes(custom?.unit)) return custom.unit
  const unit = entryCfg?.unit ?? config?.customBalance?.unit
  if (['CNY', 'EUR', 'USD', 'CREDITS'].includes(unit)) return unit
  return ['CNY', 'EUR', 'CREDITS'].includes(custom?.unit) ? custom.unit : 'USD'
}

/**
 * 自定义余额金额格式化:仅在显示层换算,快照/预算单位/进度比例始终保留源币种。
 */
export function formatCustomBalanceMoney(amount: any, config: any, custom: any, entryCfg: any = null): string {
  const unit = customBalanceUnitOf(config, custom, entryCfg)
  const value = Number(amount)
  if (!Number.isFinite(value)) return '—'
  // 仅在显示层换算,快照、预算单位和进度比例始终保留源币种。
  const rate = config?.currency === 'USD' ? 1 : Number(config?.exchangeRate)
  if ((entryCfg ?? config?.customBalance)?.convertToDisplayCurrency === true && unit === 'USD' && Number.isFinite(rate) && rate > 0) {
    const converted = value * rate
    return Number.isFinite(converted) ? formatMoneyValue(converted, config) : '—'
  }
  const credits = unit === 'CREDITS'
  const decimals = Math.max(2, Math.min(6, Math.floor(Number(config?.decimals) || 4)))
  const symbol = credits ? '' : unit === 'CNY' ? '¥' : unit === 'EUR' ? '€' : '$'
  return symbol + fixedAmount(value, decimals) + (credits ? ' Credits' : '')
}

/**
 * 自定义余额 tooltip 文本:开了进度条走余额条口径,否则走「剩余/已用/上限」行。
 *
 * TODO(types): t 为翻译函数,state 为宿主 cost store 快照。
 */
export function customBalanceDetailText(custom: any, config: any, t: any, state: any, entryCfg: any = null): string {
  const remaining = formatCustomBalanceMoney(custom.remaining, config, custom, entryCfg)
  const formatAmt = (v: any) => formatCustomBalanceMoney(v, config, custom, entryCfg)
  if (state && config.balance?.showProgressBar === true) {
    const segments = segmentsForCustomBalance(state, config, custom, entryCfg)
    return [
      balanceBarTooltipLines(t, formatAmt, segments, remaining, segments.cap),
      t('updatedAt', { time: custom.fetchedAt > 0 ? new Date(custom.fetchedAt).toLocaleTimeString() : '—' }),
    ].join(' · ')
  }
  const spend = custom.spend !== null ? formatAmt(custom.spend) : '—'
  const maxBudget = custom.maxBudget !== null ? formatAmt(custom.maxBudget) : '—'
  const manualCap = customBalanceUnitOf(config, custom, entryCfg) === 'CREDITS' ? NaN : Number(config?.balance?.budgetCap)
  const capLine = Number.isFinite(manualCap) && manualCap > 0
    ? t('balanceBudgetCapLabel') + ': ' + formatAmt(manualCap)
    : ''
  const base = custom.maxBudget !== null && custom.spend !== null
    ? t('customBalanceLine', {
      remaining,
      spend,
      maxBudget,
      time: custom.fetchedAt > 0 ? new Date(custom.fetchedAt).toLocaleTimeString() : '—',
    })
    : t('customBalanceRemaining', { amount: remaining })
  return capLine ? base + ' · ' + capLine : base
}

/**
 * 自定义余额图框内容(宽屏正文 + rail 百分比)。
 *
 * TODO(types): 返回 { level, rail, body },level 目前恒为 'ok'(保留旧结构)。
 */
export function customBalanceBoxBody(state: any, config: any, t: any, custom: any, entryCfg: any = null) {
  const label = resolveCustomBalanceLabel(entryCfg ?? config.customBalance ?? {}, resolveLocale(config))
  const remaining = formatCustomBalanceMoney(custom.remaining, config, custom, entryCfg)
  const segments = segmentsForCustomBalance(state, config, custom, entryCfg)
  return {
    level: 'ok',
    rail: Math.round(segments.remainingPct) + '%',
    body: el(Fragment, null,
      el('div', { className: 'cm-bbox-head' },
        el('span', { className: 'cm-bbox-label' }, label),
        el('span', { className: 'cm-bbox-pct cm-num cm-bal-amt' }, remaining)),
      el(BalanceBar, { segments, direction: barDirectionOf(config, 'balance') })),
  }
}

// 多配置形态(v1.7.0,issue #79):Box/Row 逐条渲染。可见条目 = 配置数组中
// enabled 且 display 允许侧边栏的条目;快照缺失(未查询/查询失败)按各自状态
// 渲染。旧宿主快照(无 customBalances)由 parseConfig 回落单条包装,行为不变。

/**
 * 侧边栏要渲染的自定义余额条目(配置 ∩ 快照)。
 *
 * TODO(types): 待 parseConfig 的 CustomBalanceEntry 类型统一后收紧。
 */
export function visibleCustomEntries(state: any, config: any) {
  const entries = config?.customBalances ?? []
  const snapshots = Array.isArray(state?.customBalances) ? state.customBalances : []
  const out: Array<{ index: number | null; entry: any; snapshot: any }> = []
  entries.forEach((entry: any, index: number) => {
    if (entry?.enabled !== true) return
    if (entry.display !== 'sidebar' && entry.display !== 'both') return
    const snapshot = snapshots.find((s: any) => s.index === index)
      ?? (snapshots.length === 1 && entries.length === 1 ? snapshots[0] : null)
    out.push({ index, entry, snapshot })
  })
  // 旧宿主快照(无数组):回落旧单条状态,保持升级前显示。
  if (out.length === 0 && snapshots.length === 0 && config?.customBalance?.enabled === true
    && (config.customBalance.display === 'sidebar' || config.customBalance.display === 'both')
    && state?.customBalance?.status && state.customBalance.status !== 'off') {
    out.push({ index: null, entry: config.customBalance, snapshot: state.customBalance })
  }
  return out
}

/**
 * 自定义余额图框列表(按可见条目逐条渲染)。
 *
 * TODO(types): props = { state, wide, api }。
 */
export function CustomBalanceBox(props: any) {
  const { state, wide, api } = props
  const config = state.config
  const t = makeT(resolveLocale(config))
  const visible = visibleCustomEntries(state, config)
  if (visible.length === 0) return null
  return el(Fragment, null, visible.map(({ index, entry, snapshot }) =>
    el(CustomBalanceEntryBox, { key: 'cb-' + index, state, wide, api, t, index, entry, snapshot })))
}

/**
 * 单条自定义余额图框。
 *
 * 注意:原实现即「无快照早退 → 再调 Hook」,迁移期保持原状不动(避免行为变化)。
 */
export function CustomBalanceEntryBox(props: any) {
  const { state, wide, api, t, index, entry, snapshot } = props
  const config = state.config
  // 无快照(尚未查询)不渲染图框;error/off 状态由行组件渲染提示。
  if (snapshot === null || snapshot === undefined || snapshot.status !== 'ok') return null
  const refresh = useClickRefresh(api ? () => api.refreshCustomBalance(index) : null)
  const view = customBalanceBoxBody(state, config, t, snapshot, entry)
  const detail = [customBalanceDetailText(snapshot, config, t, state, entry), ...clickRefreshTipLines(t, refresh)].join(' · ')
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-bbox clickable' + (view.level === 'ok' ? '' : ' ' + view.level) + (wide ? '' : ' rail') + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
      wide ? view.body : el('div', { className: 'cm-bbox-rail cm-num' }, view.rail)))
}

/** 自定义余额行列表(页脚 rail)。 */
export function CustomBalanceRowContent(props: any) {
  const { state, wide, api } = props
  const config = state.config
  const t = makeT(resolveLocale(config))
  const visible = visibleCustomEntries(state, config)
  if (visible.length === 0) return null
  return el(Fragment, null, visible.map(({ index, entry, snapshot }) =>
    el(CustomBalanceEntryRow, { key: 'cbr-' + index, state, wide, api, t, index, entry, snapshot })))
}

/**
 * 单条自定义余额行(宽屏显示标题 + 金额,rail 显示钱包图标)。
 *
 * 注意:原实现即「status=off 早退 → 再调 Hook」,迁移期保持原状不动。
 */
export function CustomBalanceEntryRow(props: any) {
  const { state, wide, api, t, index, entry, snapshot } = props
  const config = state.config
  const custom = snapshot ?? emptyCustomSnapshot(index)
  if (custom.status === 'off') return null
  const refresh = useClickRefresh(api ? () => api.refreshCustomBalance(index) : null)
  const label = resolveCustomBalanceLabel(entry ?? config.customBalance ?? {}, resolveLocale(config))
  if (custom.status === 'error') {
    return el(Tooltip, { label: [custom.message || t('unknownError'), ...clickRefreshTipLines(t, refresh)].join('; '), side: 'right', delayMs: 300 },
      el('div', { className: 'cm-foot clickable' + (wide ? '' : ' cm-foot-rail') + ' cm-bal-err' + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
        wide ? el(Fragment, null, el('span', { className: 'cm-bal-label', title: label }, label), el('span', { className: 'cm-num cm-bal-amt' }, t('queryFailed'))) : '⚠'))
  }
  const amount = formatCustomBalanceMoney(custom.remaining, config, custom, entry)
  const detail = [customBalanceDetailText(custom, config, t, state, entry), ...clickRefreshTipLines(t, refresh)].join(' · ')
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-foot clickable' + (wide ? '' : ' cm-foot-rail') + (refresh.busy ? ' busy' : ''), ...clickableRefreshProps(refresh.busy, refresh.run) },
      wide ? el(Fragment, null, el('span', { className: 'cm-bal-label', title: label }, label), el('span', { className: 'cm-num cm-bal-amt' }, amount)) : el(WalletIcon, { size: 16 })))
}
