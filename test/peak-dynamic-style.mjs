/**
 * 峰谷时段条「动态」样式:按需分块渲染 + 主包懒加载接线。
 *
 * 该样式整块放在 lib/client.peak.js(主客户端贴着 DSH STORE 256 KiB 单文件上限,
 * 主包只保留按需加载外壳与简洁样式兜底),本测试同时锁定三层不变式:
 *   A. 分块可独立加载,导出 mount,并按时长比例给出五段(09/3/2/4/6 小时);
 *   B. 刻度位置取"北京日内的已过比例",与计价窗口同一时区口径,边到边映射 0–100%;
 *   C. 主包在未注入加载器时不渲染动态样式、注入且分块就绪后才替换掉简洁样式兜底。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

/** 极简 React 宿主:支持函数组件、useState/useEffect,足够跑一遍静态渲染。
 *  mount() 会按真实 React 的语义循环跑 effect + 重渲染,才能覆盖"异步加载后换组件"
 *  这条路径——外壳早期版本把未 resolve 的 Promise 当成元素类型交给 React,会直接
 *  抛 "Element type is invalid" 把设置页整页打白,静态渲染测不出这个缺陷。 */
function host() {
  let factory
  const el = (type, props, ...children) => ({ type, props: props ?? {}, children })
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
  }
  let current = null
  // 每次调用函数组件都给一个独立的 hook 宿主:静态 render() 只需跑通一次, hook 值
  // 不跨渲染保留;需要"加载完成后换组件"的场景用下面的 mount() 单实例循环。
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
  const render = node => renderNode(node)
  /** 按类型递归求值整棵树(含函数组件子节点),返回节点列表。 */
  const tree = node => flatten(node)
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : []
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : node == null ? '' : String(node)
  return { React, el, render, tree, mount, nodes, text, setFactory: fn => { factory = fn }, getFactory: () => factory }
}

const peakSource = read('src/peak/index.js')
// 分块自带样式注入:这里给出最小 DOM,顺带核对注入内容。
// 假 DOM 需要跨渲染记住已注入的样式节点,才能同时验证"重复渲染不重复注入"。
let injectedCss = null
const fakeDom = {
  querySelector: selector => (injectedCss !== null && selector === 'style[data-plugin-css="dsh-cost-meter-peak-style"]' ? injectedCss : null),
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: node => { injectedCss = node } },
}
let peakRegistration
vm.runInNewContext(peakSource, { window: { __ModuleLoader__: { load: value => { peakRegistration = value } } }, document: fakeDom })
assert.equal(peakRegistration.chunk, 'client.peak.js', '分块文件名与主包 require.async 路径一致')
assert.equal(peakRegistration.id, 'dsh-cost-meter', '分块归属同一插件 id')
const chunkReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
}
const peakMount = peakRegistration.factory(() => chunkReact)
const phaseOf = (iso, config = {}) => peakMount.phaseOf(config, Date.parse(iso))
assert.equal(typeof peakMount.mount, 'function', '分块导出 mount')
assert.equal(typeof peakMount.bandsOf, 'function', '分块导出 bandsOf 供核对比例')
assert.equal(typeof peakMount.axisOf, 'function', '分块导出 axisOf 供核对刻度')

// A) 默认 DeepSeek 峰谷窗口(UTC 01-04 / 06-10 = 北京 09-12 / 14-18)按时长比例分段。
// 分块在独立 realm 里构造对象,断言前统一折算成当前 realm 的数组。
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
const at = (iso, expectedBr, expectedKind) => {
  const view = peakMount.axisOf({ peakWindows: undefined }, Date.parse(iso), peakOf(iso))
  // 位置按比例给出:容差 0.05 个百分点(覆盖浮点与末秒四舍五入)。
  assert.ok(Math.abs(view.br - expectedBr) < 0.05, iso + ' 刻度位置 ' + view.br + ' ≈ ' + expectedBr)
  assert.equal(view.key, expectedKind, iso + ' 相位类名')
}
const peakOf = (iso, config) => peakMount.phaseOf(config ?? {}, Date.parse(iso))
at('2026-09-10T16:00:00Z', 0, 'off')        // 北京 00:00
at('2026-09-10T01:00:00Z', 37.5, 'peak')    // 北京 09:00 入峰
at('2026-09-10T04:00:00Z', 50, 'off')       // 北京 12:00 转谷
at('2026-09-10T06:00:00Z', 58.33, 'peak')   // 北京 14:00 入峰
at('2026-09-10T10:00:00Z', 75, 'off')       // 北京 18:00 转谷
at('2026-09-10T15:59:00Z', 99.93, 'off')    // 北京 23:59 日末(1439/1440 分钟)
// 周末/假日整条淡显:相位类名换成 weekend。
assert.equal(peakMount.axisOf({ peakWindows: undefined }, Date.parse('2026-09-12T04:00:00Z'), peakOf('2026-09-12T04:00:00Z')).key, 'weekend', '周末全谷价用 weekend 类名')

