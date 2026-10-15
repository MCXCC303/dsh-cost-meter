/**
 * 浏览器启动包入口(dsh-cost-meter 客户端半)。
 *
 * 平台契约(@deepseek-ai/dsh-client-modules):
 *   * 本文件被打包成一个 **classic script**,由 `/plugins/<pkg>/client.js` 直接
 *     `<script src>` 引入(可能被拼进 combo 脚本),因此产物里不能有顶层
 *     import/export 语句;
 *   * 注册方式固定为 `window.__ModuleLoader__.load({ id, factory })`。执行脚本只
 *     **登记 factory**,模块体副作用(含样式注入)在 factory 物化时才发生;
 *   * 平台 `require` 只作为 factory 入参注入(全局没有 require),`react` 与
 *     `@deepseek-ai/dsh-client-ui-primitives` 是仅有的种子;包内分块用
 *     `require.async('./client.<name>.js')` 取回;
 *   * **factory 的返回值就是 cordis 插件对象**(vendored Loader 读取 `apply` /
 *     `inject` 后激活),所以本模块在顶层导出 `inject` 与 `apply(ctx)`。
 *
 * 构建壳(scripts/build.mjs 的 banner/footer)两种收尾都兼容:
 *   * `return module.exports` —— Loader 直接拿到 `{ inject, apply }`(当前脚本的形态);
 *   * `return module.exports.activate(require)` —— `activate` 识别出"被传入的是
 *     平台 require 函数"并返回同一个插件对象(见 `activate` 的双形态说明)。
 *
 * `require` 的取法:构建壳把整段 bundle 放进 `factory: (require) => {…}` 的**词法
 * 作用域**内,所以模块里的自由标识符 `require` 就是 factory 入参(cjs 输出不会把它
 * 改写成 `__require`)。`platformRequire()` 是唯一取用处,并带运行时守卫。
 *
 * 激活前置门槛(注册要真正发生,以下条件须依次成立):
 *   1. `ctx.remote` 存在且 `$mount` 是函数(否则 apply 立即 return);
 *   2. `await remote.$mount(CONTRIBUTION)` 成功;
 *   3. `ctx.get('remote.costMeter')` 非 undefined(否则 return);
 *   4. `ctx.get('slots')` 非 undefined —— slot 注册的硬门槛(否则 return);
 *   5. `slots.inject(name, cb)` 的 **cb 由平台在槽位声明可达时调用**,`slots.register`
 *      必须写在 cb 里(桩若同步调用 cb,常驻注册立刻可见);
 *   6. 配置驱动的注册挂 `store.subscribe(sync)` + 首次 `sync()`;首次 sync 时
 *      `reload()` 尚未 resolve(state=null),此时按默认值注册会话徽章(dock)与
 *      设置分节,state 就绪后再补页脚/峰谷提醒等;
 *   7. 浏览器 API(`window.addEventListener` / `document.addEventListener`)只在
 *      DOM 存在时挂接(与旧实现等价,但纯 Node 桩不会因此中断注册)。
 *
 * 模块划分:设置面板 / 计费统计 / 价格目录 / 动态峰谷样式在 `lib/client.<name>.js`
 * 分块按需加载;本文件只保留"一进页面就要显示"的侧栏、会话徽标与峰谷提醒,
 * 以及 store 轮询、RPC api 与全部 slot 注册。
 */
import React from 'react'
import { CONTRIBUTION, makeStore } from './logic.js'
import { MESSAGES } from './i18n-messages.js'
import { createStyleTag, detectBrowserLocale, makeT, resolveLocale, supportedLocale, USAGE_POSITION_SWITCHABLE } from './t.js'
import { BalanceClickGuide, QuotaStripGuide, SidebarSimpleGuide } from './guides.js'
import { DockLine, SessionCost, TurnCost } from './ui-badge.js'
import { PEAK_ALERT_PREVIEW_EVENT, PeakAlert, setPeakLoader } from './ui-peak.js'
import { SidebarFooter } from './ui-sidebar.js'
import { QuotaStrip } from './ui-quota.js'

