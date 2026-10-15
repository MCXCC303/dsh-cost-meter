/**
 * 右下角角标(会话内浮层):模型花费 Top 榜与预算/峰谷提示。
 *
 * 迁移自旧片段 02 的 1882–1958 行(此前在分派中漏掉,现补齐)。
 * 由启动包按配置注册到 `conversation.composer.dock`(id `cost-meter-corner`)。
 */
import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

import { formatMoneyUsd, formatTokens, displayCostOf, formatMoneyValue } from './logic.js'
import { makeT, resolveLocale, PERIOD_KEYS } from './t.js'
import { sidebarModelRows } from './ui-sidebar-models.js'

const { createElement: el, Fragment, useState, useEffect, useRef } = React as any

export function CornerChips(props) {
  const costStore = props.useCost ? props.useCost(s => s) : undefined
  const state = costStore?.state
  if (!state) return null
  const config = state.config
  const t = makeT(resolveLocale(config))
  const corner = config.corner ?? { enabled: false, goRolling: true, goWeekly: true, goMonthly: true, budget: true }
  const goQuota = state.goQuota
  const goOk = config?.goQuota?.enabled !== false && goQuota?.status === 'ok'
  const pctOf = win => (win !== null && typeof win?.percent === 'number')
    ? Math.round(Math.max(0, Math.min(100, win.percent)))
    : null
  const chips: Array<{ key: string; text: string; tip: string; level: string }> = []
  if (config.sidebarModels?.dock) {
    const rows = sidebarModelRows(state, config.sidebarModels.period, t)
    if (rows.length) chips.push({ key: 'model-top', text: el(Fragment, null, el('span', { className: 'cm-bal-label' }, rows[0].label), el('span', { className: 'cm-bal-amt' }, formatMoneyUsd(rows[0].cost, config))), tip: rows[0].label + ' ' + formatMoneyUsd(rows[0].cost, config), level: 'ok' })
  }
  const pushGo = (on, win, shortKey, labelKey) => {
    if (!corner.enabled || !on || !goOk) return
    const pct = pctOf(win)
    if (pct === null) return
    const resets = typeof win.resetsAt === 'string' && win.resetsAt.length > 0
      ? t('goResetAt', { time: new Date(win.resetsAt).toLocaleString() })
      : ''
    chips.push({
      key: shortKey,
      text: t(shortKey) + ' ' + pct + '%',
      tip: t(labelKey) + ': ' + pct + '%' + (resets ? ' · ' + resets : ''),
      level: pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok',
    })
  }
  const mainKey = config?.goQuota?.main === 'weekly' || config?.goQuota?.main === 'monthly' ? config.goQuota.main : 'rolling'
  const goOrder = [mainKey, ...['rolling', 'weekly', 'monthly'].filter(k => k !== mainKey)]
  const defOf = k => k === 'rolling'
    ? ['goRolling', goQuota?.rolling, 'goShortRolling', 'cornerGoRolling']
    : k === 'weekly'
      ? ['goWeekly', goQuota?.weekly, 'goShortWeekly', 'cornerGoWeekly']
      : ['goMonthly', goQuota?.monthly, 'goShortMonthly', 'cornerGoMonthly']
  for (const k of goOrder) {
    const [flagKey, win, shortKey, labelKey] = defOf(k)
    pushGo(corner[flagKey] === true, win, shortKey, labelKey)
  }
  // 预算 chip:预算图框同款口径(≥80% 预警、≥100% 超支)。
  if (corner.enabled && corner.budget === true) {
    const budget = config.budget ?? { enabled: false, amount: 100, period: 'month' }
    if (budget.enabled === true) {
      const rate = Number(config.exchangeRate)
      const usedUsd = state.budgetUsed ?? (
        budget.period === 'day' ? displayCostOf(state.today, config)
          : budget.period === 'all' ? displayCostOf(state.total, config)
            : displayCostOf(state.month, config))
      const used = usedUsd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
      const amount = Math.max(0, Number(budget.amount) || 0)
      const pct = amount > 0 ? Math.min(999, used / amount * 100) : null
      if (pct !== null) {
        const level = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'
        chips.push({
          key: 'budget',
          text: t('budgetShort') + ' ' + pct.toFixed(1) + '%',
          tip: t('budgetOf', { period: t(PERIOD_KEYS[budget.period] ?? 'periodMonth') }) + ' · '
            + t('usedOf', { used: formatMoneyValue(used, config), amount: formatMoneyValue(amount, config) }),
          level,
        })
      }
    }
  }
  if (chips.length === 0) return null
  return el('div', { className: 'cm-corner' },
    chips.map(c => el(Tooltip, { key: c.key, label: c.tip, side: 'top', delayMs: 500 },
      el('span', { className: 'cm-corner-chip' + (c.key === 'model-top' ? ' cm-model-top' : '') + (c.level === 'ok' ? '' : ' ' + c.level) }, c.text))))
}
