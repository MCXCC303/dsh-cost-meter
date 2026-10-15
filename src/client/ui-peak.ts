/**
 * 峰谷条(展开态/收起态、简洁/经典/动态三种样式)与峰/谷切换提醒弹窗。
 *
 * 迁移自旧片段 `src/client/02-validators-helpers-sidebar.js` 第 1954–2267 行;
 * 相位与倒计时等纯计算已归 `peak-core.ts`(client-arch 迁移),这里只保留组件与分块加载。
 *
 * 「动态」样式:整块渲染在按需分块 `client.peak.js`(入口 src/client/peak.ts)里。
 * 激活层用 `setPeakLoader(() => require.async('./client.peak.js'))` 注入加载器;
 * 选中该样式时加载一次,未就绪与加载失败时不渲染该行,其余峰谷样式的行为不变。
 */

// 平台种子:react 由宿主注入(scripts/build.mjs 把 react 标为 external);
// 类型来自 src/client/seeds.d.ts(仓库不安装 react 与 primitives,避免版本漂移)。
// TODO(types): 后续装 @types/react 与真实的 primitives 类型后,可删除 seeds.d.ts 的兜底声明。
import React from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { countdownText, peakPhaseAt, peakView, phaseLabelKeys } from './peak-core.js'
import { makeT, resolveLocale } from './t.js'

const { createElement: el, useState, useEffect } = React

// TODO(types): props / state / config 属宿主边界,暂用 any;后续接 wire.ts 的 parseState 结果类型。
type CmState = any
type CmConfig = any
type T = (key: string, params?: Record<string, unknown>) => string

// 预览通道事件名:设置页按钮/控制台经 window.cmPeakAlertPreview(kind) 触发真实组件。
export const PEAK_ALERT_PREVIEW_EVENT = 'cm-peak-alert-preview'

// 峰谷 Web 通知去重:记录最近一次已通知的切换点时刻(nextAtMs)。
// 必须放模块级——配置变化会重挂 PeakAlert(内部 ref 归零),若用组件内状态,
// 重挂后同一切换点会再发一条;切换点时刻单调递增,存单值即可。
export let lastPeakNotifyAtMs = 0

/** 动态峰谷分块(client.peak.js)的模块形态:导出 mount() → React 组件。 */
export type PeakChunkModule = { mount: () => any }
/**
 * 分块加载器:激活层注入,例如 `setPeakLoader(() => require.async('./client.peak.js'))`。
 *
 * 返回值是分块模块;平台 `require.async` 的静态类型是 `Promise<Record<string, unknown>>`,
 * 故这里放宽为 `Promise<any>`,避免激活层被迫写类型断言。
 * TODO(types): 若平台 require.async 支持泛型(或 ClientRequire 收紧),再改为 `() => Promise<PeakChunkModule>`。
 */
export type PeakLoader = () => Promise<any>
/** 分块组件形态(React 元素类型)。 */
type PeakComponent = (props: any) => any

// 分块加载器:激活层注入;未注入时动态样式退回简洁样式。
export let peakLoad: PeakLoader | null = null
// 请求期间:Promise;就绪后:组件;失败:回到 null(可重试)。
let peakChunk: Promise<PeakChunkModule> | PeakComponent | null = null

/**
 * 注入动态峰谷分块加载器。
 *
 * ES 模块的导入绑定只读,激活层无法直接写 `peakLoad = …`,必须走这个设置函数
 * (原来靠同一闭包里的 `let peakLoad` 赋值,拆模块后不再可行)。
 */
export function setPeakLoader(fn: PeakLoader | null): void {
  peakLoad = fn
}

/** Promise 形态判定:peakChunk 在请求期间是 Promise、就绪后是组件,两者必须区分。 */
const isPromiseLike = (value: unknown): value is Promise<PeakChunkModule> =>
  typeof (value as { then?: unknown } | null)?.then === 'function'

/**
 * 峰/谷切换前弹窗提醒:距下次相位切换不足配置提前量(默认 2 分钟)时弹浮层,
 * 位置可选屏幕右下角 / 屏幕中心;提醒类型按配置过滤(进入峰/进入谷/峰和谷);
 * 同一切换点只弹一次(手动关闭即记点),切换完成后浮层自然消失。
 * 若开启 Web 通知且有授权,还会在同一切换点向系统发送一次浏览器通知。
 * 预览:window.cmPeakAlertPreview('peak'|'offpeak') 用真实组件/文案/位置/通知
 * 渲染一次弹窗(峰谷计价启用时常驻监听,提醒开关关闭也可预览)。
 */