const { createElement: el, useState, useEffect } = React

/** 分块名 → `require.async` 路径(必须与 scripts/build.mjs 的 CLIENT_CHUNKS 一致)。 */
const CHUNKS = {
  peak: './client.peak.js',
  settings: './client.settings.js',
  statistics: './client.statistics.js',
  openrouter: './client.openrouter.js',
} as const

/** 平台 `require`:同步取种子模块,异步取包内分块(`lib/client.<name>.js`)。 */
export interface ClientRequire {
  (id: string): any
  async(id: string): Promise<Record<string, any>>
}

// 样式表注入:与旧片段同址(模块作用域 = factory 体内),HMR 换代码时按内容比对更新。
// TODO(types): document 在纯 Node 环境不存在,沿用旧片段的运行时守卫。
if (typeof document !== 'undefined') createStyleTag()

/**
 * 取平台 `require`(见文件头说明:自由标识符 `require` 即 factory 入参)。
 *
 * TODO(types): 平台的 `require.async` 不在 @types/node 的 NodeRequire 上,边界 any;
 * 若基座给 `ClientRequire` 提供全局声明,这里可换成直接引用。
 */
function platformRequire(): ClientRequire {
  return require as any
}

/**
 * 按需分块组件:slot 注册是同步的,而分块只在首次渲染该槽位时才取回。
 * `pick` 从分块模块里取出组件(settings 分块:`mount()` → CostSection,`UsagePanel`)。
 *
 * TODO(types): props 由宿主 slot 注入,暂用 any。
 */
function lazyChunkComponent(name: keyof typeof CHUNKS, pick: (module: any) => any) {
  let pending: Promise<any> | null = null
  const load = () => {
    if (pending === null) {
      pending = platformRequire().async(CHUNKS[name]).then(module => pick(module))
        .catch(error => { pending = null; throw error })
    }
    return pending
  }
  return function ChunkComponent(props: any) {
    const [Component, setComponent] = useState(null)
    useEffect(() => {
      let alive = true
      // 加载失败保持渲染空(设置面板下次打开会重试,分块加载器内部也会重试)。
      void load().then(C => { if (alive && typeof C === 'function') setComponent(() => C) }).catch(() => {})
      return () => { alive = false }
    }, [])
    return Component === null ? null : el(Component, props)
  }
}

// 设置分块的两个组件:费用分节本体与 Token 用量面板(默认位置已固定在费用分节内)。
const CostSectionLazy = lazyChunkComponent('settings', module => (typeof module.mount === 'function' ? module.mount() : null))
const UsagePanelLazy = lazyChunkComponent('settings', module => module.UsagePanel)

/** cordis 插件依赖声明(与旧片段 `exports.inject` 同值)。 */
export const inject = ['remote']

/**
 * 全部 slot 注册(与宿主时序无关的部分抽成独立函数,便于测试桩与失败定位)。
 *
 * 调用前提:调用方已确认 `ctx.get('slots')` 非 undefined,并备好
 * `injected`(slot 注入的 `{ hooks: { cost: store }, api }`)与
 * `runtime`(store + 两个设置分块组件)。
 *
 * 返回配置驱动的 `sync()`:由 apply 在 store 订阅上调用 —— 会话徽章位置、页脚显隐、
 * 峰谷提醒、设置分节语言都以此为唯一入口(与原实现一致)。
 *
 * TODO(types): slots / injected / runtime 属宿主边界,暂用 any。
 */
