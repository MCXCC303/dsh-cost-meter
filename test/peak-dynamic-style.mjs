/**
 * 峰谷时段条「动态」样式:按需分块渲染 + 主包懒加载接线。
 *
 * 该样式整块放在 lib/client.peak.js(主客户端贴着 DSH STORE 256 KiB 单文件上限,
 * 主包只保留按需加载外壳与简洁样式兜底),本测试加载**构建产物**并锁定三层不变式:
 *   A. 分块可独立加载、向平台注册为 client.peak.js,导出 mount,并按时长比例给出
 *      五段(09/3/2/4/6 小时);
 *   B. 刻度位置取「北京日内的已过比例」,与计价窗口同一时区口径,边到边映射 0–100%;
 *   C. 主包产物激活后按 peakStyle 分派:compact/classic 直接渲染且**不**请求分块;
 *      dynamic 走懒加载外壳(pending 返回 null,绝不把 Promise 当元素类型交给
 *      React——旧实现那样做会抛 "Element type is invalid" 把整页打白),
 *      分块 resolve 后立刻换成动态样式。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { loadArtifact } from './helpers/load-artifact.mjs'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
/** 等一轮宏任务:分块 require.async 与外壳的 .then 链都在微任务里完成。 */
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }

/** 极简 React 宿主:支持函数组件、useState/useEffect/useRef,足够跑一遍渲染。
 *  mount()/createRoot() 按真实 React 的语义循环跑 effect + 重渲染,才能覆盖「异步
 *  加载后换组件」这条路径——外壳早期版本把未 resolve 的 Promise 当成元素类型交给
 *  React,会直接抛 "Element type is invalid" 把设置页整页打白,静态渲染测不出这个
 *  缺陷;这里让 createElement 对 Promise 元素类型直接抛同样的错。 */
function host() {
  let current = null
  const el = (type, props, ...children) => {
    if (type !== null && (typeof type === 'object' || typeof type === 'function') && typeof type.then === 'function') {
      throw new Error('Element type is invalid: expected a string or a class/function but got a Promise')
    }
    return { type, props: props ?? {}, children }
  }
  const React = {
    Fragment: 'fragment',
    createElement: el,
    useState(init) {
      const owner = current
      const key = owner.cursor++
      const slot = owner.hooks[key] ?? (owner.hooks[key] = { value: typeof init === 'function' ? init() : init })
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; owner.dirty = true }]
    },
    useEffect(effect) {
      const owner = current
      const key = owner.cursor++
      const slot = owner.hooks[key] ?? (owner.hooks[key] = {})
      if (slot.ran !== true) { slot.ran = true; owner.effects.push(() => { slot.cleanup = effect() }) }
    },
    useRef(value) {
      const owner = current
      const key = owner.cursor++
      return owner.hooks[key] ?? (owner.hooks[key] = { current: value ?? null })
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useContext() { return undefined },
    createContext() { return { Provider: 'Provider', Consumer: 'Consumer' } },
    forwardRef(fn) { return fn },
    memo(fn) { return fn },
  }
  // 每次调用函数组件都给一个独立的 hook 宿主:静态 render() 只需跑通一次, hook 值
  // 不跨渲染保留;需要「加载完成后换组件」的场景用 createRoot() 单实例循环。
  const call = (fn, props) => {
    const owner = { hooks: [], effects: [], dirty: false, cursor: 0 }
    const prev = current
    current = owner
    try { return fn(props) } finally { current = prev }
  }
  const renderNode = node => {
    if (Array.isArray(node)) return node.map(renderNode)
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') return { ...node, children: [renderNode(call(node.type, node.props))] }
    return { ...node, children: (node.children ?? []).map(renderNode) }
  }
  const flatten = node => {
    if (Array.isArray(node)) return node.flatMap(flatten)
    if (node === null || typeof node !== 'object') return node == null ? [] : [node]
    if (typeof node.type === 'function') return flatten(call(node.type, node.props))
    return [{ props: {}, ...node }, ...flatten(node.children ?? [])]
  }
  /** 渲染一个组件并按 React 语义循环到稳定(含 effect 触发的重渲染)。 */
  const mount = (Component, props) => {
    const owner = { hooks: [], effects: [], dirty: true, cursor: 0 }
    let guard = 0
    do {
      assert.ok(++guard < 20, 'no synchronous update loop')
      owner.dirty = false
      owner.cursor = 0
      owner.effects = []
      current = owner
      owner.tree = Component(owner.props = props)
      current = null
      for (const effect of owner.effects) effect()
    } while (owner.dirty)
    return owner.tree
  }
  /** 持久实例:同一 hook 槽位可反复渲染(用于 pending → resolve → 切换)。 */
  const createRoot = (Component, props) => {
    const owner = { hooks: [], effects: [], dirty: false, cursor: 0 }
    return () => {
      owner.cursor = 0
      owner.effects = []
      current = owner
      owner.tree = Component(owner.props = props)
      current = null
      for (const effect of owner.effects) effect()
      return owner.tree
    }
  }
  const render = node => renderNode(node)
  /** 按类型递归求值整棵树(含函数组件子节点),返回节点列表。 */
  const tree = node => flatten(node)
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : []
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : node == null ? '' : String(node)
  return { React, el, render, tree, mount, createRoot, nodes, text }
}

