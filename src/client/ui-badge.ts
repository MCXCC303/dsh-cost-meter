/**
 * 会话费用徽章(dock / header)与投影联动刷新。
 *
 * 迁移自原 `02-validators-helpers-sidebar.js` 1329–1506 行:
 * `useProjectionRefresh` / `mergeSessionUsage` / `useSessionUsage` /
 * `sessionCostParts` / `modelCostDetail` / `TurnCost` / `SessionCost` / `DockLine`。
 *
 * `props` 由宿主 slot 注入(`useCost` / `useProjection` / `api` / `sessionId` /
 * `turn`),边界先按 any 收口。
 */

// TODO(types): 平台种子 react 由 src/client/seeds.d.ts 以 any 兜底,待补真实类型后收紧。
import React from 'react'
// TODO(types): ui-primitives 仅取 Tooltip,待补真实类型后收紧。
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedInput, formatMoneyUsd, formatTokens, moneyCostOf, recordedApiCost, usageCost, usageHasPlanClass } from './logic.js'
import { makeT, resolveLocale } from './t.js'

const { createElement: el, Fragment, useState, useEffect, useRef } = React

// 投影联动刷新(今日费用实时化):costUsage 投影由宿主在每次 usage 入账时
// 推送,是「本次调用已结束入账」的实时信号。据此触发一次 800ms 防抖的
// getState,侧边栏「今日费用」从最坏 60s 轮询缩短到流结束后 ≈1s;60s 轮询
// 保留作兜底(跨会话/后台标签页场景)。挂在会话徽章(dock/header)与侧边栏
// 页脚三处,覆盖 position=off 等配置组合;投影不可用时静默退化。
// hooks 规则:必须在组件早退 return 之前调用(与 useProjection 同位)。
export function useProjectionRefresh(props: any, usage: any) {
  const primedRef = useRef(false)
  const identityRef = useRef('')
  const identity = usage !== null && typeof usage === 'object'
    ? [usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.reasoning, usage.cost]
      .map(value => String(value ?? 0)).join('|')
    : ''
  useEffect(() => {
    // 首次执行只记基准不触发:挂载/会话切换时的存量投影不构成「新入账」。
    if (!primedRef.current) {
      primedRef.current = true
      identityRef.current = identity
      return
    }
    if (identity === '' || identity === identityRef.current) return
    identityRef.current = identity
    const timer = setTimeout(() => { props.api?.reload?.() }, 800)
    return () => clearTimeout(timer)
  }, [identity])
}

/**
 * 会话用量合并:账本(ledger)持有保留消费,旧/继承的投影 token 不算。
 *
 * TODO(types): projection/snapshot 为宿主投影与 RPC 快照,config 为插件配置。
 */
export function mergeSessionUsage(projection: any, snapshot: any, include: any, config: any) {
  // The ledger owns retained spending; old/inherited projection tokens do not.
  const base = snapshot ? snapshot.own : projection
  if (!include || !snapshot?.subagentCount) return base
  const extra = snapshot.subagents, out = { ...base }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls', 'cost']) out[key] = (base?.[key] ?? 0) + (extra?.[key] ?? 0)
  out.apiCost = recordedApiCost(base, config) + moneyCostOf(extra)
  for (const key of ['byModel', 'byProviderModel']) {
    out[key] = { ...base?.[key] }
    for (const [id, row] of Object.entries(extra?.[key] ?? {}) as [string, any][]) {
      const combined = { ...out[key][id] }
      combined.apiCost = moneyCostOf(combined) + moneyCostOf(row)
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls', 'cost']) combined[field] = (combined[field] ?? 0) + (row[field] ?? 0)
      out[key][id] = combined
    }
  }
  return out
}

/**
 * 会话用量 hook:投影打底,`getSessionCost` RPC 快照覆盖(含子代理时 10s 轮询)。
 *
 * TODO(types): 待 ledger/RPC 快照类型统一后收紧为 SessionUsageSnapshot。
 */
export function useSessionUsage(props: any) {
  const projection = props.useProjection ? props.useProjection('costUsage') : undefined
  const state = props.useCost?.(s => s)?.state
  const config = state?.config
  const [snapshot, setSnapshot] = useState(null)
  useProjectionRefresh(props, projection)
  useEffect(() => {
    if (!props.sessionId || !props.api?.getSessionCost) return
    let active = true, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const value = await props.api.getSessionCost(props.sessionId)
        if (active) setSnapshot({ id: props.sessionId, include: config?.includeSubagentCost === true, value })
      } catch { /* 旧服务无 RPC 时保留投影显示。 */ }
      finally { pending = false }
    }
    void refresh()
    const timer = config?.includeSubagentCost === true ? setInterval(refresh, 10000) : null
    return () => { active = false; if (timer !== null) clearInterval(timer) }
  }, [props.sessionId, state?.meta?.now, projection, config?.includeSubagentCost])
  const saved = snapshot && snapshot.id === props.sessionId && snapshot.include === (config?.includeSubagentCost === true) ? snapshot.value : null
  return { usage: mergeSessionUsage(projection, saved, config?.includeSubagentCost === true, config), config }
}