export function registerSlots(slots: any, injected: () => any, runtime: { store: any; CostSection: any; UsagePanel: any }): () => void {
  const { store, CostSection, UsagePanel } = runtime

  // TODO(migrate): 旧实现还在 header/dock 另注册 `SessionStatisticsButton`
  // (id `cost-meter-statistics`,order 1)。该组件已随设置面板迁到
  // `client.settings.js`(settings.ts 导出),而启动包不能静态 import 分块,
  // 故这里暂缺该入口;需要在基座侧把它挪回启动包模块(或拆独立小分块)后补上。

  slots.inject('conversation.chat.turnTail', () => slots.register({ name: 'conversation.chat.turnTail', id: 'cost-meter-turn', order: 10, inject: injected }, TurnCost))
  // 通用插槽注册去重:共享「失效旧注册→bump gen→注入→生成期护栏→记录 dispose→卸载清理」逻辑。
  const slotActive = () => ({ gen: 0, dispose: null as null | (() => void) })
  const registerSlot = (active_: { gen: number; dispose: null | (() => void) }, slotName: string, options: any, component: any, enabled = true) => {
    if (active_.dispose !== null) { active_.dispose(); active_.dispose = null }
    active_.gen += 1
    const gen = active_.gen
    if (!enabled) return
    slots.inject(slotName, () => {
      if (active_.gen !== gen) return
      const dispose = typeof options === 'function' ? options() : slots.register(options, component)
      if (active_.gen !== gen) { dispose(); return }
      active_.dispose = dispose
      return () => { if (active_.dispose === dispose) active_.dispose = null; dispose() }
    })
  }

  // 会话徽章按配置位置注册;配置变化时先撤销旧注册再重建。
  const sessionActive = slotActive()
  const registerSession = (position: string) => {
    const slotName = position === 'header' ? 'conversation.session.header.actions' : 'conversation.composer.dock'
    const options = position === 'header' ? { name: slotName, id: 'cost-meter', order: -5, inject: injected } : { name: slotName, id: 'cost-meter', order: 5, inject: injected }
    registerSlot(sessionActive, slotName, options, position === 'header' ? SessionCost : DockLine, position !== 'off')
  }
  const footerActive = slotActive()
  const registerFooter = (enabled: boolean) => {
    registerSlot(footerActive, 'sidebar.footer.action', { name: 'sidebar.footer.action', id: 'cost-meter', order: 0, inject: injected }, SidebarFooter, enabled)
  }
  const cornerActive = slotActive()
  const registerCorner = (enabled: boolean) => {
    // TODO(migrate): 依赖旧片段 1882–1958 行的 `CornerChips`(右下角角标),
    // 尚未迁移到任何 ui-*.ts;组件落地后在此 registerSlot(cornerActive, ...)。
    void cornerActive
    void enabled
  }
  // 输入框上方额度横条(conversation.input.dock 渲染于输入卡片上方):静态注册,
  // 组件内部按 quotaStrip.enabled 门控,无可用数据时整条隐藏。
  slots.inject('conversation.input.dock', () => {
    const dispose = slots.register(
      { name: 'conversation.input.dock', id: 'cost-meter-qstrip', order: 5, inject: injected },
      QuotaStrip,
    )
    return dispose
  })
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'cost-meter-simple-guide', order: 1, inject: injected }, SidebarSimpleGuide))
  // 首次更新引导:常驻 sidebar.footer.action 挂载,组件内部按 promptSeen 门控。
  slots.inject('sidebar.footer.action', () => {
    const dispose = slots.register(
      { name: 'sidebar.footer.action', id: 'cost-meter-qstrip-guide', order: 1, inject: injected },
      QuotaStripGuide,
    )
    return dispose
  })
  // 更新后的提醒(issue #37):余额/额度图框点击刷新,常驻插槽 + clickHintSeen 门控。
  slots.inject('sidebar.footer.action', () => {
    const dispose = slots.register(
      { name: 'sidebar.footer.action', id: 'cost-meter-balance-click-guide', order: 2, inject: injected },
      BalanceClickGuide,
    )
    return dispose
  })

  // 峰/谷切换前弹窗提醒:全局 fixed 浮层(fixed 定位与宿主位置无关),挂在常驻的
  // sidebar.footer.action 插槽——conversation.composer.dock 仅在有活跃会话的页面渲染,
  // 挂那里会导致 hero/设置页不弹提醒、预览按钮失效(issue:预览点了没反应)。
  // 组件内部再按配置门控(peakAlertEnabled + peakEnabled);开关变化时重挂/卸载。
  const peakAlertActive = slotActive()
  const registerPeakAlert = (enabled: boolean) => {
    registerSlot(peakAlertActive, 'sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'cost-meter-peak-alert', order: 0, inject: injected }, PeakAlert), null, enabled)
  }
  // 预览 API 在 activate 顶层注册(不依赖任何插槽挂载):设置页按钮与控制台均经
  // 此入口派发事件;弹窗宿主组件挂载时置 __cmPeakAlertLive,未挂载时给出可诊断提示。
  // TODO(types): window 上的预览入口与 __cmPeakAlertLive 探针属宿主边界。
  if (typeof window !== 'undefined') (window as any).cmPeakAlertPreview = (kind: string) => {
    if ((window as any).__cmPeakAlertLive !== true) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-cost-meter] 弹窗组件未挂载:需启用峰谷计价并重启 dsh web 后再预览。')
      return
    }
    window.dispatchEvent(new CustomEvent(PEAK_ALERT_PREVIEW_EVENT, { detail: { kind: kind === 'offpeak' ? 'offpeak' : 'peak' } }))
  }

  // 设置页「费用/Cost」分节:语言变化时撤销旧注册并重建,让侧边栏标签同步。
  // 分块按需加载(mount() → CostSection),槽位注册先挂懒加载包装。
  const sectionActive = slotActive()
  const registerSection = (locale: 'zh' | 'en') => {
    registerSlot(sectionActive, 'settings.section', { name: 'settings.section', id: 'cost-meter', order: 30, label: locale === 'en' ? MESSAGES.en.sectionLabel : MESSAGES.zh.sectionLabel, inject: injected }, CostSection, true)
  }
  // Token 用量统计「通用设置」行(position = general 时,注入宿主通用设置页的 settings.general.item 插槽)。
  const generalUsageActive = slotActive()
  const registerGeneralUsage = (enabled: boolean) => {
    registerSlot(generalUsageActive, 'settings.general.item', { name: 'settings.general.item', id: 'cost-meter-usage', order: 30, inject: injected }, UsagePanel, enabled)
  }
  // Token 用量统计「独立分节」(position = section 时,像「费用」一样拥有自己的设置导航项)。
  const usageSectionActive = slotActive()
  const registerUsageSection = (enabled: boolean, locale: 'zh' | 'en') => {
    registerSlot(usageSectionActive, 'settings.section', { name: 'settings.section', id: 'cost-meter-usage', order: 31, label: locale === 'en' ? MESSAGES.en.usageSectionLabel : MESSAGES.zh.usageSectionLabel, inject: injected }, UsagePanel, enabled)
  }
  let lastPosition: string | null = null
  let lastFooter: boolean | null = null
  let lastCorner: boolean | null = null
  let lastSectionLocale: 'zh' | 'en' | null = null
  let lastUsagePosition: string | null = null
  let lastPeakAlert: boolean | null = null
  const sync = () => {
    const state = store.getSnapshot().state
    const position = state?.config?.position ?? 'dock'
    const showToday = state?.config?.sidebar !== false && state?.config?.hideTodayCost !== true
    const balanceDisplay = state?.config?.balance?.display ?? 'both'
    const showBalance = (balanceDisplay === 'sidebar' || balanceDisplay === 'both') && state?.config?.hideOfficialBalance !== true
    const footer = showToday || showBalance || state?.config?.codexQuotaEnabled === true || state?.config?.sidebarModels?.enabled === true
    const cornerEnabled = state?.config?.corner?.enabled === true || state?.config?.sidebarModels?.dock === true
    const sectionLocale = resolveLocale(state?.config || { activeLocale: store.getSnapshot().locale })
    const usagePosition = state?.config?.usage?.position ?? 'cost'
    if (position !== lastPosition) {
      registerSession(position)
      lastPosition = position
    }
    if (footer !== lastFooter) {
      registerFooter(footer)
      lastFooter = footer
    }
    if (cornerEnabled !== lastCorner) {
      registerCorner(cornerEnabled)
      lastCorner = cornerEnabled
    }
    // 峰谷计价启用即常驻挂载(提醒开关关闭时也保留组件,供设置页预览弹窗)。
    const peakAlertOn = state?.config?.peakEnabled === true
    if (peakAlertOn !== lastPeakAlert) {
      registerPeakAlert(peakAlertOn)
      lastPeakAlert = peakAlertOn
    }
    if (sectionLocale !== lastSectionLocale) {
      registerSection(sectionLocale)
      lastSectionLocale = sectionLocale
    }
    if (usagePosition !== lastUsagePosition) {
      if (USAGE_POSITION_SWITCHABLE) {
        registerGeneralUsage(usagePosition === 'general')
        registerUsageSection(usagePosition === 'section', sectionLocale)
      }
      lastUsagePosition = usagePosition
    } else if (USAGE_POSITION_SWITCHABLE && usagePosition === 'section' && sectionLocale !== lastSectionLocale) {
      registerUsageSection(true, sectionLocale)
    }
  }
  return sync
}