// ── A/B/C) 分块产物:注册信息、导出、比例与刻度 ──────────────────────────
const peakHost = host()
const peakArtifact = await loadArtifact('client.peak.js', { react: peakHost.React })
assert.equal(peakArtifact.registration.chunk, 'client.peak.js', '分块文件名与主包 require.async 路径一致')
assert.equal(peakArtifact.registration.id, 'dsh-cost-meter', '分块归属同一插件 id')
const peakMount = peakArtifact.exports
const phaseOf = (iso, config = {}) => peakMount.phaseOf(config, Date.parse(iso))
assert.equal(typeof peakMount.mount, 'function', '分块导出 mount')
assert.equal(typeof peakMount.bandsOf, 'function', '分块导出 bandsOf 供核对比例')
assert.equal(typeof peakMount.axisOf, 'function', '分块导出 axisOf 供核对刻度')

// A) 默认 DeepSeek 峰谷窗口(UTC 01-04 / 06-10 = 北京 09-12 / 14-18)按时长比例分段。
// 分块在独立 vm realm 中构造对象/数组,断言前经 JSON 折算回本 realm 的普通值。
const plain = list => JSON.parse(JSON.stringify(list.map(b => [b.start, b.end, b.peak === true])))
const bands = peakMount.bandsOf(undefined)
assert.deepEqual(
  plain(bands),
  [[0, 9, false], [9, 12, true], [12, 14, false], [14, 18, true], [18, 24, false]],
  '默认窗口给出 00-09 谷、09-12 峰、12-14 谷、14-18 峰、18-24 谷',
)
const widths = plain(bands).map(([s0, e0]) => (e0 - s0) / 24 * 100)
assert.deepEqual([...widths].map(w => Math.round(w * 100) / 100), [37.5, 12.5, 8.33, 16.67, 25], '段宽即官方时段占比')
assert.equal(widths.reduce((a, b) => a + b, 0).toFixed(6), '100.000000', '五段宽度合计 100%')
// 自定义跨午夜窗口(UTC 22-02 = 北京 06:00-10:00 次日,恰是默认峰窗)折算正确。
assert.deepEqual(plain(peakMount.bandsOf([{ start: 22, end: 2 }])),
  [[0, 6, false], [6, 10, true], [10, 24, false]], '跨午夜窗口折算到北京日')
// UTC 20-04(北京 04:00-12:00):北京日内一段谷 + 一段峰 + 一段谷。
assert.deepEqual(plain(peakMount.bandsOf([{ start: 20, end: 4 }])),
  [[0, 4, false], [4, 12, true], [12, 24, false]], '跨午夜窗口拆成首段 + 尾段')