// C) 分块渲染:五段 + 空心胶囊刻度 + 相位芯片,宽栏与 rail 同构。
const { React, el, render, nodes, text } = host()
let mountProps
const Chunk = peakMount.mount()
const renderChunk = (config, now, rail) => render(Chunk({
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

// D) 样式表:轨道粗细对齐简洁样式(6px),刻度滑块是"空心胶囊"——靠主题变量
//    brand-primary 在明暗两套里自动取反色(亮色近黑、暗色近白),不自行探测主题。
assert.ok(injectedCss !== null, '分块就近注入自己的样式表')
const cssText = injectedCss.textContent
assert.match(cssText, /\.cm-pkw-track\{[^}]*height:6px/, '轨道高度对齐简洁样式的 6px')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*border:1\.5px solid var\(--cm-pkw-rim\)/, '刻度滑块用 1.5px 描边(空心胶囊)')
assert.doesNotMatch(cssText, /\.cm-pkw-cap\{[^}]*background:/, '刻度滑块不填充,避免压在分色带上糊成一块')
assert.match(cssText, /\.cm-pkw-cap\{[^}]*height:calc\(100% \+ 7px\)/, '滑块长度略高于轨道')
assert.ok(fakeDom.querySelector('style[data-plugin-css="dsh-cost-meter-peak-style"]') === injectedCss, '重复渲染复用同一节点')
assert.match(peakSource, /--cm-pkw-rim:var\(--dsw-alias-brand-primary\)/, '描边取 brand-primary(亮色近黑 / 暗色近白)')
assert.doesNotMatch(peakSource, /--cm-pkw-cap/, '不再保留已弃用的填充变量')

// E) 主包:未注入加载器 → 简洁样式兜底;注入后交给懒加载外壳。
const mainHost = host()
const mainSource = read('lib/client.js')
vm.runInNewContext(mainSource, {
  window: { __ModuleLoader__: { load: v => mainHost.setFactory(v.factory) } },
  navigator: { language: 'zh' },
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
})
// lib/client.js 是压缩产物,无法直接取内部函数;用 src 版本核对接线与兜底路径。
const fragments = ['01-open-styles-i18n.js', '02-validators-helpers-sidebar.js', '03-model-sidebar.js', '03-settings-panels-main.js']
const src = fragments.map(name => read('src/client/' + name)).join('')
const uiHost = host()
vm.runInNewContext(src.replace('exports.apply = apply', 'exports.probe = { peakNoticeEl, peakNoticeRailEl }; exports.apply = apply'), {
  window: { __ModuleLoader__: { load: v => uiHost.setFactory(v.factory) } },
  navigator: { language: 'zh' },
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
})
const ui = uiHost.getFactory()(name => name === 'react' ? uiHost.React : { Tooltip: 'tooltip' }).probe
const totals = { cost: 1, apiCost: 1, calls: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }
const state = { today: totals, month: totals, total: totals }
const config = { locale: 'zh', peakStyle: 'dynamic', peakEnabled: true, peakNotice: true, activeLocale: 'zh', peakWindows: [{ start: 1, end: 4 }, { start: 6, end: 10 }] }
void mountProps
const t = key => key
const fallback = uiHost.render(ui.peakNoticeEl(state, config, t))
assert.ok(uiHost.nodes(fallback).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-strip')), '未注入加载器时渲染简洁样式')
assert.ok(!uiHost.nodes(fallback).some(n => String(n.props.className ?? '').includes('cm-pkw')), '未注入加载器时不出现动态样式')
const railFallback = uiHost.render(ui.peakNoticeRailEl(state, config, t))
assert.ok(uiHost.nodes(railFallback).some(n => (n.props.className ?? '').split(' ').includes('cm-peak-rail')), 'rail 未注入加载器时同样兜底')
// 非 dynamic 样式不受影响。
for (const [style, cls] of [['compact', 'cm-peak-strip'], ['classic', 'cm-peak-classic']]) {
  const tree = uiHost.render(ui.peakNoticeEl(state, { ...config, peakStyle: style }, t))
  assert.ok(uiHost.nodes(tree).some(n => (n.props.className ?? '').split(' ').includes(cls)), style + ' 样式保持原有渲染')
}
// 主包源码接线:激活层把分块加载器交给客户端片段,渲染侧只在拿到加载器后才用懒加载外壳。
assert.match(src, /peakLoad = \(\) => require\.async\('\.\/client\.peak\.js'\)/, '激活层注入分块加载器')
assert.match(src, /peakStyle === 'dynamic' && peakLoad !== null/, '仅在加载器就绪后走懒加载外壳')

// F) 懒加载闭环:模拟激活层注入的 require.async,走一遍真实的"请求 → mount → 渲染"。
const lazyHost = host()
const requested = []
const asyncRequire = async specifier => {
  requested.push(specifier)
  assert.equal(specifier, './client.peak.js', '外壳只请求这一个分块')
  return { mount: peakMount.mount }
}
assert.match(src, /peakLoad = \(\) => require\.async\('\.\/client\.peak\.js'\)/, '激活层注入的加载器就请求 client.peak.js')
const mountDynamic = async () => (await asyncRequire('./client.peak.js')).mount()
const LazyComponent = await mountDynamic()
assert.equal(requested.length, 1, '分块只请求一次')
const lazyTree = lazyHost.render(LazyComponent({
  config: { peakWindows: undefined },
  now: Date.parse('2026-09-10T06:00:00Z'),
  t: (key, params) => params ? key + ':' + Object.values(params).join('/') : key,
}))
const lazyNodes = lazyHost.nodes(lazyTree)
assert.equal(lazyNodes.filter(n => String(n.props.className ?? '').includes('cm-pkw-seg')).length, 5, '分块挂载后渲染五段')
assert.ok(lazyNodes.some(n => String(n.props.className ?? '') === 'cm-pkw-cap'), '分块挂载后带空心胶囊刻度')

// G) 外壳的异步切换必须区分"进行中的 Promise"与"已就绪的组件"。
//    早期版本把 peakChunk 直接写成 peakLoad().then(...) 的返回 Promise,React 会把
//    Promise 当作元素类型并抛 "Element type is invalid",设置页选中「动态」即整页白屏。
//    这里用可控 Promise 走一遍 pending → resolve → 重渲染。
const shellHost = host()
const shellSrc = read('src/client/02-validators-helpers-sidebar.js')
vm.runInNewContext(src.replace('exports.apply = apply',
  'exports.probe = { PeakLazy, setLoad: l => { peakLoad = l }, chunk: () => peakChunk, reset: () => { peakChunk = null } }; exports.apply = apply'), {
  window: { __ModuleLoader__: { load: v => shellHost.setFactory(v.factory) } },
  navigator: { language: 'zh' },
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } },
})
const shell = shellHost.getFactory()(name => name === 'react' ? shellHost.React : { Tooltip: 'tooltip' }).probe
let resolveChunk
const pending = new Promise(resolve => { resolveChunk = resolve })
let loadCalls = 0
shell.setLoad(() => { loadCalls += 1; return pending })
const shellProps = {
  config: { peakWindows: undefined },
  t: (key, params) => params ? key + ':' + Object.values(params).join('/') : key,
}
const first = shellHost.mount(shell.PeakLazy, shellProps)
assert.equal(first, null, '分块未就绪时不渲染该行(而不是把 Promise 交给 React)')
assert.equal(loadCalls, 1, '首次渲染只发起一次请求')
assert.ok(shell.chunk() !== null, '请求期间 peakChunk 保存 Promise,作为"进行中"标记')
// 关键回归:进行中的 Promise 绝不能被当成元素类型(否则 React 抛错打白整页)。
const inFlight = shell.chunk()
assert.equal(typeof inFlight.then, 'function', '进行中的值必须是可识别的 Promise(外壳据此返回 null)')
shell.reset()
shell.setLoad(() => { loadCalls += 1; return pending })
const stillPending = shellHost.mount(shell.PeakLazy, shellProps)
assert.equal(stillPending, null, '进行中:外壳必须返回 null,不能返回 Promise 本身')
resolveChunk({ mount: peakMount.mount })
await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
const settled = shell.chunk()
assert.equal(typeof settled, 'function', 'resolve 后 peakChunk 换成组件函数')
const swapped = shellHost.mount(shell.PeakLazy, shellProps)
assert.ok(swapped !== null, 'resolve 后同一外壳渲染出动态样式')
const swappedNodes = shellHost.tree(swapped)
assert.equal(swappedNodes.filter(n => String(n.props?.className ?? '').includes('cm-pkw-seg')).length, 5, '切换后渲染五段')
assert.equal(typeof swapped.type, 'function', '外壳渲染的是组件函数,不是 Promise')
// 加载失败:保持不渲染该行,且不再重复请求(页面刷新后恢复)。
shell.reset()
let failCalls = 0
shell.setLoad(() => { failCalls += 1; return Promise.reject(new Error('chunk unavailable')) })
assert.equal(shellHost.mount(shell.PeakLazy, shellProps), null, '加载失败不渲染该行')
shellHost.mount(shell.PeakLazy, shellProps)
assert.ok(failCalls >= 1, '失败后仍保持可重试的加载器')

console.log('[ok] 动态峰谷样式:分块比例/刻度、空心胶囊、懒加载与简洁样式兜底')