/**
 * 插件主体(对照旧片段 `03-settings-panels-main.js` 2718–3021 行):
 * remote 挂载 → store 轮询 → RPC api → slot 注册。
 *
 * 平台经 cordis Loader 调用本函数;测试桩/手动挂载可调同体的 `activate(ctx)`。
 *
 * TODO(types): ctx 为宿主 cordis 上下文(remote/locale/slots/fiber 服务),暂用 any。
 */
export async function apply(ctx: any) {
  const remote = ctx.remote
  if (remote === undefined || typeof remote.$mount !== 'function') return
  const unmount = await remote.$mount(CONTRIBUTION)
  ctx.effect(() => () => { unmount() }, 'cost-meter: remote contribution')
  const costMeter = ctx.get('remote.costMeter')
  if (costMeter === undefined) return
  const readLocale = () => {
    try { return supportedLocale(ctx.get('locale')?.getSnapshot?.().active) }
    catch { return null }
  }
  const store = makeStore({ status: 'loading', error: null, state: null } as any, (snapshot: any) => {
    const locale = readLocale() || supportedLocale(snapshot.state?.meta?.locale) || detectBrowserLocale()
    return { ...snapshot, locale, ...(snapshot.state ? { state: { ...snapshot.state, config: { ...snapshot.state.config, activeLocale: locale } } } : {}) }
  })

  // RPC 层错误兜底文案(按当前配置语言)。
  const rpcT = () => makeT(resolveLocale(store.getSnapshot().state?.config || { activeLocale: store.getSnapshot().locale }))

  const call = async (method: string, args?: any[]) => {
    const result = await costMeter[method](...(args ?? []))
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      throw new Error(result?.error?.message ?? rpcT()('rpcFailed', { method }))
    }
    return result.value
  }
  let lastPoll = Date.now()
  let reloading = false
  let active = true, retrySeconds = 1
  const reload = async () => {
    if (!active || reloading) return // 并发防抖:轮询/手动刷新/重连不叠加 getState,避免乱序覆盖
    reloading = true
    lastPoll = Date.now()
    const prev = store.getSnapshot()
    if (prev.state === null) store.set({ ...prev, status: 'loading' })
    try {
      const state = await call(prev.state === null ? 'getLocalState' : 'getState')
      if (!active) return
      retrySeconds = 1
      store.set({ status: 'ready', error: null, state })
      if (prev.state === null) {
        const fresh = await call('getState')
        if (active) store.set({ status: 'ready', error: null, state: fresh })
      }
      // activeLocale 只属于本客户端快照,持久化配置始终保留 auto。
    } catch (error: any) {
      if (!active) return
      if (prev.state === null) lastPoll = Date.now()
      retrySeconds = Math.min(retrySeconds * 2, 60)
      store.set({ status: 'error', error: error?.message ?? String(error), state: store.getSnapshot().state ?? prev.state })
    } finally {
      reloading = false
    }
  }
  ctx.effect(() => ctx.on('connection/reset', () => { void reload() }), 'cost-meter: reconnect reload')
  // 侧边栏「今日费用/余额」与设置页看板依赖 getState 快照渲染,没有推送通道:
  // 默认 60s 轮询,启用模型卡片时按其 10–60s 设置(页面隐藏时跳过) + visibilitychange 重新可见时立即刷新,避免冻结在加载时刻(#3)。
  const pollTimer = setInterval(() => {
    const state = store.getSnapshot().state, cfg = state?.config.sidebarModels
    // 热安装首屏可早于 Host RPC 注册；失败后按 2/4/8/.../60 秒恢复，只重试读取。
    const seconds = !state ? retrySeconds : cfg?.enabled || cfg?.dock ? cfg.refreshSeconds : 60
    if (!(typeof document !== 'undefined' && document.hidden) && Date.now() - lastPoll >= (seconds || 60) * 1000) void reload()
  }, 1000)
  ctx.effect(() => () => { active = false; clearInterval(pollTimer) }, 'cost-meter: poll timer')
  const refreshLocale = () => { if (active && ctx.fiber?.uid !== null) store.set(store.getSnapshot()) }
  const bindLocale = (child: any) => child.effect(() => {
    refreshLocale()
    const stop = child.get('locale')?.subscribe?.(refreshLocale)
    return () => { stop?.(); refreshLocale() }
  }, 'cost-meter: DSH locale')
  // Native bootstrap may provide locale after this plugin; inject observes arrival/removal.
  // 注意:宿主只在 locale 服务就绪后回调 bindLocale(桩环境忽略该回调时只影响语言联动)。
  if (typeof ctx.inject === 'function') ctx.inject(['locale'], bindLocale)
  else if (readLocale()) bindLocale(ctx)
  ctx.effect(() => ctx.on('locale/change', refreshLocale), 'cost-meter: locale change')
  // DOM 相关监听只在浏览器存在时挂接(纯 Node 桩不因此中断后续 slot 注册)。
  if (typeof window !== 'undefined') {
    window.addEventListener?.('languagechange', refreshLocale)
    ctx.effect(() => () => window.removeEventListener?.('languagechange', refreshLocale), 'cost-meter: browser locale')
  }
  if (typeof document !== 'undefined') {
    const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
    document.addEventListener('visibilitychange', onVisible)
    ctx.effect(() => () => { document.removeEventListener('visibilitychange', onVisible) }, 'cost-meter: visibility reload')
  }

  const receive = async (promise: Promise<any>, errorKey = 'rpcSyncFailed', valueMessage = false) => {
    const result = await promise
    if (result === null || typeof result !== 'object' || result.ok !== true) throw new Error(result?.error?.message ?? (valueMessage ? result?.value?.message : undefined) ?? rpcT()(errorKey))
    if (result.value.state !== undefined) store.set({ status: 'ready', error: null, state: result.value.state })
    return result.value
  }
  const pages: Record<string, Promise<any>> = {}
  const loadPage = (name: 'statistics' | 'openrouter') => {
    if (!pages[name]) {
      const platform = platformRequire()
      pages[name] = (typeof platform.async === 'function'
        ? platform.async(CHUNKS[name]).then(module => module.mount(ctx, store, resolveLocale))
        : Promise.reject(new Error(rpcT()('statisticsUpgrade')))).catch(error => { delete pages[name]; throw error })
    }
    return pages[name]
  }
  const api = {
    loadStatistics: () => loadPage('statistics'),
    loadOpenRouter: () => loadPage('openrouter'),
    reload,
    updateConfig: async (patch: any) => {
      const { activeLocale: _local, ...savedPatch } = patch
      const state = await call('updateConfig', [savedPatch])
      store.set({ status: 'ready', error: null, state })
      return state
    },
    fetchPrices: async () => receive(costMeter.fetchPrices()),
    resetHistory: async () => {
      const state = await call('resetHistory')
      store.set({ status: 'ready', error: null, state })
      return state
    },
    // 导入安装前历史(issue #27):返回 { ok, message, state? },成功时刷新本地快照。
    importLegacyHistory: async () => {
      const result = await costMeter.importLegacyHistory()
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new Error(result?.error?.message ?? result?.value?.message ?? rpcT()('legacyImportFailed', { message: 'RPC failed' }))
      }
      if (result.value.state !== undefined) store.set({ status: 'ready', error: null, state: result.value.state })
      return result.value
    },
    // 按需拉取某天会话明细(issue #22),返回当日完整记录。
    getDaySessions: async (date: string) => call('getDaySessions', [date]),
    // 跨全部日期的会话排行(issue #22 不分日期视角):支持费用/时间升降序与实时顺序。
    getSessionCost: async (id: string) => call('getSessionCost', [id]),
    getTurnCost: async (id: string, start: number, end: number) => call('getTurnCost', [id, start, end]),
    getTopSessions: async (limit: number, sort: string, dir: string) => call('getTopSessions', [limit, sort, dir]),
    refreshBalance: async () => receive(costMeter.refreshBalance(), 'rpcBalanceFailed'),
    refreshGoQuota: async () => receive(costMeter.refreshGoQuota()),
    refreshGatewayQuota: async (sourceId: string | null = null) => receive(sourceId == null ? costMeter.refreshGatewayQuota() : costMeter.refreshGatewayQuota(sourceId)),
    refreshCustomBalance: async (index: number | null = null) => receive(index == null ? costMeter.refreshCustomBalance() : costMeter.refreshCustomBalance(index)),
    refreshCodingPlan: async (provider: string) => receive(costMeter.refreshCodingPlan(provider)),
    loginCodingPlan: async (provider: string) => receive(costMeter.loginCodingPlan(provider)),
    // 密钥写入/清除(v1.6.8):值只沿此通道单向送入 DSH 凭据库,服务端永不回传明文。
    setCredential: async (target: string, value: string) => receive(costMeter.setCredential(target, value), 'rpcSyncFailed', true),
    clearCredential: async (target: string) => receive(costMeter.clearCredential(target), 'rpcSyncFailed', true),
  }

  const loadModelPrices = (event: any) => {
    if (event.target?.closest?.('[data-slot="conversation.input.model"]')) void api.loadOpenRouter().catch(() => {})
  }
  if (typeof document !== 'undefined') for (const event of ['pointerover', 'focusin']) ctx.effect(() => {
    document.addEventListener(event, loadModelPrices)
    return () => document.removeEventListener(event, loadModelPrices)
  })
  void reload()

  const slots = ctx.get('slots')
  if (slots === undefined) return
  const contextPrices = (name: string) => {
    if (typeof slots.entries === 'function' && slots.entries(name).some((entry: any) => entry.locale === 'dsh-context')) void api.loadStatistics().catch(() => {})
  }
  ctx.on('slots/changed', contextPrices)
  for (const name of ['conversation.view', 'sidebar.right.pane.tab', 'conversation.input.overlay']) contextPrices(name)

  // 动态峰谷样式按需加载:把分块加载器交给 ui-peak(主包不内联该样式)。
  setPeakLoader(() => platformRequire().async(CHUNKS.peak))
  const injected = () => ({ hooks: { cost: store }, api })
  const sync = registerSlots(slots, injected, { store, CostSection: CostSectionLazy, UsagePanel: UsagePanelLazy })
  sync()
  const stopSync = store.subscribe(sync)

  ctx.effect(() => () => { stopSync() }, 'cost-meter: slot sync')
  return stopSync
}

/**
 * 入口别名(双形态):
 *   * `activate(ctx)` —— 与插件 `apply` 同体,测试桩/手动挂载可直接 await;
 *   * `activate(require)` —— 构建壳若收尾成 `return module.exports.activate(require)`,
 *     传入的是平台 require 函数,此时返回 cordis 插件对象 `{ inject, apply }`。
 *
 * 平台侧正常路径是 Loader 直接读模块导出的 `apply` / `inject`。
 */
export function activate(ctxOrRequire: any) {
  if (typeof ctxOrRequire === 'function') return { inject, apply }
  return apply(ctxOrRequire)
}
