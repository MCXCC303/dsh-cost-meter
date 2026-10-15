/**
 * 侧栏页脚:今日费用行、预算图框内容、以及整个 footer 的编排。
 *
 * 这是「一进页面就要显示」的核心部分,由启动包 index.ts 注册到
 * `sidebar.footer.action`;各额度卡片、余额、峰谷条都从这里组装。
 */
import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

import { makeT, resolveLocale, PERIOD_KEYS } from './t.js'
// React 钩子/工厂:与旧片段同形,便于逐行对照。
const { createElement: el, Fragment, useState, useEffect, useRef } = React as any
import { sidebarTodayValue } from './today.js'
import { displayCostOf, formatMoneyUsd, formatMoneyValue, formatTokens, barDirectionOf, simpleBarByDirection } from './logic.js'
import { WalletIcon } from './ui-credential.js'
import { BalanceBox, BalanceRowContent } from './ui-balance.js'
import { CustomBalanceBox, CustomBalanceRowContent, visibleCustomEntries } from './ui-custom-balance.js'
import { peakNoticeEl, peakNoticeRailEl } from './ui-peak.js'
import {
  budgetBoxBody, goBoxBody, GoQuotaBox, MiniMaxPlanBox, CodingPlanBox,
  CodexPlanBox, GatewayQuotaBox, gatewaySidebarCards, QuotaStrip,
  useCodexQuota, CODING_PLAN_ROWS, codexQuotaCache,
} from './ui-quota.js'
import { useProjectionRefresh } from './ui-badge.js'
import { SidebarModelCosts } from './ui-sidebar-models.js'


export function BudgetBoxContent(props) {
  const { state, wide } = props
  const today = state.today
  const config = state.config
  const t = makeT(resolveLocale(config))
  const todayValue = sidebarTodayValue(today, config, t)
  const budget = config.budget ?? { enabled: false, amount: 100, period: 'month' }
  const rate = Number(config.exchangeRate)
  const budgetUsedUsd = state.budgetUsed ?? (
    budget.period === 'day' ? displayCostOf(state.today, config)
      : budget.period === 'all' ? displayCostOf(state.total, config)
        : displayCostOf(state.month, config))
  const used = budgetUsedUsd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
  const amount = Math.max(0, Number(budget.amount) || 0)
  const pct = amount > 0 ? Math.min(999, used / amount * 100) : null
  const level = pct === null ? 'ok' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'

  if (budget.enabled === true) {
    // 预算圆角方形图框(渲染在设置按钮上方、余额行下方)。
    const todayApi = displayCostOf(today, config)
    const todayUsed = todayApi * (Number.isFinite(rate) && rate > 0 ? rate : 1)
    const todayPct = amount > 0 ? Math.min(999, todayUsed / amount * 100) : null
    const detail = [
      t('budgetOf', { period: t(PERIOD_KEYS[budget.period] ?? 'periodMonth') }),
      t('usedOf', { used: formatMoneyValue(used, config), amount: formatMoneyValue(amount, config) })
        + ' · ' + (pct === null ? '—' : pct.toFixed(1) + '%'),
      // 今日金额行受 hideTodayCost 门控(issue #46)。
      ...(config.hideTodayCost === true ? [] : [config.sidebarTodayMetric === 'tokens'
        ? t('today') + ' ' + todayValue
        : t('todayShare', { amount: todayValue, pct: todayPct === null ? '—' : todayPct.toFixed(1) + '%' })]),
      t('monthTotal', {
        month: formatMoneyUsd(displayCostOf(state.month, config), config),
        total: formatMoneyUsd(displayCostOf(state.total, config), config),
      }),
    ].join('; ')
    if (props.summary === true) return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
      el('div', { className: 'cm-simple-summary' + (level === 'ok' ? '' : ' ' + level), tabIndex: 0 },
        el('span', null, t('todayBudget', { period: t(PERIOD_KEYS[budget.period] ?? 'periodMonth') })),
        el('span', { className: 'cm-num' }, todayValue + ' / ' + formatMoneyValue(amount, config))))
    const view = budgetBoxBody(state, config, t)
    return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
      el('div', { className: 'cm-bbox' + (level === 'ok' ? '' : ' ' + level) + (wide ? '' : ' rail') },
        wide ? view.body : el('div', { className: 'cm-bbox-rail cm-num' }, view.rail)))
  }

  const detail = [
    config.sidebarTodayMetric === 'tokens' ? t('todayTokensTitle') : t('todayCostTitle'),
    t('callsTokens', {
      calls: today.calls,
      input: formatTokens(today.input),
      cache: formatTokens(today.cacheRead + today.cacheWrite),
      output: formatTokens(today.output),
    }),
    t('monthCost', { amount: formatMoneyUsd(displayCostOf(state.month, config), config) }),
    t('totalCost', { amount: formatMoneyUsd(displayCostOf(state.total, config), config) }),
  ].join('; ')
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el(Fragment, null,
      el('div', { className: 'cm-foot' + (wide ? '' : ' cm-foot-rail') },
        wide ? el(Fragment, null, t('today'), ' ', el('span', { className: 'cm-num' }, todayValue)) : el(WalletIcon, { size: 16 })),
      wide ? peakNoticeEl(state, config, t) : null))
}

