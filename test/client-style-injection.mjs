// 样式表注入必须按**内容**比对,不能只按 id 去重。
//
// 背景(issue: 客户端插件热更新后弹窗退回默认几何):DSH 的 client HMR 会在不刷新页面的
// 情况下换掉插件代码,页面上留着的是上一版的 <style> 节点。旧实现只检查
// `style[data-plugin-css=...]` 是否存在,存在就跳过注入 —— 新代码的 .cm-stat-dialog 于是
// 匹配不到任何规则,弹窗退回 UA 默认几何(整视口居中)重新压住标题栏,定位修复被静默还原。
// 弹窗几何从内联样式改成只靠样式表之后,这个既有守卫才第一次有了实际影响。
//
// 本测试同时锁定三条不变式:
//   A. 页面已有**旧内容**的同 id 样式表 → 必须就地更新为新内容(热更新场景);
//   B. 页面已有**相同内容**的样式表 → 复用原节点,不重复插入(保留原有的去重语义);
//   C. 页面没有任何样式表 → 新建并插入 head。
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// 旧 src/client/*.js 拼接片段已删:样式注入现在发生在**启动包产物**的模块初始化里
// (index.ts 顶层的 `createStyleTag()`)。这里按平台 classic-script 语义执行 lib/client.js:
// 脚本只注册 factory,再用种子 require 调 factory —— 模块体副作用(注入样式)在此时发生。
const artifact = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const reactStub = {
  createElement: () => null, Fragment: 'fragment',
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {}, useRef: value => ({ current: value ?? null }),
}

/** 按平台语义执行启动包产物:注册 factory → 用种子 require 调 factory。 */
function runStartup(doc) {
  let factory
  vm.runInNewContext(artifact, {
    window: { __ModuleLoader__: { load: value => { factory = value.factory } } },
    document: doc, navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: () => 0, CustomEvent: class {}, Event: class {}, console,
  })
  assert.ok(typeof factory === 'function', 'client bundle registers a factory')
  factory(id => id === 'react' ? reactStub : { Tooltip: 'Tooltip' })
}

/** 用一棵最小的假 DOM 跑一次启动包,返回它写进 head 的样式节点。 */
function inject({ existing = null } = {}) {
  const appended = []
  const node = existing ?? { dataset: {}, textContent: '' }
  const head = { appendChild: child => { appended.push(child) } }
  const doc = {
    head,
    // 与实现同口径:按 data-plugin-css 属性选择器查询,只认 id 相同的节点。
    querySelector: selector => {
      const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
      assert.ok(match, 'unexpected selector: ' + selector)
      return existing !== null && node.dataset.pluginCss === match[1] ? node : null
    },
    createElement: () => ({ dataset: {}, textContent: '' }),
  }
  runStartup(doc)
  return { node, appended }
}

// 取出注入的样式文本:实现必须写到节点上。
const runtime = (() => {
  const style = { dataset: {}, textContent: '' }
  runStartup({
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => style,
  })
  return style.textContent
})()
assert.ok(runtime.includes('.cm-stat-dialog'), 'injected stylesheet carries the dialog positioning rule')
assert.ok(runtime.length > 1000, 'injected stylesheet is the full client CSS')

// ── C. 页面没有样式表:新建并插入 ────────────────────────────────────────────
{
  const { appended } = inject({ existing: null })
  assert.equal(appended.length, 1, 'a fresh page gets exactly one stylesheet node')
  assert.equal(appended[0].textContent, runtime, 'the inserted node carries the current CSS')
  assert.equal(appended[0].dataset.pluginCss, 'dsh-cost-meter/client.css', 'node keeps its stable id')
}

// ── A. 已有**旧内容**的同 id 样式表:必须更新(热更新场景,修复的核心) ────────
{
  const stale = { dataset: { plugin: 'dsh-cost-meter', pluginCss: 'dsh-cost-meter/client.css' }, textContent: '/* previous release */' }
  const { node, appended } = inject({ existing: stale })
  assert.equal(node.textContent, runtime, 'a stale stylesheet must be refreshed to the current CSS (HMR: the dialog would otherwise lose its rules)')
  assert.equal(appended.length, 0, 'refreshing must reuse the existing node, not append a duplicate')
  assert.equal(node.dataset.pluginCss, 'dsh-cost-meter/client.css', 'node identity (and therefore the id) is preserved')
}

// ── B. 已有**相同内容**的样式表:复用,不重复插入,也不重写 ──────────────────
{
  const same = { dataset: { plugin: 'dsh-cost-meter', pluginCss: 'dsh-cost-meter/client.css' }, textContent: runtime }
  const before = same.textContent
  const { node, appended } = inject({ existing: same })
  assert.equal(appended.length, 0, 'an up-to-date stylesheet is not duplicated')
  assert.equal(node.textContent, before, 'an up-to-date stylesheet is left untouched')
}

console.log('[ok] client stylesheet injection:内容一致时复用,内容陈旧时就地更新(热更新不再让弹窗丢失定位规则)')
