/**
 * 引导卡片:本地存储读写 + 三个引导组件。
 *
 * 迁移自旧片段 `src/client/02-validators-helpers-sidebar.js` 第 2958–3075 行:
 *  - `SIMPLE_GUIDE_KEY` / `simpleGuideSeen` / `SidebarSimpleGuide`(首次更新后的功能引导)
 *  - `QuotaStripGuide`(额度横条引导)
 *  - `BALANCE_CLICK_HINT_LS_KEY` / `readBalanceClickHintLS` / `writeBalanceClickHintLS` / `BalanceClickGuide`
 *
 * 组件挂载点由激活层(index.ts)与 ui-sidebar.ts 负责,这里只导出存储键与组件。
 */

// 平台种子:react 由宿主注入(scripts/build.mjs 把 react 标为 external);
// 类型来自 src/client/seeds.d.ts(仓库不安装 react,避免版本漂移)。
// TODO(types): 后续装 @types/react 后,可删除 seeds.d.ts 的兜底声明。
import React from 'react'
import { makeT, resolveLocale } from './t.js'
// TODO(migrate): CODING_PLAN_ROWS 的最终归属应是 constants.ts(与 settings.ts 里的同名常量同源);
// 过渡期由 ui-quota.ts 导出复用,避免出现第二份副本。
import { CODING_PLAN_ROWS } from './ui-quota.js'

const { createElement: el, useRef, useState } = React

// TODO(types): props(state/config/api)属宿主边界,暂用 any;后续接 wire.ts 的 parseState 结果类型。
type GuideProps = any
// TODO(types): 同上,state/config 边界类型。
type CmState = any
type CmConfig = any
type T = (key: string, params?: Record<string, unknown>) => string

// 首次更新后的功能引导:非模态小卡片,让用户自主决定是否开启额度横条;
// 选择「开启/暂不」后写回 promptSeen=true 永久消失(挂在常驻 sidebar.footer.action)。
export const SIMPLE_GUIDE_KEY = 'dsh-cost-meter:simple-guide-dismissed'

/** 简化引导是否已看过:配置标记(跨设备)优先,localStorage 本地兜底。 */
export function simpleGuideSeen(config: CmConfig): boolean {
  if (config?.sidebarSimplePromptSeen === true) return true
  try { return window.localStorage.getItem(SIMPLE_GUIDE_KEY) === '1' } catch (_) { return false }
}

export function SidebarSimpleGuide(props: GuideProps) {
  const store = props.useCost ? props.useCost((s: CmState) => s) : undefined
  const busyRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const config = store?.state?.config
  if (!config || dismissed || simpleGuideSeen(config)) return null
  const t: T = makeT(resolveLocale(config))
  const dismiss = () => {
    setDismissed(true)
    try { window.localStorage.setItem(SIMPLE_GUIDE_KEY, '1') } catch (_) { /* 本次页面仍可关闭 */ }
  }
  const choose = async (enabled: boolean) => {
    if (busyRef.current) return
    busyRef.current = true
    setPending(true); setFailed(false)
    try {
      const saved = await props.api.updateConfig({ sidebarSimple: enabled, sidebarSimplePromptSeen: true })
      if (saved?.config?.sidebarSimple !== enabled) throw new Error()
      dismiss()
    } catch (_) { setFailed(true) }
    finally { busyRef.current = false; setPending(false) }
  }
  return el('div', { className: 'cm-qguide', role: 'dialog', 'aria-label': t('sidebarSimpleTitle'), 'aria-busy': pending, onKeyDown: (event: any) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss() } } },
    el('div', { className: 'cm-bbox-head' }, el('h4', null, t('sidebarSimpleTitle')),
      el('button', { type: 'button', className: 'cm-btn small', 'aria-label': t('closeGuide'), onClick: dismiss }, '×')),
    el('p', null, t('sidebarSimpleBody')),
    failed ? el('p', { role: 'alert' }, t('sidebarSimpleError')) : null,
    el('div', { className: 'cm-buttons' },
      el('button', { type: 'button', className: 'cm-btn small', disabled: pending, onClick: () => choose(false) }, t('sidebarSimpleOff')),
      el('button', { type: 'button', className: 'cm-btn small primary', disabled: pending, onClick: () => choose(true) }, t('sidebarSimpleOn'))))
}