export function PeakAlert(props: any) {
  const costStore = props.useCost ? props.useCost((s: CmState) => s) : undefined
  const config = costStore?.state?.config
  const [now, setNow] = useState(Date.now())
  const [dismissedAt, setDismissedAt] = useState(null as number | null)
  const [preview, setPreview] = useState(null as string | null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10000)
    return () => window.clearInterval(timer)
  }, [])
  // 预览通道:监听自定义事件(事件由 activate 顶层的 window.cmPeakAlertPreview 派发),
  // 组件挂载期间置在线标志,供 API 判断弹窗宿主是否可用。
  useEffect(() => {
    const onPreview = (event: any) => {
      const kind = event.detail?.kind === 'offpeak' ? 'offpeak' : 'peak'
      setPreview(kind)
      // 预览系统通知:遵循 Web 通知开关与授权,标题加预览标记。
      const cfg = costStore?.state?.config
      if (cfg?.peakAlertWebNotify === true && window.Notification && Notification.permission === 'granted') {
        const pt: T = makeT(resolveLocale(cfg))
        try {
          new Notification(pt(kind === 'peak' ? 'peakAlertTitlePeak' : 'peakAlertTitleOffPeak') + pt('peakAlertPreviewTag'),
            { body: pt('peakAlertBody', { time: pt('countdownMinute', { m: 2 }), phase: pt(kind === 'peak' ? 'peakAlertPhasePeak' : 'peakAlertPhaseOffPeak') }) })
        } catch (_) { /* 通知被系统拒绝时静默 */ }
      }
    }
    window.addEventListener(PEAK_ALERT_PREVIEW_EVENT, onPreview)
    // TODO(types): 预览通道在线标志挂在 window 上,待补 declare global 收紧(设置页也读它)。
    const w = window as any
    w.__cmPeakAlertLive = true
    return () => {
      window.removeEventListener(PEAK_ALERT_PREVIEW_EVENT, onPreview)
      w.__cmPeakAlertLive = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Web 通知:每次 tick 自包含重算切换点,按切换点(nextAtMs)在模块级去重,
    // 同一切换点只发一次(旧实现比较 tick 时间戳,每 10 秒都"未通知过",会连发)。
    if (!config || config.peakAlertEnabled !== true || config.peakEnabled !== true) return
    if (config.peakAlertWebNotify !== true || !window.Notification || Notification.permission !== 'granted') return
    const wv = peakPhaseAt(now, Array.isArray(config.peakWindows) ? config.peakWindows : [], config.peakHolidays)
    if (wv === null) return
    const tgt = config.peakAlertTarget === 'peak' || config.peakAlertTarget === 'offpeak' ? config.peakAlertTarget : 'both'
    const intoPeak = wv.nextIntoPeak === true
    if (tgt !== 'both' && tgt !== (intoPeak ? 'peak' : 'offpeak')) return
    const mins = Number(config.peakAlertAhead)
    const aheadMs = (Number.isFinite(mins) && mins >= 1 ? mins : 2) * 60000
    if (now < wv.nextAtMs - aheadMs || now >= wv.nextAtMs) return
    if (lastPeakNotifyAtMs === wv.nextAtMs) return
    const t: T = makeT(resolveLocale(config))
    lastPeakNotifyAtMs = wv.nextAtMs
    try {
      new Notification(
        t(intoPeak ? 'peakAlertTitlePeak' : 'peakAlertTitleOffPeak'),
        { body: t('peakAlertBody', { time: countdownText(wv, now, t), phase: t(intoPeak ? 'peakAlertPhasePeak' : 'peakAlertPhaseOffPeak') }) })
    } catch (_) { /* 通知被系统拒绝时静默 */ }
  }, [now]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!config || config.peakEnabled !== true) return null
  // 真实弹窗判定:提醒开关开启 + 已生效 + 相位/类型/提前量窗口内 + 未手动关闭。
  let real: any = null
  if (config.peakAlertEnabled === true) {
    const effectiveAtMs = Date.parse(config.peakEffectiveAt || '')
    if (!(Number.isFinite(effectiveAtMs) && now < effectiveAtMs)) {
      const view = peakPhaseAt(now, Array.isArray(config.peakWindows) ? config.peakWindows : [], config.peakHolidays)
      if (view !== null) {
        const target = config.peakAlertTarget === 'peak' || config.peakAlertTarget === 'offpeak' ? config.peakAlertTarget : 'both'
        const aheadMinutes = Number(config.peakAlertAhead)
        const aheadMs = (Number.isFinite(aheadMinutes) && aheadMinutes >= 1 ? aheadMinutes : 2) * 60000
        if ((target === 'both' || target === (view.nextIntoPeak ? 'peak' : 'offpeak'))
          && now >= view.nextAtMs - aheadMs && now < view.nextAtMs && dismissedAt !== view.nextAtMs) real = view
      }
    }
  }
  // 渲染:真实窗口激活用真实切换点;否则若有预览请求,用虚拟切换点(2 分钟后)。
  let view: any = null, intoPeak = false, dismiss: (() => void) | null = null
  if (real !== null) {
    view = real
    intoPeak = real.nextIntoPeak === true
    dismiss = () => setDismissedAt(real.nextAtMs)
  } else if (preview !== null) {
    view = { nextAtMs: now + 2 * 60000, nextIntoPeak: preview === 'peak' }
    intoPeak = preview === 'peak'
    dismiss = () => setPreview(null)
  } else return null
  const t: T = makeT(resolveLocale(config))
  const position = config.peakAlertPosition === 'center' ? 'cm-peak-alert-center' : 'cm-peak-alert-corner'
  return el('div', { className: 'cm-peak-alert ' + position + ' ' + (intoPeak ? 'cm-peak-alert-peak' : 'cm-peak-alert-offpeak'), role: 'alert' },
    el('div', { className: 'cm-peak-alert-badge' }, t(intoPeak ? 'peakAlertBadgePeak' : 'peakAlertBadgeOffPeak')),
    el('div', { className: 'cm-peak-alert-title' }, t(intoPeak ? 'peakAlertTitlePeak' : 'peakAlertTitleOffPeak')),
    el('div', { className: 'cm-peak-alert-body' }, t('peakAlertBody', {
      time: countdownText(view, now, t),
      phase: t(intoPeak ? 'peakAlertPhasePeak' : 'peakAlertPhaseOffPeak'),
    })),
    el('div', { className: 'cm-peak-alert-actions' },
      el('button', { className: 'cm-btn', onClick: dismiss }, t('peakAlertBtn'))))
}

