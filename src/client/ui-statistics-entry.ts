/**
 * 会话「费用明细」入口按钮 + 弹窗外壳(**启动包内**)。
 *
 * 为什么必须在启动包:旧单包实现里这个按钮注册在
 * `conversation.session.header.actions` / `conversation.composer.dock`
 * (id `cost-meter-statistics`,order 1)。重构后重面板搬进了按需分块,而启动包
 * 不能静态 import 分块入口 —— 若把它留在 settings.ts 里,这个入口会直接消失
 * (迁移期确实发生过:产物只注册 8 条、缺这两条)。
 *
 * 所以这里只放**薄壳**:按钮本身 + dialog 外框;弹窗内容(重面板)仍按需经
 * `props.api.loadStatistics()` 从 `./client.statistics.js` 取,不进启动包。
 */
import React from 'react'

import { formatMoneyUsd, formatTokens } from './logic.js'
import { resolveLocale } from './t.js'

const { createElement: el, Fragment, useState, useEffect } = React as any

/** 已预取的分块页面缓存:悬停/聚焦时提前取,点击时直接渲染。 */
export const loadedPages = new WeakMap<object, unknown>()

/** 预取一个分块页面(失败静默:预热失败不该影响交互)。 */
export function warmPage(load: (() => Promise<any>) | undefined, props: unknown): void {
  if (typeof load !== 'function') return
  void load().then(page => { loadedPages.set(load as object, page); (page as any)?.prefetch?.(props) }).catch(() => {})
}

/** 统计弹窗的根类名(与统计分块的样式约定一致)。 */
export const STAT_DIALOG_CLASS = 'cm-stat-dialog'

/**
 * 弹窗内容包装:同步渲染这个壳,由它内部异步取统计分块。
 *
 * 必须保持"先渲染壳、壳里再加载"的两层结构 —— 弹窗一打开就同步出现这个
 * 函数组件节点,重面板 arrive 之后才替换;若改成"等分块到了才渲染节点",
 * 打开弹窗的瞬间内容区是空的。
 */
export function StatisticsBody(props: any) {
  const load = props.load ?? props.api.loadStatistics
  const [Page, setPage] = useState(() => loadedPages.get(load) ?? null) as [any, (value: any) => void]
  const [error, setError] = useState('') as [string, (value: string) => void]
  const [retry, setRetry] = useState(0) as [number, (fn: (n: number) => number) => void]
  useEffect(() => {
    let active = true
    setError('')
    void load().then((page: unknown) => {
      loadedPages.set(load as object, page)
      // 必须包一层:page 是组件函数,直接 setPage(page) 会被 React 当成 updater 调用
      // (旧实现同此形态,漏掉这层会让弹窗永远停在加载壳)。
      if (active) setPage(() => page)
    }, (e: any) => { if (active) setError(String(e?.message ?? e)) })
    return () => { active = false }
  }, [props.api, props.load, retry])
  // 页面需要宿主侧的格式化函数(statistics.ts 的 money = n => formatMoneyUsd(...) 无兜底)。
  if (Page) return el(Page, { ...props, formatMoneyUsd, formatTokens, resolveLocale })
  return el('div', { className: error ? '' : 'cm-loading', role: error ? 'alert' : 'status', 'aria-label': resolveLocale(props.state?.config) === 'en' ? 'Loading' : '正在读取' }, error || el(Fragment, null, el('i'), el('i'), el('i')), error ? el('button', { className: 'cm-btn', onClick: () => setRetry((n: number) => n + 1) }, '\u21bb') : null)
}

/** 会话费用明细按钮 + 弹窗。 */
export function SessionStatisticsButton(props: any) {
  const snapshot = props.useCost?.((s: unknown) => s), state = snapshot?.state
  const [openedId, setOpenedId] = useState(null) as [string | null, (value: string | null) => void], dialog = React.useRef(null)
  const hidden = state?.config[props.entryPosition === 'header' ? 'hideSessionCostHeader' : 'hideSessionCostDock'] === true
  const open = !hidden && !!props.sessionId && openedId === props.sessionId
  useEffect(() => { if (open) dialog.current?.showModal() }, [open])
  useEffect(() => { setOpenedId(null) }, [props.sessionId, hidden])
  useEffect(() => {
    if (!props.sessionId || hidden || !state) return
    const timer = setTimeout(() => { if (!document.hidden) void warmPage(props.api.loadStatistics, { state, sessionId: props.sessionId }) }, 300)
    return () => clearTimeout(timer)
  }, [props.sessionId, hidden, !!state, state?.total?.calls])

  if (!props.sessionId || hidden) return null
  const en = resolveLocale(state?.config) === 'en'
  const label = en ? 'Conversation cost details' : '本会话费用明细'
  return el(Fragment, null,
    el('button', { type: 'button', className: 'cm-btn cm-stat-entry cm-stat-' + (props.entryPosition || 'dock'), title: label, 'aria-label': label, 'aria-haspopup': 'dialog', onMouseEnter: () => warmPage(props.api.loadStatistics, { state, sessionId: props.sessionId }), onFocus: () => warmPage(props.api.loadStatistics, { state, sessionId: props.sessionId }), onClick: () => setOpenedId(props.sessionId) }, en ? 'Cost details' : '费用明细'),
    open ? el('dialog', { ref: dialog, role: 'dialog', className: STAT_DIALOG_CLASS, 'aria-label': label, onCancel: () => setOpenedId(null) },
      el('header', { className: 'cm-stat-dialog-head' }, el('strong', null, label), el('button', { type: 'button', className: 'cm-btn', autoFocus: true, 'aria-label': en ? 'Close' : '关闭', onClick: () => setOpenedId(null) }, '×')),
      el('div', { className: 'cm-stat-dialog-body' },
        // 首次 RPC 失败(state 仍为 null)时不能只渲染加载壳:按旧实现给出错误文案 + 重试。
        state
          ? el(StatisticsBody, { ...props, key: props.sessionId, state, api: props.api, sessionId: props.sessionId })
          : el('p', { role: snapshot?.error ? 'alert' : 'status' }, snapshot?.error || (en ? 'Loading…' : '加载中…'),
            el('button', { type: 'button', className: 'cm-btn', onClick: () => props.api.reload() }, en ? 'Retry' : '重试')))) : null)
}
