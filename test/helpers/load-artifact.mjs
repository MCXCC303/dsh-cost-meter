/**
 * 测试用产物加载助手。
 *
 * 把 `lib/client*.js` 当作平台会加载的 classic script 执行一遍,取回 factory 的
 * 导出。这样测试直接验证**构建产物**(而不是源码片段),也顺带覆盖了 loader-factory
 * 包裹是否成立:平台的 `require` 只在 factory 调用时才可用。
 *
 * 用法:
 *   const { loadArtifact, loadChunk } from './helpers/load-artifact.mjs'
 *   const React = (await import('react')).default
 *   const peak = await loadChunk('client.peak.js', { 'react': React })
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 默认种子模块:够跑通绝大多数纯逻辑测试;React 由调用方按需传入。 */
const DEFAULT_SEEDS = {
  react: {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value ?? null }),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useContext: () => undefined,
    useReducer: (reducer, init) => [init, () => {}],
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    forwardRef: fn => fn,
    memo: fn => fn,
  },
  'react-dom': { createPortal: children => children, createRoot: () => ({ render: () => {} }) },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
  '@deepseek-ai/dsh-client-ui-primitives': { Tooltip: 'Tooltip', Button: 'Button' },
}

/** 建一个够跑通模块顶层代码的浏览器最小桩。 */
function createSandbox() {
  const styleNode = () => ({ dataset: {}, textContent: '', style: {}, setAttribute() {}, appendChild() {} })
  const sandbox = {
    console,
    navigator: { language: 'zh-CN' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    Event: class Event { constructor(type) { this.type = type } },
    document: {
      head: { appendChild() {} },
      documentElement: { style: {} },
      querySelector: () => null,
      getElementsByTagName: () => [],
      createElement: styleNode,
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  return sandbox
}

/**
 * 执行一个构建产物,返回 factory 的导出。
 *
 * @param {string} artifact 产物文件名,如 `client.peak.js`
 * @param {Record<string, unknown>} [seeds] 覆盖默认种子模块
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadArtifact(artifact, seeds = {}) {
  const file = resolve(projectRoot, 'lib', artifact)
  const registrations = []
  const sandbox = createSandbox()
  sandbox.window.__ModuleLoader__ = { load: registration => registrations.push(registration) }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  if (registrations.length !== 1) {
    throw new Error(`${artifact}: 向平台注册 ${registrations.length} 次(应为 1 次)`)
  }
  const { factory } = registrations[0]
  const table = { ...DEFAULT_SEEDS, ...seeds }
  const platformRequire = id => {
    if (!(id in table)) throw new Error(`${artifact}: 缺少种子模块 ${id}`)
    return table[id]
  }
  platformRequire.async = async path => {
    // 返回分块模块本身(平台契约:`const mod = await require.async('./client.peak.js'); mod.mount()`),
    // 而不是载入器的包装结果。
    const name = path.replace(/^\.\//, '')
    const nested = await loadArtifact(name, seeds)
    return nested.exports
  }
  return { exports: factory(platformRequire), require: platformRequire, registration: registrations[0] }
}

/** 载入一个按需分块(如 `client.peak.js`)的导出。 */
export async function loadChunk(artifact, seeds) {
  return (await loadArtifact(artifact, seeds)).exports
}

/** 载入启动包。 */
export async function loadStartup(seeds) {
  return (await loadArtifact('client.js', seeds)).exports
}
