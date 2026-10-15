/**
 * 侧栏「模型花费卡片」:按模型维度展示当日/历史花费与占比。
 *
 * 迁移自原 03-model-sidebar 片段;默认值常量在 constants.ts,与配置规整共用。
 */
import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

import { MODEL_SIDEBAR_DEFAULTS } from './constants.js'
import { numInput, prettyProviderKey, modelStatsRows } from './ui-shared.js'
import type { ModelStatsRow } from './ui-shared.js'
import { WalletIcon } from './ui-credential.js'
import { makeT, resolveLocale } from './t.js'
import { displayCostOf, formatMoneyUsd, formatTokens, formatMoneyValue, simpleBarByDirection, barDirectionOf } from './logic.js'

const { createElement: el, Fragment, useState, useEffect, useRef } = React as any

export const MODEL_OPEN_KEY = 'dsh-cost-meter:models-open'
export function sidebarModelRows(state, period, t): ModelStatsRow[] {
  return modelStatsRows(state, state.config, t, period).map(r => ({ ...r, label: r.key === 'deepseek:legacy' ? r.label : prettyProviderKey(r.key), cost: displayCostOf(r, state.config) }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.key.localeCompare(b.key))
}
export function SidebarModelCosts({ state, wide }) {
  const cfg = { ...MODEL_SIDEBAR_DEFAULTS, ...state.config.sidebarModels }
  const t = makeT(resolveLocale(state.config))
  const readOpen = () => {
    try { const saved = cfg.remember ? window.localStorage.getItem(MODEL_OPEN_KEY) : null; if (saved !== null) return saved === '1' } catch (_) {}
    return cfg.defaultOpen
  }
  const [open, setOpen] = useState(readOpen)
  const [period, setPeriod] = useState(cfg.period)
  useEffect(() => setPeriod(cfg.period), [cfg.period])
  useEffect(() => setOpen(readOpen()), [cfg.defaultOpen, cfg.remember])
  const rows = sidebarModelRows(state, period, t)
  const total = rows.reduce((n, r) => n + r.cost, 0)
  const money = n => formatMoneyUsd(n, state.config)
  const title = t(period === 'history' ? 'modelStatsHistory' : 'modelStatsToday') + ' ' + money(total) + ' · ' + t('modelsCount', { n: rows.length })
  const summary = cfg.summary === 'top' && rows.length ? rows[0].label + ' ' + money(rows[0].cost) : title
  const summaryNode = cfg.summary === 'top' && rows.length ? el(Fragment, null, el('span', { className: 'cm-bal-label' }, rows[0].label), el('span', { className: 'cm-bal-amt' }, money(rows[0].cost))) : el('span', { className: 'cm-bal-label' }, summary)
  const toggle = () => {
    setOpen(!open)
    try { if (cfg.remember) window.localStorage.setItem(MODEL_OPEN_KEY, open ? '0' : '1') } catch (_) {}
  }
  if (!wide || state.config.sidebarSimple) return el('div', { className: 'cm-foot cm-num' + (wide ? '' : ' cm-foot-rail'), title: summary + ' · ' + title }, wide ? summaryNode : el(WalletIcon, { size: 16 }))
  const shown = rows.slice(0, cfg.topN)
  if (rows.length > cfg.topN) shown.push(rows.slice(cfg.topN).reduce((out, r) => {
    for (const k of ['cost', 'input', 'output', 'cacheRead', 'cacheWrite']) out[k] += r[k]
    return out
  }, { key: 'other', label: t('modelsOther'), cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as ModelStatsRow))
  return el('div', { className: 'cm-bbox cm-model-costs' },
    el('button', { type: 'button', className: 'cm-collapse-h', 'aria-expanded': String(open), title, onClick: toggle },
      el('span', { className: 'cm-caret' + (open ? ' open' : '') }), summaryNode),
    open ? el(Fragment, null,
      el('div', { className: 'cm-buttons' }, ['today', 'history'].map(p => el('button', { key: p, type: 'button', className: 'cm-mstats-tab' + (period === p ? ' active' : ''), 'aria-pressed': period === p, onClick: () => setPeriod(p) }, t(p === 'today' ? 'modelStatsToday' : 'modelStatsHistory')))),
      shown.length ? shown.map(r => el('div', { key: r.key },
        el('div', { className: 'cm-bbox-head' }, el('span', { className: 'cm-bal-label', title: r.label }, r.label), el('span', { className: 'cm-num cm-bal-amt' }, money(r.cost))),
        cfg.shares ? el('div', { className: 'cm-bbox-bar', title: (total > 0 ? r.cost / total * 100 : 0).toFixed(1) + '%' }, el('div', { className: 'cm-bbox-fill', style: { width: (total > 0 ? r.cost / total * 100 : 0) + '%' } })) : null,
        cfg.tokens ? el('div', { className: 'cm-mstats-note' }, t('modelStatsInput') + ' ' + formatTokens(r.input) + ' · ' + t('modelStatsCache') + ' ' + formatTokens(r.cacheRead + r.cacheWrite) + ' · ' + t('modelStatsOutput') + ' ' + formatTokens(r.output)) : null)) : el('span', { className: 'cm-note' }, t('modelStatsEmpty'))) : null)
}
export function ModelSidebarSettings({ draft, setDraft, t }) {
  const cfg = { ...MODEL_SIDEBAR_DEFAULTS, ...draft?.sidebarModels }
  const set = (key, value) => { if (draft) setDraft({ ...draft, sidebarModels: { ...cfg, [key]: value } }) }
  const select = (key, choices) => el('div', { className: 'cm-field', key }, el('label', null, t('models_' + key)), el('select', { className: 'cm-input', value: cfg[key], onChange: e => set(key, e.target.value) }, choices.map(([value, label]) => el('option', { key: value, value }, t(label)))))
  return el('div', { className: 'cm-grid' },
    el('div', { className: 'cm-grid-group' }, t('modelsTitle')),
    ['enabled', 'defaultOpen', 'remember', 'tokens', 'shares', 'dock'].map(key => el('label', { key, className: 'cm-check' }, el('input', { type: 'checkbox', checked: cfg[key], onChange: e => set(key, e.target.checked) }), t('models_' + key))),
    select('period', [['today', 'modelStatsToday'], ['history', 'modelStatsHistory']]),
    select('summary', [['total', 'modelsTotal'], ['top', 'modelsTop']]),
    select('position', [['first', 'modelsFirst'], ['afterBalance', 'modelsAfter'], ['last', 'modelsLast']]),
    ['topN', 'refreshSeconds'].map(key => el('div', { key, className: 'cm-field' }, el('label', null, t('models_' + key)), numInput({ value: cfg[key] }, v => set(key, Math.max(key === 'topN' ? 1 : 10, Math.min(key === 'topN' ? 10 : 60, Math.floor(v))))))))
}