export function SidebarFooter(props) {
  const costStore = props.useCost ? props.useCost(s => s) : undefined
  useCodexQuota(costStore?.state?.config?.codexQuotaEnabled === true && costStore?.state?.config?.codexQuotaSidebar !== false)
  // 侧边栏页脚非会话作用域插槽:useProjection 在部分宿主/页面可能不可用或
  // 抛错(无活跃会话),try/catch 退化,联动刷新随之失效(60s 轮询兜底)。
  let projectionUsage
  if (props.useProjection) {
    try { projectionUsage = props.useProjection('costUsage') } catch { projectionUsage = undefined }
  }
  useProjectionRefresh(props, projectionUsage)
  const state = costStore?.state
  const wide = !!props.wide
  if (!state) return null
  const config = state.config
  const t = makeT(resolveLocale(config))
  const showBalance = (config.balance?.display === 'sidebar' || config.balance?.display === 'both')
    && config.hideOfficialBalance !== true
  // 多配置形态(v1.7.0,issue #79):可见性逐条判定(可见条目集由
  // visibleCustomEntries 统一给出;组件内部逐条按快照状态渲染)。
  const visibleCustom = visibleCustomEntries(state, config)
  const showCustomBalance = visibleCustom.length > 0
  const showBalanceBar = showBalance && config.balance?.showProgressBar === true && state.balance?.status === 'ok'
  const showCustomBalanceBar = showCustomBalance && config.balance?.showProgressBar === true
  const goMainKey = config.goQuota?.main === 'weekly' || config.goQuota?.main === 'monthly' ? config.goQuota.main : 'rolling'
  const goOk = (config.goQuota?.enabled !== false)
    && (config.goQuota?.display === 'sidebar' || config.goQuota?.display === 'both')
    && state.goQuota?.status === 'ok' && state.goQuota?.[goMainKey] !== null
  // Coding Plan 侧边栏卡片(issue #31):每家按 display 门控(侧边栏/两者),启用且查询成功才展示;
  // MiniMax 沿用专用 5h/7d 卡片(issue #57 起与通用卡片同为「已用」方向),其余厂商走通用 CodingPlanBox。
  const sidebarPlanIds = CODING_PLAN_ROWS
    .map(r => r.id)
    .filter(id => {
      const entry = config.codingPlans?.[id]
      if (entry?.enabled !== true) return false
      if (entry.display !== 'sidebar' && entry.display !== 'both') return false
      const live = state.codingPlans?.[id]
      if (live?.status !== 'ok') return false
      const wins = live.windows !== null && typeof live.windows === 'object' ? live.windows : {}
      return Object.keys(wins).length > 0
    })
  const plansOn = sidebarPlanIds.length > 0
  // 网关额度侧边栏卡片(issue #96):按来源 display 门控,卡片本体见 GatewayQuotaBox。
  const gatewayNodes = gatewaySidebarCards(state, config, wide, props.api)
  // Codex 周额度(issue #59):客户端探测 dsh-codex-connect,ok 时并入侧边栏;
  // 其余显示全关时也要为它保留渲染入口(模块装载即有被动探测,快照同步读)。
  const codexOn = config.codexQuotaEnabled === true && config.codexQuotaSidebar !== false && codexQuotaCache.status === 'ok'
    && codexQuotaCache.windows.weekly !== null
  const budgetOn = (config.budget ?? {}).enabled === true
  const showToday = config.sidebar !== false && config.hideTodayCost !== true
  const modelsOn = config.sidebarModels?.enabled === true
  if (!modelsOn && !showBalance && !showCustomBalance && !goOk && !plansOn && !codexOn && !budgetOn && !showToday && gatewayNodes.length === 0) return null
  // 紧凑模式(侧边栏进度条样式):宽栏下各额度卡内部的时间段进度行排两列
  // (CSS 于 .cm-footer-stack.compact 生效);卡片本身与收起(rail)态维持原样。
  const simple = config.sidebarSimple === true
  const compactWide = !simple && wide && config.sidebarStyle === 'compact'
  const mergedBudget = simple && wide && showToday && budgetOn
  // 节点为平台 createElement 的动态子元素列表(类型由宿主种子模块决定)。
  const nodes: unknown[] = []
  if (mergedBudget) nodes.push(el(BudgetBoxContent, { state, wide, summary: true }))
  else if (simple && wide && showToday) nodes.push(el('div', { className: 'cm-simple-summary' },
    el('span', null, t('today')), el('span', { className: 'cm-num' }, sidebarTodayValue(state.today, config, t))))
  if (showBalanceBar) nodes.push(el(BalanceBox, { state, wide, api: props.api }))
  else if (showBalance) nodes.push(el(BalanceRowContent, { state, wide, api: props.api }))
  if (showCustomBalanceBar) nodes.push(el(CustomBalanceBox, { state, wide, api: props.api }))
  else if (showCustomBalance) nodes.push(el(CustomBalanceRowContent, { state, wide, api: props.api }))
  const afterBalance = nodes.length
  if (plansOn) nodes.push(...sidebarPlanIds.map(id => id === 'minimax'
    ? el(MiniMaxPlanBox, { state, wide, api: props.api })
    : el(CodingPlanBox, { id, state, wide, api: props.api })))
  nodes.push(...gatewayNodes)
  if (codexOn) nodes.push(el(CodexPlanBox, { state, wide, api: props.api }))
  if (goOk && budgetOn && wide && !simple) {
    // 同时出现:合并为一张卡片(Go 在上、预算在下,细分隔线),各自保留预警色与自己的详细信息开关。
    const goView = goBoxBody(state, config, t)
    const budgetView = budgetBoxBody(state, config, t)
    const level = goView.level === 'over' || budgetView.level === 'over' ? 'over'
      : goView.level === 'warn' || budgetView.level === 'warn' ? 'warn' : 'ok'
    nodes.push(el('div', { className: 'cm-bbox cm-bbox-pair' + (level === 'ok' ? '' : ' ' + level) },
      el('div', { className: 'cm-bbox-section' + (goView.level === 'ok' ? '' : ' ' + goView.level) }, goView.body),
      el('div', { className: 'cm-bbox-divider' }),
      el('div', { className: 'cm-bbox-section' + (budgetView.level === 'ok' ? '' : ' ' + budgetView.level) }, budgetView.body)))
  } else {
    if (goOk) nodes.push(el(GoQuotaBox, { state, wide }))
    if (budgetOn && !mergedBudget) nodes.push(el(BudgetBoxContent, { state, wide }))
  }
  if (!budgetOn && showToday && !(simple && wide)) nodes.push(el(BudgetBoxContent, { state, wide }))
  // 简化摘要不再承载峰谷条；单独渲染宽栏条，避免漏掉无预算配置或合并后重复。
  if (simple && wide && showToday) nodes.push(peakNoticeEl(state, config, t))
  // 收起(rail)态:无论预算/Go 额度开关状态,统一在图框下方追加竖向峰谷进度条(受 peakNotice 等门控,内部自行返回 null)。
  if (!wide) nodes.push(peakNoticeRailEl(state, config, t))
  if (modelsOn) nodes.splice(config.sidebarModels.position === 'first' ? 0 : config.sidebarModels.position === 'afterBalance' ? afterBalance : nodes.length, 0,
    el(SidebarModelCosts, { key: 'models', state, wide }))
  return el('div', { ...(simple ? { tabIndex: 0, role: 'region', 'aria-label': t('sidebarSimple') } : {}), className: 'cm-footer-stack' + (wide ? '' : ' rail') + (compactWide ? ' compact' : '') + (simple ? ' simple' : '') }, ...nodes)
}
