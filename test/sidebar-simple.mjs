import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { Ledger, sanitizeConfig, applyConfigPatch } from '../lib/store.js'
import { stateSchema } from '../lib/typert.host.js'

/**
 * 现场打包客户端模块:旧片段已删、源码已是 ES 模块。React/浏览器 API 通过
 * globalThis.__cmReactStub / __cmEnv 桥接本文件的桩(banner 在实例化时绑定到模块作用域,
 * 不污染宿主与同进程其它测试);parseConfig 未 export,打包时追加等价 export。
 */
const CLIENT_ENV_BANNER = 'const __cmEnv = globalThis.__cmEnv ?? {}\n'
  + 'const Date = __cmEnv.Date ?? globalThis.Date\n'
  + 'const window = __cmEnv.window\n'
  + 'const document = __cmEnv.document\n'
  + 'const navigator = __cmEnv.navigator ?? globalThis.navigator\n'
  + 'const fetch = __cmEnv.fetch\n'
  + 'const setTimeout = __cmEnv.setTimeout\n'
  + 'const clearTimeout = __cmEnv.clearTimeout\n'
  + 'const setInterval = __cmEnv.setInterval\n'
  + 'const clearInterval = __cmEnv.clearInterval\n'
  + 'const AbortSignal = __cmEnv.AbortSignal ?? globalThis.AbortSignal\n'
async function loadClientModules(modules, exposePrivate = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cm-sidebar-simple-'))
  try {
    const reactStub = join(work, 'react-stub.cjs')
    const primitivesStub = join(work, 'primitives-stub.cjs')
    writeFileSync(reactStub, 'const base = { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),'
      + ' useState: value => [typeof value === "function" ? value() : value, () => {}], useEffect: () => {}, useRef: value => ({ current: value ?? null }),'
      + ' useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: (_sub, get) => get() }\n'
      + 'const R = Object.assign({}, base, globalThis.__cmReactStub ?? {})\nmodule.exports = R\nmodule.exports.default = R\n')
    writeFileSync(primitivesStub, 'module.exports = { Tooltip: "Tooltip", Button: "Button" }\nmodule.exports.default = module.exports\n')
    const entry = join(work, 'entry.ts')
    writeFileSync(entry, modules.map(name => `export * from ${JSON.stringify(fileURLToPath(new URL(`../src/client/${name}.ts`, import.meta.url)))}\n`).join(''))
    const outfile = join(work, 'bundle.cjs')
    await esbuild({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
      banner: { js: CLIENT_ENV_BANNER },
      alias: { react: reactStub, '@deepseek-ai/dsh-client-ui-primitives': primitivesStub },
      plugins: [{
        name: 'expose-private',
        setup(build) {
          for (const [moduleName, names] of Object.entries(exposePrivate)) {
            build.onLoad({ filter: new RegExp(`${moduleName}\\.ts$`) }, args => {
              const source = readFileSync(args.path, 'utf8')
              const missing = names.filter(name => !new RegExp(`export (?:function|const|let|class) ${name}\\b`).test(source))
              return { contents: missing.length > 0 ? source + `\nexport { ${missing.join(', ')} }\n` : source, loader: 'ts' }
            })
          }
        },
      }],
    })
    const mod = await import(pathToFileURL(outfile).href)
    return mod.default ?? mod
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

let hookIndex = 0, hooks = []
const storage = new Map()
const el = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = { createElement: el, Fragment: 'fragment', useEffect() {},
  useRef: value => { const i = hookIndex++; return hooks[i] ??= { current: value } },
  useState: init => { const i = hookIndex++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], value => { hooks[i] = value }] },
}
// 旧 vm 沙箱的等价物:客户端模块读到的 window.localStorage / navigator 由本环境的
// __cmEnv 提供(banner 在实例化时绑定),不再改写进程全局。
globalThis.__cmReactStub = React
globalThis.__cmEnv = {
  window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
  navigator: { language: 'en' },
}
const ui = await loadClientModules(['logic', 'guides', 'ui-quota', 'ui-sidebar'], { logic: ['parseConfig'] })
for (const name of ['SidebarSimpleGuide', 'QuotaStripGuide', 'BalanceClickGuide', 'SidebarFooter', 'parseConfig', 'codexQuotaCache']) {
  assert.ok(ui[name] !== undefined, '客户端组件/助手可取: ' + name)
}
const nodes = n => Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...nodes(n.children)] : []
const base = sanitizeConfig({ sidebarStyle: 'compact', quotaStrip: { promptSeen: true }, balance: { clickHintSeen: true }, hideOfficialBalance: true, goQuota: { enabled: false } })
assert.equal(base.sidebarSimple, false, '旧配置保留当前布局')
assert.equal(base.sidebarStyle, 'compact')
for (const field of ['sidebarSimple', 'sidebarSimplePromptSeen']) {
  assert.ok(applyConfigPatch(base, { [field]: 'true' }).errors.length > 0, '不能把文本当作用户选择')
}
let config = base, calls = 0, rejectSave, finishSave, patch
const useCost = pick => pick({ state: { config } })
const api = { updateConfig: value => { calls++; patch = value; return new Promise((resolve, reject) => { rejectSave = reject; finishSave = () => { const result = applyConfigPatch(config, value); assert.deepEqual(result.errors, []); config = result.config; resolve({ config }) } }) } }
const renderGuide = () => { hookIndex = 0; return ui.SidebarSimpleGuide({ useCost, api }) }
const button = (tree, i) => nodes(tree).filter(n => n.type === 'button' && !n.props['aria-label'])[i]
const initial = renderGuide()
assert.equal(initial.props.role, 'dialog')
const enabling = button(initial, 1).props.onClick()
button(initial, 0).props.onClick()
assert.equal(calls, 1, '等待保存时不重复提交或切换选择')
assert.ok(button(renderGuide(), 0).props.disabled)
rejectSave(new Error('synthetic failure')); await enabling
assert.equal(config.sidebarSimplePromptSeen, false, '保存失败不标记为已选择')
assert.ok(nodes(renderGuide()).some(n => n.props.role === 'alert'))
const retry = button(renderGuide(), 1).props.onClick()
finishSave(); await retry
assert.deepEqual(JSON.parse(JSON.stringify(patch)), { sidebarSimple: true, sidebarSimplePromptSeen: true })
assert.equal(renderGuide(), null)
assert.equal(config.sidebarStyle, 'compact', '简化开关保留原标准/紧凑偏好')
const rpcConfig = stateSchema.shape.config.parse(config)
const clientConfig = ui.parseConfig(rpcConfig, 'config')
assert.equal(clientConfig.sidebarSimple, true)
assert.equal(clientConfig.sidebarSimplePromptSeen, true)