/**
 * 会话费用拆分:Plan/API 双轨(issue #64)。
 *
 * 会话内存在 Plan 类模型时,徽章显示真金白银(API)金额并在悬停明细中单列
 * Plan 等值;「含 Plan 总额」开启时回到单一总额口径(v1.6.0);无 Plan 用量时
 * 保持宿主精确成本快路径。
 */
export function sessionCostParts(usage: any, config: any) {
  let planPart = 0
  let cost = usageCost(usage, config)
  if (config.showTotalWithPlan !== true && (usage.apiCost !== undefined || usageHasPlanClass(usage, config))) {
    const split = { total: usageCost(usage, config), api: recordedApiCost(usage, config) }
    planPart = Math.max(0, split.total - split.api)
    if (planPart > 0) cost = split.api
  }
  return { cost, planPart }
}

/** 按 provider:model 汇总的费用明细分段(无用量条目不显示)。 */
export function modelCostDetail(usage: any, config: any): string {
  return Object.entries(usage?.byProviderModel ?? {})
    .filter(([, row]) => (row as any).input || (row as any).output || (row as any).cacheRead || (row as any).cacheWrite || (row as any).reasoning)
    .map(([id, row]) => id + ' ' + formatMoneyUsd((row as any).cost, config)).join('; ')
}

/**
 * 单轮费用明细(折叠面板):逐桶单价、逐次调用明细。
 *
 * TODO(types): props.turn/api 来自宿主轮次 slot;getTurnCost 返回值待类型化。
 */