/** 展开态简洁样式:单行紧凑时段条——细轨道(左橙右蓝,非当前段淡化)+ 标记线 + 右侧倒计时文本。 */
export function PeakStrip(props: any) {
  const { config, t } = props
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])
  const view = peakView(config, now)
  if (view === null) return null
  const keys = phaseLabelKeys(view)
  const chipText = view.nextIntoPeak
    ? t('nextPeakIn', { time: countdownText(view, now, t) })
    : t('nextOffPeakIn', { time: countdownText(view, now, t) })
  return el(Tooltip, { label: t(keys.notice), side: 'right', delayMs: 300 },
    el('div', { className: 'cm-peak-strip ' + (view.weekend || view.holiday ? 'weekend' : view.inPeak ? 'peak' : 'off') },
      el('div', { className: 'cm-peak-track' },
        el('div', { className: 'cm-peak-segment cm-peak-high' }),
        el('div', { className: 'cm-peak-segment cm-peak-low' }),
        el('div', { className: 'cm-peak-marker', style: { left: view.weekend || view.holiday ? '50%' : view.inPeak ? '25%' : '75%' } })),
      el('span', { className: 'cm-peak-chip' }, t(keys.chip) + ' · ' + chipText)))
}

/** 展开态经典样式:轨道 + 箭头旗标 + 胶囊芯片(两行)。 */
export function PeakStripClassic(props: any) {
  const { config, t } = props
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])
  const view = peakView(config, now)
  if (view === null) return null
  const keys = phaseLabelKeys(view)
  const chipText = view.nextIntoPeak
    ? t('nextPeakIn', { time: countdownText(view, now, t) })
    : t('nextOffPeakIn', { time: countdownText(view, now, t) })
  return el(Tooltip, { label: t(keys.notice), side: 'right', delayMs: 300 },
    el('div', { className: 'cm-peak-classic ' + (view.weekend || view.holiday ? 'weekend' : view.inPeak ? 'peak' : 'off') },
      el('div', { className: 'cm-peak-classic-marker', style: { left: view.weekend || view.holiday ? '50%' : view.inPeak ? '25%' : '75%' } }),
      el('div', { className: 'cm-peak-track' },
        el('div', { className: 'cm-peak-segment cm-peak-high' }),
        el('div', { className: 'cm-peak-segment cm-peak-low' })),
      el('span', { className: 'cm-peak-classic-chip' }, t(keys.chip) + ' · ' + chipText)))
}

/**
 * 展开态峰谷条的调用点(预算图框 budgetBoxBody 的尾部、简化摘要/页脚都用它)。
 * `state` 参数保留以维持原调用签名(旧实现里未使用)。
 */
