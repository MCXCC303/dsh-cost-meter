/**
 * 启动包与各分块共用的 UI 助手。
 *
 * 放在这里而不是某个分块入口里,是为了让「主包」与「按需分块」都能引用:
 * 主包不允许 import 分块入口(会绕成循环 + 把设置面板提前打进启动包),
 * 分块则可以在自己的产物里内联这些助手。因此**共享 UI 代码一律放这里**。
 */
import React from 'react'

import { billingClassOfLocal, cacheUnreportedOf } from './logic.js'

const { createElement: el } = React as any

export function numInput(props, onChange) {
  const value = props.value
  return el('input', {
    className: 'cm-input narrow',
    type: 'number', step: 'any', min: '0',
    value: typeof value === 'number' ? String(value) : '',
    onChange: event => {
      const text = event.target.value
      // 清空语义分三档(emptyMode):
      //  'clear'  → 回调 null,由调用方删除该字段/档位(价格 offPeak/peak 行);
      //  'ignore' → 不提交,保留原值(必填结构如基础价、汇率——写 0 会静默
      //             改变计费或被服务端拒绝);
      //  默认     → 提交 0(预算等 0 为合法值的场景)。
      if (text === '') {
        if (props.emptyMode === 'clear') { onChange(null); return }
        if (props.emptyMode === 'ignore') return
        onChange(0); return
      }
      const parsed = Number(text)
      // 负数直接忽略,避免把负值写进价格/预算配置(min 属性挡不住手动输入)。
      if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed)
    },
  })
}

export const prettyProvider = provider => (provider === 'zen' ? 'go' : provider)

/** 单条聚合桶:token/费用字段(与 modelStatsRows 的 fields 一致;缺省键一律按 0 补齐)。 */
interface ModelBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  calls: number
  apiCost: number
}

/** 模型统计行:聚合桶字段 + 展示派生字段(标签、总量、命中率、性价比、计费分类)。 */
export interface ModelStatsRow extends ModelBucket {
  key: string
  label: string
  tokens: number
  cls: string
  hitRate: number | null
  cacheUnreported: boolean
  blended: number | null
  perUsd: number | null
}

/** 把 `provider:model` 键里的 provider 段美化(zen → go),模型段原样保留。 */
export const prettyProviderKey = key => {
  const sep = key.indexOf(':')
  if (sep <= 0) return key
  return prettyProvider(key.slice(0, sep).toLowerCase()) + key.slice(sep)
}

export function modelStatsRows(state, config, t, source) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost', 'calls']
  const num = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
  const addRow = (out, key, b) => {
    if (!b || typeof b !== 'object') return
    // 桶初始值由 fields + apiCost 生成,恰好是 ModelBucket 的全部键(运行时对象不变)。
    const row = out[key] ?? (out[key] = Object.fromEntries([...fields, 'apiCost'].map(k => [k, 0])) as unknown as ModelBucket)
    for (const k of fields) row[k] += num(b[k])
    const sep = key.indexOf(':')
    row.apiCost += num(b.apiCost ?? (billingClassOfLocal(sep > 0 ? key.slice(0, sep) : 'deepseek', sep > 0 ? key.slice(sep + 1) : key, config) === 'plan' ? 0 : b.cost))
  }
  // 旧账本依次回退 byModel、会话内分模型明细、会话模型和未分模型合计。
  const modelMapOf = src => {
    if (!src || typeof src !== 'object') return {}
    if (src.byProviderModel && Object.keys(src.byProviderModel).length) return src.byProviderModel
    if (src.byModel && Object.keys(src.byModel).length) return Object.fromEntries(Object.entries(src.byModel).map(([k, v]) => [k.includes(':') ? k : 'deepseek:' + k, v]))
    const rebuilt = {}
    for (const s of Array.isArray(src.sessions) ? src.sessions : []) {
      if (!s || typeof s !== 'object') continue
      if (s.byProviderModel && Object.keys(s.byProviderModel).length) {
        for (const [key, b] of Object.entries(s.byProviderModel)) addRow(rebuilt, key, b)
      } else addRow(rebuilt, (s.provider || 'deepseek') + ':' + (s.model || 'unknown'), s)
    }
    if (Object.keys(rebuilt).length) return rebuilt
    return fields.some(k => num(src[k]) > 0) ? { 'deepseek:legacy': src } : {}
  }
  const aggregate = source => {
    // 聚合桶:fields + apiCost 全部按数值累加(键为 provider:model)。
    const out: Record<string, ModelBucket> = {}
    const add = map => { for (const [key, b] of Object.entries(map ?? {})) addRow(out, key, b) }
    if (source === 'today') add(modelMapOf(state.today))
    else {
      const end = Date.parse((state.meta?.dayKey || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z')
      for (const day of state.history ?? []) {
        const stamp = Date.parse(day.date + 'T00:00:00Z')
        if (stamp <= end && stamp >= end - 89 * 86400000) add(modelMapOf(day))
      }
    }
    return Object.entries(out).map(([key, b]): ModelStatsRow => {
      const sep = key.indexOf(':')
      const provider = (sep > 0 ? key.slice(0, sep) : 'deepseek').toLowerCase()
      const model = sep > 0 ? key.slice(sep + 1) : key
      const tokens = b.input + b.output + b.cacheRead + b.cacheWrite + b.reasoning
      const hitDen = b.cacheRead + b.input
      return {
        label: key === 'deepseek:legacy' ? t('modelStatsLegacy')
          : (provider === 'deepseek' || provider === '' ? model : prettyProvider(provider) + ':' + model),
        key, ...b, tokens,
        // 计费方式(issue #64):plan=订阅额度(费用为等值口径),api=按量计费。
        cls: billingClassOfLocal(provider, model, config),
        hitRate: hitDen > 0 ? b.cacheRead / hitDen : null,
        // 缓存字段疑似未上报(issue #65 讨论):多轮长上下文却恒零命中,直连
        // DeepSeek 的 prefix cache 几乎不可能(同会话第二轮起大量命中)——大概率
        // 是中转/代理层剥掉了 usage 的缓存扩展字段。此时命中率不可统计、金额按
        // 全未命中价计(上界),界面明确标注而非误导性的 0.0%。
        cacheUnreported: cacheUnreportedOf(b),
        blended: tokens > 0 && b.cost > 0 ? b.cost / tokens * 1e6 : null,
        perUsd: b.cost > 0 ? tokens / b.cost : null,
      }
    }).filter(r => r.tokens > 0 || r.cost > 0)
  }
  return aggregate(source).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
}
