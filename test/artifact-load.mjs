/**
 * 构建产物可加载性:按平台(classic script + `window.__ModuleLoader__.load`)语义
 * 执行 `lib/client*.js`,断言每个产物注册一次、factory 能取到平台种子模块、
 * 并能导出启动包/分块所需符号。
 *
 * 背景:esbuild 的 iife + external 会把 `require("react")` 提升到脚本顶层立即执行,
 * 而平台的 require 只作为 factory 入参注入(全局没有 require),脚本一加载就抛
 * `Dynamic require of "react" is not supported`。构建脚本因此改为 cjs + banner/footer
 * 把入口包进注册壳;本测试锁定该形态。
 */
// 产物可加载性:按平台的 classic script 语义执行 lib/client*.js
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const fakeReact = {
  createElement: (...a) => ({ type: a[0], props: a[1] ?? {}, children: a.slice(2) }),
  Fragment: 'fragment',
  useState: v => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {}, useRef: v => ({ current: v }), useMemo: f => f(), useCallback: f => f,
  createContext: () => ({ Provider: 'p', Consumer: 'c' }), forwardRef: f => f, memo: f => f,
}
const primitives = { Tooltip: 'tooltip' }
const seeds = { react: fakeReact, 'react-dom': { createPortal: () => null }, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': primitives }

function loadArtifact(file, chunkName) {
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: r => registrations.push(r) }, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, Notification: undefined, dispatchEvent() {} },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '', style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, documentElement: { style: {} }, visibilityState: 'visible' },
    navigator: { language: 'zh' }, localStorage: { getItem: () => null, setItem() {} }, console,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, CustomEvent: class {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  if (registrations.length !== 1) throw new Error(`${file}: 注册次数 ${registrations.length}（应为 1）`)
  const reg = registrations[0]
  if (reg.id !== 'dsh-cost-meter') throw new Error(`${file}: id = ${reg.id}`)
  if ((reg.chunk ?? undefined) !== chunkName) throw new Error(`${file}: chunk = ${reg.chunk}（应为 ${chunkName ?? '无'}）`)
  const requireFn = id => { if (!(id in seeds)) throw new Error(`未提供种子模块 ${id}`); return seeds[id] }
  requireFn.async = async id => { throw new Error('不应在加载期调用 require.async: ' + id) }
  const exportsObj = reg.factory(requireFn)
  return { chunk: reg.chunk ?? '(启动包)', exports: Object.keys(exportsObj ?? {}).sort() }
}

const EXPECTED = {
  'lib/client.js': { chunk: undefined, required: ['activate'] },
  'lib/client.peak.js': { chunk: 'client.peak.js', required: ['mount'] },
  'lib/client.settings.js': { chunk: 'client.settings.js', required: ['mount', 'CostSection'] },
  'lib/client.statistics.js': { chunk: 'client.statistics.js', required: ['mount'] },
  'lib/client.openrouter.js': { chunk: 'client.openrouter.js', required: ['mount'] },
}
let failed = 0
for (const [file, spec] of Object.entries(EXPECTED)) {
  try {
    const r = loadArtifact(file, spec.chunk)
    const missing = spec.required.filter(name => !r.exports.includes(name))
    if (missing.length > 0) throw new Error(`${file}: 缺少导出 ${missing.join(', ')}`)
    console.log(`[ok] ${file} chunk=${r.chunk} exports=${r.exports.length} 个（含 ${spec.required.join(', ')}）`)
  } catch (error) {
    failed += 1
    console.error(`[FAIL] ${file}: ${error.message}`)
  }
}
if (failed > 0) { console.error(`\n${failed} 个产物无法按平台语义加载`); process.exit(1) }
console.log('\n[ok] 全部产物按平台 classic-script 语义加载成功:注册 1 次、factory 取到种子模块、导出可用')

// 反向保护:产物里不得出现顶层 require(iife 早期形态会让脚本加载即抛
// "Dynamic require of \"react\" is not supported")
for (const file of Object.keys(EXPECTED)) {
  const text = readFileSync(file, 'utf8')
  const firstFactory = text.indexOf('factory:')
  const head = firstFactory < 0 ? text : text.slice(0, firstFactory)
  if (/\brequire\(/.test(head)) throw new Error(`${file}: factory 之前出现 require(),脚本加载即会抛错`)
}
console.log('[ok] 产物在 factory 之前不含 require() 调用(不会脚本一加载就抛 Dynamic require)')