// B) 相位:默认窗口下北京 09-12 / 14-18 为峰;周末与法定假日全天谷价。
assert.equal(phaseOf('2026-09-10T01:00:00Z').inPeak, true, '北京 09:00 入峰(UTC 01:00)')
assert.equal(phaseOf('2026-09-10T04:00:00Z').inPeak, false, '北京 12:00 转谷(UTC 04:00)')
assert.equal(phaseOf('2026-09-10T06:00:00Z').inPeak, true, '北京 14:00 入峰(UTC 06:00)')
assert.equal(phaseOf('2026-09-10T10:00:00Z').inPeak, false, '北京 18:00 转谷(UTC 10:00)')
assert.equal(phaseOf('2026-09-12T04:00:00Z').weekend, true, '周六为周末全谷价')
assert.equal(phaseOf('2026-09-12T04:00:00Z').inPeak, false, '周末即使落在峰窗也按谷价')
assert.equal(phaseOf('2026-10-01T04:00:00Z').holiday, true, '国庆为法定假日全谷价')
assert.equal(phaseOf('2026-09-10T01:00:00Z', { peakHolidays: ['2026-09-10'] }).inPeak, false, '自定义假日名单生效')
const noonPeak = phaseOf('2026-09-10T01:30:00Z')
assert.equal(noonPeak.nextIntoPeak, false, '峰中:下一次切换是退出峰时')
assert.equal(noonPeak.nextAtMs, Date.parse('2026-09-10T04:00:00Z'), '峰中倒计时指向 04:00 UTC')

// C) 刻度位置:北京日内的已过比例;相位决定胶囊配色类。
const peakOf = (iso, config) => peakMount.phaseOf(config ?? {}, Date.parse(iso))
const at = (iso, expectedBr, expectedKind) => {
  const view = peakMount.axisOf({ peakWindows: undefined }, Date.parse(iso), peakOf(iso))
  // 位置按比例给出:容差 0.05 个百分点(覆盖浮点与末秒四舍五入)。
  assert.ok(Math.abs(view.br - expectedBr) < 0.05, iso + ' 刻度位置 ' + view.br + ' ≈ ' + expectedBr)
  assert.equal(view.key, expectedKind, iso + ' 相位类名')
}
at('2026-09-10T16:00:00Z', 0, 'off')        // 北京 00:00
at('2026-09-10T01:00:00Z', 37.5, 'peak')    // 北京 09:00 入峰
at('2026-09-10T04:00:00Z', 50, 'off')       // 北京 12:00 转谷
at('2026-09-10T06:00:00Z', 58.33, 'peak')   // 北京 14:00 入峰
at('2026-09-10T10:00:00Z', 75, 'off')       // 北京 18:00 转谷
at('2026-09-10T15:59:00Z', 99.93, 'off')    // 北京 23:59 日末(1439/1440 分钟)
// 周末/假日整条淡显:相位类名换成 weekend。
assert.equal(peakMount.axisOf({ peakWindows: undefined }, Date.parse('2026-09-12T04:00:00Z'), peakOf('2026-09-12T04:00:00Z')).key, 'weekend', '周末全谷价用 weekend 类名')