export function QuotaStripGuide(props: GuideProps) {
  // 所有 Hook 必须在任何条件返回之前调用:promptSeen 从 false 翻为 true 时本组件
  // 会从「渲染引导卡」变为提前 return null,若 useRef 在条件返回之后,两次渲染
  // 的 Hook 数量不一致,触发 React #300(Rendered fewer hooks than expected)。
  const costStore = props.useCost ? props.useCost((s: CmState) => s) : undefined
  const busyRef = useRef(false)
  const state = costStore?.state
  if (!state) return null
  const config = state.config
  if (!simpleGuideSeen(config)) return null
  if (config.quotaStrip?.promptSeen === true) return null
  const t: T = makeT(resolveLocale(config))
  const choose = (enabled: boolean) => {
    if (busyRef.current === true) return
    busyRef.current = true
    const current = config.quotaStrip ?? { enabled: false, budget: true, go: true, plans: true }
    props.api.updateConfig({ quotaStrip: { ...current, enabled, promptSeen: true } })
      .catch(() => { busyRef.current = false })
  }
  return el('div', { className: 'cm-qguide', role: 'dialog', 'aria-label': t('quotaStripGuideTitle') },
    el('h4', null, t('quotaStripGuideTitle')),
    el('p', null, t('quotaStripGuideBody')),
    el('div', { className: 'cm-buttons' },
      el('button', { type: 'button', className: 'cm-btn small', onClick: () => choose(false) }, t('quotaStripGuideOff')),
      el('button', { type: 'button', className: 'cm-btn small primary', onClick: () => choose(true) }, t('quotaStripGuideOn'))))
}

// 更新后的提醒(issue #37):告知侧边栏余额/额度图框支持点击立即刷新;
// 「知道了」写回 balance.clickHintSeen=true 后永久消失(挂常驻 sidebar.footer.action)。
// 仅在侧边栏确有可点击图框(官方余额 / 自定义余额 / Coding Plan)时展示,避免噪音。
// 已读标记双通道:配置标记(跨设备) + localStorage 本地兜底。后者防御版本错位——
// 服务端/网关若运行旧版 typert schema(decode 时 zod parse 会剥离 schema 未声明的键),
// 新增的配置标记在到达客户端前就被剥掉,卡片会在每次刷新后重现;localStorage 不经 RPC 链路,不受影响。
export const BALANCE_CLICK_HINT_LS_KEY = 'dsh-cost-meter:balance-click-hint-seen'

export const readBalanceClickHintLS = (): boolean => {
  try { return window.localStorage.getItem(BALANCE_CLICK_HINT_LS_KEY) === '1' } catch (_) { return false } // 隐私模式等场景静默
}

export const writeBalanceClickHintLS = (): void => {
  try { window.localStorage.setItem(BALANCE_CLICK_HINT_LS_KEY, '1') } catch (_) { /* 配置标记仍是主通道 */ }
}

export function BalanceClickGuide(props: GuideProps) {
  // Hook 全部前置(promptSeen 类标记翻转时会提前 return null,顺序必须稳定)。
  const costStore = props.useCost ? props.useCost((s: CmState) => s) : undefined
  const busyRef = useRef(false)
  const [dismissed, setDismissed] = useState(false)
  const [lsSeen] = useState(readBalanceClickHintLS)
  const state = costStore?.state
  if (!state) return null
  const config = state.config
  const sidebarBalanceOn = config.balance?.display === 'sidebar' || config.balance?.display === 'both'
  const sidebarCustomOn = (config?.customBalances ?? []).some((e: any) => e?.enabled === true && (e.display === 'sidebar' || e.display === 'both'))
    || (config.customBalance?.enabled === true && (config.customBalance?.display === 'sidebar' || config.customBalance?.display === 'both'))
  const sidebarPlansOn = CODING_PLAN_ROWS.some(row => {
    const entry = config.codingPlans?.[row.id]
    return entry?.enabled === true && (entry.display === 'sidebar' || entry.display === 'both')
  })
  if (dismissed || lsSeen || config.balance?.clickHintSeen === true || (!sidebarBalanceOn && !sidebarCustomOn && !sidebarPlansOn)) return null
  // 串行展示:横条引导(QuotaStripGuide)与本卡同为 fixed 顶部卡片,同屏会完全重叠,
  // 点掉一张露出另一张,视觉上像「点了没反应」。等横条引导处理完(promptSeen)再出现。
  if (!simpleGuideSeen(config)) return null
  if (config.quotaStrip?.promptSeen !== true) return null
  const t: T = makeT(resolveLocale(config))
  const dismiss = () => {
    if (busyRef.current === true) return
    // 乐观消失:点击立即隐藏,落盘确认失败才恢复可见(避免宿主渲染时序让卡片看起来「点不掉」)。
    setDismissed(true)
    busyRef.current = true
    writeBalanceClickHintLS() // 本地兜底同步落点,不依赖 RPC 成败
    props.api.updateConfig({ balance: { ...(config.balance ?? {}), clickHintSeen: true } })
      .catch(() => { busyRef.current = false; setDismissed(false) })
  }
  return el('div', { className: 'cm-qguide', role: 'dialog', 'aria-label': t('balanceClickGuideTitle') },
    el('h4', null, t('balanceClickGuideTitle')),
    el('p', null, t('balanceClickGuideBody')),
    el('div', { className: 'cm-buttons' },
      el('button', { type: 'button', className: 'cm-btn small primary', onClick: dismiss }, t('balanceClickGuideOk'))))
}