export function peakNoticeEl(state: CmState, config: CmConfig, t: T) {
  if (config?.peakStyle === 'classic') return el(PeakStripClassic, { config, t })
  if (config?.peakStyle === 'dynamic' && peakLoad !== null) return el(PeakLazy, { config, t })
  return el(PeakStrip, { config, t })
}

/** 收起(rail)态简洁样式:竖向同构时段条 + 横排短词(「峰时/平价」),倒计时与完整文案在悬停提示中。 */
export function PeakRailStrip(props: any) {
  const { config, t } = props
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])
  const view = peakView(config, now)
  if (view === null) return null
  const keys = phaseLabelKeys(view)
  const chipText = view.nextIntoPeak
    ? t('nextPeakIn', { time: countdownText(view, now, t) })
    : t('nextOffPeakIn', { time: countdownText(view, now, t) })
  const detail = [t(keys.notice), chipText]
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-peak-rail ' + (view.weekend || view.holiday ? 'weekend' : view.inPeak ? 'peak' : 'off'), 'aria-label': detail.join('; ') },
      el('div', { className: 'cm-peak-rail-track' },
        el('div', { className: 'cm-peak-rail-segment cm-peak-rail-high' }),
        el('div', { className: 'cm-peak-rail-segment cm-peak-rail-low' }),
        el('div', { className: 'cm-peak-rail-marker', style: { top: view.weekend || view.holiday ? '50%' : view.inPeak ? '25%' : '75%' } })),
      el('span', { className: 'cm-peak-rail-label' }, t(keys.short))))
}

/** 收起(rail)态经典样式:竖向胶囊条——上橙下蓝满色分段(与展开态一致,不淡化不填充),标记指向当前时段,下方横排短词。 */
export function PeakRailStripClassic(props: any) {
  const { config, t } = props
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])
  const view = peakView(config, now)
  if (view === null) return null
  const keys = phaseLabelKeys(view)
  const chipText = view.nextIntoPeak
    ? t('nextPeakIn', { time: countdownText(view, now, t) })
    : t('nextOffPeakIn', { time: countdownText(view, now, t) })
  const detail = [t(keys.notice), chipText]
  return el(Tooltip, { label: detail, side: 'right', delayMs: 300 },
    el('div', { className: 'cm-peak-rail-classic ' + (view.weekend || view.holiday ? 'weekend' : view.inPeak ? 'peak' : 'off'), 'aria-label': detail.join('; ') },
      el('div', { className: 'cm-peak-rail-classic-track' },
        el('div', { className: 'cm-peak-rail-classic-segment peak' }),
        el('div', { className: 'cm-peak-rail-classic-segment off' }),
        el('div', { className: 'cm-peak-rail-classic-marker', style: { top: view.weekend || view.holiday ? '50%' : view.inPeak ? '25%' : '75%' } })),
      el('span', { className: 'cm-peak-rail-classic-label' }, t(keys.short))))
}

/**
 * 动态样式外壳:首次渲染即发起分块请求(幂等,只请求一次)。peakChunk 在请求
 * 期间保存 Promise,resolve 后保存组件;两者必须区分——把 Promise 当元素类型
 * 交给 React 会直接抛 "Element type is invalid" 并把整页打白。
 * 未就绪与加载失败时不渲染这一行;resolve 后主动 bump 一次,让图框立刻换成
 * 动态样式(不依赖 30 秒心跳或配置轮询)。分块自行维持时刻心跳,主包不传时刻。
 */
export function PeakLazy(props: any) {
  const [, bump] = useState(0)
  if (peakChunk === null) {
    // peakNoticeEl/peakNoticeRailEl 已判空;这里再兜底一次,避免未注入加载器时抛错。
    if (peakLoad === null) return null
    const pending = peakLoad()
    peakChunk = pending
    pending.then((mod: PeakChunkModule) => {
      const mounted = mod?.mount?.()
      if (mounted == null) { peakChunk = null; return } // 分块形态不对:退回未就绪,可重试
      peakChunk = mounted
      bump(1)
    }, () => { peakChunk = null })
  }
  if (isPromiseLike(peakChunk)) return null
  return el(peakChunk, props)
}

/** 收起态峰谷条的调用点(侧栏 rail 态页脚用它)。`state` 参数保留以维持原调用签名。 */
export function peakNoticeRailEl(state: CmState, config: CmConfig, t: T) {
  if (config?.peakStyle === 'classic') return el(PeakRailStripClassic, { config, t })
  if (config?.peakStyle === 'dynamic' && peakLoad !== null) return el(PeakLazy, { config, t, rail: true })
  return el(PeakRailStrip, { config, t })
}