export function TurnCost(props: any) {
  const config = props.useCost?.(s => s)?.state?.config
  const [value, setValue] = useState(null)
  const [error, setError] = useState('')
  const start = props.turn?.start?.seq, end = props.turn?.end?.seq
  const sessionId = props.sessionId
  const pricingKey = JSON.stringify([config?.prices, config?.priceOverrides, config?.priceMatch, config?.planBilling, config?.codingPlans, config?.goQuota?.enabled, config?.peakEnabled, config?.peakEffectiveAt, config?.peakWindows, config?.peakHolidays, config?.exchangeRate])
  useEffect(() => {
    let active = true
    setValue(null); setError('')
    if (config?.hideTurnCost || !sessionId || start == null || end == null) return
    props.api.getTurnCost(sessionId, start, end).then((v: any) => { if (active) setValue(v) }, (e: any) => { if (active) setError(String(e.message ?? e)) })
    return () => { active = false }
  }, [sessionId, start, end, pricingKey, config?.hideTurnCost])
  if (!config || config.hideTurnCost || start == null || end == null) return null
  const en = resolveLocale(config) === 'en'
  const names: Record<string, string> = en ? { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', reasoning: 'Reasoning' } : { input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', reasoning: '推理' }
  const money = (n: any) => formatMoneyUsd(n, { ...config, decimals: Math.max(8, config.decimals ?? 2) })
  const kinds: Record<string, string> = en ? { model: 'Model call', compaction: 'Context compaction', search: 'Native search' } : { model: '模型调用', compaction: '上下文压缩', search: '原生搜索' }
  const rowView = (row: any, i: number) => el('div', { key: i, style: { marginBottom: 4, overflowWrap: 'anywhere' } },
    row.provider + ':' + row.model + ' · ' + names[row.bucket] + (row.plan ? ' (Plan)' : '') + ': ' + row.tokens.toLocaleString() + ' × ' + (row.priced ? money(row.rate) : '?') + ' / 1,000,000 ≈ ' + (row.priced ? money(row.cost) : '?'),
    !row.priced ? (en ? ' (price unavailable)' : '（未配置价格）') : row.bucket === 'reasoning' && row.rate === 0 ? (en ? ' (no separate charge)' : '（不单独收费）') : '')
  return el('details', { className: 'cm-note', style: { fontSize: 12, marginTop: 6 } },
    el('summary', { style: { cursor: 'pointer' } }, en ? 'Turn cost' : '本轮费用', value?.found ? ' ≈ ' + money(config.showTotalWithPlan ? value.cost : value.apiCost) + (value.rows.some((r: any) => !r.priced) ? (en ? ' + unpriced usage' : ' + 未定价用量') : '') : error ? ' ⚠' : ''),
    error ? el('div', { role: 'alert' }, error) : !value ? (en ? 'Loading…' : '加载中…') : !value.found ? (en ? 'Complete usage records unavailable' : '没有完整用量记录') :
      el(Fragment, null, el('p', null, en ? 'Estimated from recorded usage and configured prices; rates per 1M tokens.' : '按已记录用量和配置价格估算；单价单位为每百万 Token。'),
        el('p', null, 'API ≈ ' + money(value.apiCost) + ' · Plan ≈ ' + money(value.cost - value.apiCost) + (en ? ' (equivalent)' : '（等值）')),
        value.rows.map(rowView),
        el('details', null, el('summary', { style: { cursor: 'pointer' } }, (en ? 'Individual calls' : '逐次调用明细') + ' (' + value.calls.length + ')'),
          value.calls.map((call: any, i: number) => el('details', { key: i, style: { margin: '6px 0' } },
            el('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, '#' + (i + 1) + ' ' + kinds[call.kind] + ' · ' + call.provider + ':' + call.model + ' · ' + new Date(call.atMs).toLocaleTimeString() + ' · ' + (call.plan ? 'Plan ' : 'API ') + (call.priced ? '≈ ' + money(call.cost) : (en ? 'price unavailable' : '未配置价格')) + (call.longContext ? (en ? ' · long context' : ' · 长上下文价格') : '')),
            call.rows.map(rowView))))))
}

/**
 * 会话费用 chip(header/角标):悬停显示 tokens/缓存/费用/模型明细。
 *
 * TODO(types): props 与 DockLine 同源(宿主 slot 注入)。
 */
export function SessionCost(props: any) {
  const { usage, config } = useSessionUsage(props)
  if (!usage || !config || (billedInput(usage) + (usage?.output ?? 0)) === 0) return null
  const t = makeT(resolveLocale(config))
  const { cost, planPart } = sessionCostParts(usage, config)
  const detail = [
    t('sessionCostTitle'),
    t('sessionDetailTokens', {
      input: formatTokens(usage?.input ?? 0),
      cache: formatTokens((usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)),
      output: formatTokens(usage?.output ?? 0),
    }),
    t('sessionDetailCache', {
      read: formatTokens(usage?.cacheRead ?? 0),
      write: formatTokens(usage?.cacheWrite ?? 0),
    }),
    t('cost', { amount: formatMoneyUsd(cost, config) }),
    ...(planPart > 0 ? [t('sessionDetailPlan', { amount: formatMoneyUsd(planPart, config) })] : []),
    modelCostDetail(usage, config),
  ].filter(Boolean).join('; ')
  return el(Tooltip, { label: detail, side: 'top', delayMs: 500 },
    el('div', { className: 'cm-chip' }, planPart > 0
      ? t('costChipPlan', { amount: formatMoneyUsd(cost, config) })
      : t('cost', { amount: formatMoneyUsd(cost, config) })))
}

/**
 * dock 栏单行费用(紧凑模式只留金额,悬停保留完整费用行与模型分项)。
 *
 * TODO(types): props 由宿主 dock slot 注入,含 useCost/useProjection/api/sessionId。
 */
export function DockLine(props: any) {
  const { usage, config } = useSessionUsage(props)
  if (!usage || !config) return null
  const input = usage.input ?? 0
  const cache = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const output = usage.output ?? 0
  if (input + cache + output === 0) return null
  const t = makeT(resolveLocale(config))
  const { cost, planPart } = sessionCostParts(usage, config)
  // 缓存写入属于输入分母,但不是缓存命中;无输入时显示未知。
  const hitRate = billedInput(usage) > 0 ? ((usage.cacheRead ?? 0) / billedInput(usage) * 100).toFixed(1) + '%' : '—'
  const values = {
    amount: formatMoneyUsd(cost, config),
    planAmount: formatMoneyUsd(planPart, config),
    hitRate,
    input: formatTokens(input),
    cache: formatTokens(cache),
    output: formatTokens(output),
  }
  const fullLine = t(planPart > 0 ? 'sessionLineSplit' : 'sessionLine', values)
  const modelDetail = modelCostDetail(usage, config)
  const compact = config.sessionCostCompact === true
  // 紧凑模式只留金额;悬停保留完整费用行和模型分项。
  return el('div', { className: 'cm-root', title: compact ? [fullLine, modelDetail].filter(Boolean).join('; ') : modelDetail },
    compact ? t(planPart > 0 ? 'sessionLineSplitCompact' : 'sessionLineCompact', values) : fullLine)
}