// C) 分块渲染:五段 + 空心胶囊刻度 + 相位芯片,宽栏与 rail 同构。
const { render, nodes, text } = peakHost
const Chunk = peakMount.mount()
const renderChunk = (config, now, rail) => render(peakHost.mount(Chunk, {
  config, now, rail,
  t: (key, params) => params ? key + ':' + Object.values(params).join('/') : key,
}))
const strip = renderChunk({ peakWindows: undefined }, Date.parse('2026-09-10T06:00:00Z'), false)
const stripNodes = nodes(strip)
const segs = stripNodes.filter(n => String(n.props.className ?? '').includes('cm-pkw-seg'))
assert.equal(segs.length, 5, '宽栏渲染五段')
assert.deepEqual(JSON.parse(JSON.stringify(segs.map(s => s.props.style.width))), ['37.5%', '12.5%', '8.333333333333332%', '16.666666666666664%', '25%'], '段宽按比例内联')
assert.deepEqual(segs.map(s => String(s.props.className).includes('peak') ? 'peak' : 'off'), ['off', 'peak', 'off', 'peak', 'off'], '峰段用橙、谷段用蓝')
const cap = stripNodes.find(n => String(n.props.className ?? '').includes('cm-pkw-cap'))
assert.equal(cap.props.style.left, '58.333333333333336%', '胶囊滑块落在当前刻度(北京 14:00)')
assert.equal(typeof cap.props.style, 'object', 'style 必须是对象映射(字符串会让 React 抛错)')
const stripRoot = stripNodes.find(n => String(n.props.className ?? '').split(' ').includes('cm-peak-strip'))
assert.equal(stripRoot.props.className, 'cm-peak-strip peak', '根类名带相位,复用主包芯片配色')
assert.ok(stripNodes.some(n => String(n.props.className ?? '') === 'cm-pkw-track'), '轨道类名固定,不再套一层 .cm-pkw')
assert.ok(stripNodes.some(n => String(n.props.className ?? '').includes('cm-peak-chip')), '芯片复用主包 cm-peak-chip 类')
assert.equal(text(strip), 'peakShort', '北京 14:00 峰中:芯片只给相位短词(倒计时进悬停说明,避免挤窄轨道)')
assert.match(stripRoot.props['aria-label'], /nextOffPeakIn:countdownHoursOnly:4/, '悬停说明含距下次谷时的倒计时')
assert.match(stripRoot.props['aria-label'], /0:00–9:00offPeakShort、9:00–12:00peakShort、12:00–14:00offPeakShort、14:00–18:00peakShort、18:00–24:00offPeakShort/, '悬停说明列出完整峰谷区间与相位')
const rail = renderChunk({ peakWindows: undefined }, Date.parse('2026-09-10T06:00:00Z'), true)
const railNodes = nodes(rail)
assert.equal(railNodes.filter(n => String(n.props.className ?? '').includes('cm-pkw-rail-seg')).length, 5, 'rail 渲染五段')
assert.equal(railNodes.find(n => String(n.props.className ?? '').includes('cm-pkw-rail-cap')).props.style.top, '58.333333333333336%', 'rail 胶囊滑块同刻度')
assert.ok(railNodes.filter(n => String(n.props.className ?? '').includes('cm-pkw-rail-seg')).every(n => typeof n.props.style === 'object' && n.props.style.height), 'rail 段高为对象映射')
assert.ok(nodes(rail).some(n => (n.props.className ?? '').split(' ').includes('wiper')), 'rail 根类名标记动态样式')

// D) 样式表:轨道粗细对齐简洁样式(6px),刻度滑块是「空心胶囊」——靠主题变量
//    brand-primary 在明暗两套里自动取反色(亮色近黑、暗色近白),不自行探测主题。
//    注入发生在渲染时(ensureCss),测试沙箱的 document 由助手内部持有,故这里用
//    自己的最小 DOM 执行同一个产物,顺带核对「重复渲染不重复注入」。
const PEAK_CSS_SELECTOR = 'style[data-plugin-css="dsh-cost-meter-peak-style"]'
let injectedCss = null
let createdNodes = 0
const fakeDom = {
  querySelector: selector => (injectedCss !== null && selector === PEAK_CSS_SELECTOR ? injectedCss : null),
  createElement: () => { createdNodes += 1; return { dataset: {}, textContent: '' } },
  head: { appendChild: node => { injectedCss = node } },
}
let peakRegistration
vm.runInNewContext(read('lib/client.peak.js'), { window: { __ModuleLoader__: { load: value => { peakRegistration = value } } }, document: fakeDom })
const domReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
}
const domChunk = peakRegistration.factory(id => id === 'react' ? domReact : { Tooltip: 'tooltip' })
const domDynamic = domChunk.mount()
const domProps = { config: { peakWindows: undefined }, now: Date.parse('2026-09-10T06:00:00Z'), t: key => key, rail: false }
domDynamic(domProps)
assert.ok(injectedCss !== null, '分块就近注入自己的样式表')
assert.equal(injectedCss.dataset.pluginCss, 'dsh-cost-meter-peak-style', '样式节点带固定 data-plugin-css 标识')
const cssText = injectedCss.textContent
assert.match(cssText, /\.cm-pkw-track\{[^}]*height:6px/, '轨道高度对齐简洁样式的 6px')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*border:1\.5px solid var\(--cm-pkw-rim\)/, '刻度滑块用 1.5px 描边(空心胶囊)')
assert.doesNotMatch(cssText, /\.cm-pkw-cap\{[^}]*background:/, '刻度滑块不填充,避免压在分色带上糊成一块')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*width:4px/, '滑块宽度固定 4px,不改分段比例')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*height:calc\(100% \+ 7px\)/, '滑块长度略高于轨道')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*min-height:13px/, '滑块最小高度 13px(6px 轨道 + 7px)')
domDynamic(domProps)
assert.equal(createdNodes, 1, '重复渲染复用同一节点,不重复注入')
assert.ok(fakeDom.querySelector(PEAK_CSS_SELECTOR) === injectedCss, '重复渲染复用同一节点')
const peakArtifactSource = read('lib/client.peak.js')
assert.match(peakArtifactSource, /--cm-pkw-rim:var\(--dsw-alias-brand-primary\)/, '描边取 brand-primary(亮色近黑 / 暗色近白)')
assert.doesNotMatch(peakArtifactSource, /--cm-pkw-cap/, '不再保留已弃用的填充变量')