const root = mkdtempSync(join(tmpdir(), 'cm-simple-118-'))
const oldHome = process.env.DSH_HOME
try {
  process.env.DSH_HOME = root
  const ledger = Ledger.open()
  ledger.config = config
  ledger.scheduleWrite()
  ledger.close()
  const reopened = Ledger.open()
  assert.equal(reopened.config.sidebarSimple, true)
  assert.equal(reopened.config.sidebarSimplePromptSeen, true, '重启后无需再次选择')
  reopened.close()
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  rmSync(root, { recursive: true, force: true })
}

hooks = []; storage.clear(); config = base
const keeping = button(renderGuide(), 0).props.onClick()
finishSave(); await keeping
assert.equal(config.sidebarSimple, false)
assert.equal(config.sidebarSimplePromptSeen, true, '保留当前显示也记住选择')
assert.equal(renderGuide(), null)
hooks = []; storage.clear(); config = { ...base, sidebarSimplePromptSeen: false, quotaStrip: { ...base.quotaStrip, promptSeen: false }, balance: { ...base.balance, display: 'both', clickHintSeen: false } }
hookIndex = 0
assert.equal(ui.QuotaStripGuide({ useCost, api }), null, '优先显示新的简化引导')
hooks = []; hookIndex = 0
assert.equal(ui.BalanceClickGuide({ useCost, api }), null, '新旧引导不会叠在一起')

const totals = { cost: 1, calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }
const win = { percent: 25, resetsAt: new Date(Date.now() + 3600000).toISOString() }
config = sanitizeConfig({ ...base, budget: { enabled: true }, codingPlans: { kimi: { enabled: true, display: 'sidebar' } }, sidebarSimple: true, sidebarSimplePromptSeen: true })
const state = { config, today: totals, month: totals, total: totals, codingPlans: { kimi: { status: 'ok', windows: { daily: win }, fetchedAt: Date.now() } }, gatewayQuotas: { sources: [] } }
ui.codexQuotaCache.status = 'unavailable'
const footer = wide => { hooks = []; hookIndex = 0; return ui.SidebarFooter({ wide, useCost: pick => pick({ state }), api }) }
const simple = footer(true)
assert.match(simple.props.className, /simple/)
assert.doesNotMatch(simple.props.className, /compact/)
assert.equal(simple.props.tabIndex, 0, '可用键盘进入并滚动')
const countCards = tree => nodes(tree).filter(n => typeof n.type === 'function').length
assert.equal(nodes(simple).filter(n => n.props.summary === true).length, 1, '预算与今日合并为一个摘要')
assert.match(footer(false).props.className, /rail.*simple/)
state.config = { ...config, sidebarSimple: false }
const standard = footer(true)
assert.match(standard.props.className, /compact/)
assert.doesNotMatch(standard.props.className, /simple/)
assert.equal(countCards(standard) + 1, countCards(simple), '简化模式保留预算与额度，并独立挂载峰谷条')
console.log('[ok] #118 简化显示：选择/拒绝、保存失败重试、防重入、RPC 与重启持久化、引导串行、布局恢复及键盘滚动')

// 保存被拒绝或长期等待时，关闭提示不伪装成已保存设置。
for (const failure of ['rejected', 'pending']) {
  hooks = []; storage.clear(); config = base;
  const task = button(renderGuide(), 1).props.onClick();
  if (failure === 'rejected') { rejectSave(new Error('offline')); await task }
  const close = nodes(renderGuide()).find(n => n.type === 'button' && n.props['aria-label']);
  assert.equal(close.props.disabled, undefined);close.props.onClick();
  assert.equal(renderGuide(), null);
  hooks = []; assert.equal(renderGuide(), null, '刷新后仍保留同源提示关闭标记');
  assert.equal(config.sidebarSimple, false);assert.equal(config.sidebarSimplePromptSeen, false, '不伪造服务端保存成功');
  if (failure === 'pending') { rejectSave(new Error('offline')); await task }
}
console.log('[ok] #121 引导在保存失败/等待时可独立关闭，刷新保留关闭标记且不更改实际配置')

hooks = []; storage.clear(); config = base;
let escaped = false;renderGuide().props.onKeyDown({ key: 'Escape', stopPropagation: () => { escaped = true } });
assert.equal(escaped, true);assert.equal(renderGuide(), null);

// 旧 RPC 返回成功但没有回传新设置时，不能假装已经开启。
hooks = []; storage.clear(); config = base; hookIndex = 0;
const staleGuide = ui.SidebarSimpleGuide({ useCost, api: { updateConfig: async () => ({ config: base }) } });
await button(staleGuide, 1).props.onClick();
assert.ok(nodes(renderGuide()).some(n => n.props.role === 'alert'));
assert.equal(storage.size, 0);