// E) 主包产物:激活 → 页脚注册 → 样式分派与懒加载闭环(端到端,不再读源码片段)。
const uiHost = host()
// 宿主桩能捕获「把 Promise 当元素类型」这一缺陷,保证下面的护栏有效。
assert.throws(() => uiHost.el(Promise.resolve(), {}), /Element type is invalid/, '宿主桩拒绝 Promise 元素类型')
const mainArtifact = await loadArtifact('client.js', { react: uiHost.React })
const requested = []
const platformAsync = mainArtifact.require.async
// 平台契约:require.async 返回分块的导出对象(mod.mount / mod.Phase…);助手内部按
// loadArtifact 的形态返回 { exports, require, registration },这里抹平成真实契约。
mainArtifact.require.async = async path => {
  requested.push(path)
  const nested = await platformAsync(path)
  return nested?.exports ?? nested
}
const totals = { cost: 1, apiCost: 1, calls: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }
const fakeState = {
  today: totals, month: totals, total: totals,
  config: {
    locale: 'zh', activeLocale: 'zh', sidebar: true, peakEnabled: true, peakNotice: true,
    peakStyle: 'compact', peakWindows: [{ start: 1, end: 4 }, { start: 6, end: 10 }], peakHolidays: [],
    budget: { enabled: false }, balance: { display: 'off' }, goQuota: { enabled: false },
    codingPlans: {}, sidebarModels: { enabled: false },
  },
}
const registrations = []
/** 宿主桩:remote 挂载 + RPC 读快照 + slot 注册(inject 的 cb 立即触发,等价平台可达时回调)。 */
const makeCtx = (state, sink) => {
  const costMeter = { getLocalState: async () => ({ ok: true, value: state }), getState: async () => ({ ok: true, value: state }) }
  const slots = {
    inject: (_name, cb) => cb(),
    register: (options, component) => { sink.push({ options, component }); return () => {} },
    entries: () => [],
  }
  return {
    remote: { $mount: async () => () => {} },
    get: name => name === 'remote.costMeter' ? costMeter : name === 'slots' ? slots : undefined,
    effect: fn => fn(),
    on: () => () => {},
  }
}
const footerOf = sink => sink.find(entry => entry.options?.name === 'sidebar.footer.action' && entry.options.id === 'cost-meter')
const storeOf = entry => entry.options.inject().hooks.cost
await mainArtifact.exports.activate(makeCtx(fakeState, registrations))
await settle()
const footerEntry = footerOf(registrations)
assert.ok(footerEntry !== undefined, '激活后注册侧栏页脚(动态样式的宿主)')
const { api } = footerEntry.options.inject()
const store = storeOf(footerEntry)
assert.ok(store.getSnapshot().state !== null, '激活后 store 已拉到快照')
const footerProps = { useCost: selector => selector(store.getSnapshot()), wide: true, api }
const setPeakStyle = style => store.set({
  ...store.getSnapshot(),
  state: { ...store.getSnapshot().state, config: { ...store.getSnapshot().state.config, peakStyle: style } },
})
/** tree() 已递归展开全部函数组件,返回的就是节点列表(不能再走 nodes(),否则子节点会重复计数)。 */
const footerNodes = flat => (Array.isArray(flat) ? flat : [flat]).filter(node => node !== null && typeof node === 'object')
/** 一次性渲染页脚:mount 跑顶层实例的 effect,tree 展开全部函数组件子节点。 */
const viewFooter = props => uiHost.tree(uiHost.mount(footerEntry.component, props))

// 分派 1:compact(简洁样式)直接渲染,且不请求动态样式分块。
const compactTree = viewFooter(footerProps)
assert.ok(footerNodes(compactTree).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-strip')), 'compact 走简洁样式')
assert.equal(requested.length, 0, '非 dynamic 样式不请求分块')
// 分派 2:classic 保持原有渲染。
setPeakStyle('classic')
const classicTree = viewFooter(footerProps)
assert.ok(footerNodes(classicTree).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-classic')), 'classic 样式保持原有渲染')
assert.equal(requested.length, 0, 'classic 同样不请求分块')
// 分派 3:rail(窄栏)态两种样式各自兜底。
setPeakStyle('compact')
const railCompact = viewFooter({ ...footerProps, wide: false })
assert.ok(footerNodes(railCompact).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-rail')), 'rail 走窄栏简洁样式')
setPeakStyle('classic')
const railClassic = viewFooter({ ...footerProps, wide: false })
assert.ok(footerNodes(railClassic).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-rail-classic')), 'rail classic 样式保持原有渲染')

// F/G) 懒加载闭环:dynamic 首次渲染请求分块并返回 null(pending),resolve 后同一实例换成动态样式。
setPeakStyle('dynamic')
const root = uiHost.createRoot(footerEntry.component, footerProps)
const pendingTree = uiHost.tree(root())
assert.ok(!footerNodes(pendingTree).some(n => String(n.props.className ?? '').includes('cm-pkw')), '分块未就绪时不渲染动态样式(外壳返回 null)')
assert.ok(requested.includes('./client.peak.js'), 'dynamic 只请求 client.peak.js')
assert.equal(requested.filter(path => path === './client.peak.js').length, 1, '分块只请求一次')
// 进行中再渲染一次:仍是 null 且不重复请求(peakChunk 保持 Promise 作为「进行中」标记,
// 绝不把 Promise 当元素类型——交给 React 会抛 "Element type is invalid")。
const inFlightTree = uiHost.tree(root())
assert.ok(!footerNodes(inFlightTree).some(n => String(n.props.className ?? '').includes('cm-pkw')), '进行中:外壳必须返回 null,不能返回 Promise 本身')
assert.equal(requested.filter(path => path === './client.peak.js').length, 1, '进行中不重复请求')
await settle()
const swapped = uiHost.tree(root())
const swappedNodes = footerNodes(swapped)
assert.equal(swappedNodes.filter(n => String(n.props.className ?? '').includes('cm-pkw-seg')).length, 5, 'resolve 后同一实例切换为动态样式并渲染五段')
assert.ok(swappedNodes.some(n => String(n.props.className ?? '') === 'cm-pkw-cap'), '动态样式带空心胶囊刻度')
assert.equal(requested.filter(path => path === './client.peak.js').length, 1, 'resolve 后不重复请求分块')

// H) 加载失败:保持不渲染该行,且下次渲染仍会重试(页面刷新后恢复)。
const failArtifact = await loadArtifact('client.js', { react: uiHost.React })
let failCalls = 0
failArtifact.require.async = async () => { failCalls += 1; throw new Error('chunk unavailable') }
const failRegistrations = []
await failArtifact.exports.activate(makeCtx({ ...fakeState, config: { ...fakeState.config, peakStyle: 'dynamic' } }, failRegistrations))
await settle()
const failEntry = footerOf(failRegistrations)
const failProps = { useCost: selector => selector(storeOf(failEntry).getSnapshot()), wide: true, api: failEntry.options.inject().api }
const failFirst = uiHost.tree(uiHost.mount(failEntry.component, failProps))
assert.ok(!footerNodes(failFirst).some(n => String(n.props.className ?? '').includes('cm-pkw')), '分块加载失败不渲染该行')
await settle()
const failSecond = uiHost.tree(uiHost.mount(failEntry.component, failProps))
assert.ok(!footerNodes(failSecond).some(n => String(n.props.className ?? '').includes('cm-pkw')), '加载失败后仍不渲染(不抛错)')
assert.ok(failCalls >= 2, '失败后保持可重试的加载器')

console.log('[ok] 动态峰谷样式:分块比例/刻度、空心胶囊、懒加载与简洁/经典样式分派')
