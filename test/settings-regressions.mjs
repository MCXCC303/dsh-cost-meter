import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { sanitizeConfig, applyConfigPatch, zeroDay } from '../lib/store.js'
import { parseAntigravityQuota } from '../lib/gateway-quota-adapters.js'
import { qwenTokenPlanWindows } from '../lib/coding-plans.js'
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
  const work = mkdtempSync(join(tmpdir(), 'cm-settings-reg-'))
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

// 执行真实组件和事件回调，再经过服务端清洗与客户端读取；不向发布产物暴露接口。
let active
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => {
    const runner = active, i = runner.cursor++
    if (!(i in runner.slots)) runner.slots[i] = typeof initial === 'function' ? initial() : initial
    return [runner.slots[i], next => {
      const value = typeof next === 'function' ? next(runner.slots[i]) : next
      if (!Object.is(value, runner.slots[i])) { runner.slots[i] = value; runner.dirty = true }
    }]
  },
  useRef: value => {
    const i = active.cursor++
    return active.slots[i] ??= { current: value }
  },
  useEffect: (effect, deps) => {
    const runner = active, i = runner.cursor++, previous = runner.slots[i]
    if (!previous || !deps || deps.some((value, index) => !Object.is(value, previous.deps?.[index]))) {
      previous?.cleanup?.()
      const entry = runner.slots[i] = { deps }
      runner.effects.push(() => { entry.cleanup = effect() })
    }
  },
}
const timers = new Map()
let timerId = 0
globalThis.__cmReactStub = react
// 组件用 setTimeout 做防抖保存:客户端侧的计时器由本环境提供(banner 绑定),
// 捕获到本地表由测试手动触发;宿主与其它测试仍用真实计时器。
globalThis.__cmEnv = {
  window: { localStorage: { getItem: () => '1', setItem() {} } },
  setTimeout: fn => { timers.set(++timerId, fn); return timerId },
  clearTimeout: id => { timers.delete(id) },
}
const ui = await loadClientModules(['logic', 't', 'ui-quota', 'settings'], { logic: ['parseConfig'] })
for (const name of ['PlanQuotaCard', 'CostSection', 'parseConfig', 'makeT', 'codingPlanWindowLabel']) {
  assert.equal(typeof ui[name], 'function', '客户端组件/助手可取: ' + name)
}
function renderer(component, props) {
  const runner = { slots: [], cursor: 0, effects: [], dirty: false }
  return () => {
    let tree
    for (let round = 0; round < 20; round++) {
      active = runner; runner.cursor = 0; runner.effects = []; runner.dirty = false
      tree = component(props())
      // 额度区统一后卡片外壳为 QuotaCard 组件:再展开一层,便于断言展开区内的配置节点。
      if (tree && typeof tree.type === 'function' && tree.type !== 'fragment') tree = tree.type(tree.props)
      for (const effect of runner.effects) effect()
      if (!runner.dirty) return tree
    }
    throw new Error('组件状态未收敛')
  }
}
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []
const textOf = tree => typeof tree === 'string' ? tree : (tree?.children ?? []).map(textOf).join('')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && textOf(node) === label)
const rowFor = (tree, model) => nodes(tree).find(node => node.props.className === 'cm-match-row' && textOf(node).includes(model))
const roundTrip = config => ui.parseConfig(sanitizeConfig(config), 'config')
assert.equal(roundTrip({}).codexQuotaSidebar, true, 'old configs retain the sidebar card')
for (const key of ['hideSessionCostHeader', 'hideSessionCostDock', 'hideTurnCost', 'sessionCostCompact']) {
  assert.equal(roundTrip({})[key], false)
  for (const enabled of [true, false]) {
    const patch = applyConfigPatch(sanitizeConfig({}), { [key]: enabled })
    assert.deepEqual(patch.errors, [])
    assert.equal(ui.parseConfig(stateSchema.shape.config.parse(patch.config), 'config')[key], enabled)
  }
  assert.ok(applyConfigPatch(sanitizeConfig({}), { [key]: 'true' }).errors.length)
}
for (const enabled of [true, false]) {
  const patch = applyConfigPatch(sanitizeConfig({}), { codexQuotaSidebar: enabled })
  assert.deepEqual(patch.errors, [])
  const wire = stateSchema.shape.config.parse(patch.config)
  assert.equal(ui.parseConfig(wire, 'config').codexQuotaSidebar, enabled, 'strict RPC and client readers preserve the new field')
}
assert.ok(applyConfigPatch(sanitizeConfig({}), { codexQuotaSidebar: 'false' }).errors.length > 0)

for (const locale of ['zh', 'en']) {
  const t = ui.makeT(locale)
  {
    let draft = roundTrip({ locale, codingPlans: { qwen: { enabled: true, quotaSource: 'bailian', display: 'both' } } })
    const state = { config: draft, codingPlans: { qwen: { quotaSource: 'bailian', loginRequired: true, status: 'error', windows: {} } } }
    let loginCalls = 0, refreshCalls = 0, finishLogin
    const api = {
      loginCodingPlan: id => {
        assert.equal(id, 'qwen'); loginCalls++
        return new Promise(resolve => { finishLogin = resolve })
      },
      refreshCodingPlan: async () => { refreshCalls++; return { ok: true, message: 'synthetic quota refreshed' } },
    }
    const render = renderer(ui.PlanQuotaCard, () => ({ state, draft, setDraft: value => { draft = value }, api, t, planId: 'qwen', labelKey: 'codingPlanQwen' }))
    const loginButton = button(render(), t('loginCodingPlan'))
    assert.equal(loginButton.props.disabled, false)
    const first = loginButton.props.onClick(), duplicate = loginButton.props.onClick()
    assert.equal(loginCalls, 1, 'same-tick login clicks use one action')
    assert.equal(button(render(), t('loggingIn')).props.disabled, true)
    state.codingPlans.qwen.loginRequired = false
    const refreshDuringLogin = button(render(), t('refreshing'))
    assert.equal(refreshDuringLogin.props.disabled, true, 'login state change cannot enable refresh while the action is pending')
    await refreshDuringLogin.props.onClick()
    assert.equal(refreshCalls, 0)
    finishLogin({ ok: true, message: 'synthetic login completed' })
    await Promise.all([first, duplicate])
    assert.ok(textOf(render()).includes('synthetic login completed'), 'success message survives switching to Refresh')
    await button(render(), t('refresh')).props.onClick()
    assert.equal(refreshCalls, 1)
    state.codingPlans.qwen.loginRequired = true
    draft = roundTrip({ ...draft, codingPlans: { qwen: { ...draft.codingPlans.qwen, quotaSource: 'local' } } })
    assert.equal(button(render(), t('loginCodingPlan')), undefined, 'an unsaved source switch cannot expose a stale login action')
    state.config = draft
    assert.equal(button(render(), t('loginCodingPlan')), undefined, 'local mode never offers Bailian login')
  }
  {
    let draft = roundTrip({ locale, codingPlans: { minimax: { enabled: true } } })
    const state = { config: draft, codingPlans: {} }
    const render = renderer(ui.PlanQuotaCard, () => ({ state, draft, setDraft: v => { draft = v }, api: {}, t, planId: 'minimax', labelKey: 'codingPlanMinimax' }))
    nodes(render()).find(node => node.props.className === 'cm-collapse-h').props.onClick()
    const input = () => nodes(render()).find(node => node.props['aria-label'] === t('minimaxOrigin'))
    assert.equal(input().props.value, '')
    assert.ok(textOf(render()).includes(t('minimaxOriginNote')))
    input().props.onChange({ target: { value: 'https://www.minimax.cn/' } })
    const saved = applyConfigPatch(state.config, { codingPlans: draft.codingPlans })
    assert.deepEqual(saved.errors, [])
    draft = state.config = roundTrip(saved.config)
    assert.equal(input().props.value, 'https://www.minimax.cn')
    input().props.onChange({ target: { value: 'https://proxy.example:8443' } })
    draft = state.config = roundTrip(applyConfigPatch(state.config, { codingPlans: draft.codingPlans }).config)
    assert.equal(input().props.value, 'https://proxy.example:8443')
    input().props.onChange({ target: { value: '' } })
    draft = state.config = roundTrip(applyConfigPatch(state.config, { codingPlans: draft.codingPlans }).config)
    assert.equal(input().props.value, '', '清空并回读后恢复自动选择')
  }
  let draft = roundTrip({ locale, codingPlans: { qwen: { enabled: true } } })
  const state = { config: draft, codingPlans: {}, customVarStatus: {} }
  const render = renderer(ui.PlanQuotaCard, () => ({ state, draft, setDraft: value => { draft = value }, api: {}, t, planId: 'qwen', labelKey: 'codingPlanQwen' }))
  let tree = render()
  // 统一卡片外壳默认收起:先展开,配置区(含千问费率)才渲染。
  nodes(tree).find(node => node.props.className === 'cm-collapse-h').props.onClick()
  tree = render()
  const sourceSelect = () => nodes(render()).find(node => node.type === 'select' && node.children.some(child => child?.props?.value === 'cli'))
  assert.equal(sourceSelect().props.value, 'local')
  sourceSelect().props.onChange({ target: { value: 'cli' } })
  draft = state.config = roundTrip(applyConfigPatch(state.config, { codingPlans: draft.codingPlans }).config)
  assert.equal(sourceSelect().props.value, 'cli', 'CLI 来源通过服务端/客户端回读')
  assert.ok(textOf(render()).includes(t('codingPlanRefreshIntervalLabel')))
  assert.ok(!textOf(render()).includes(t('qwenPlanCreditsLabel')))
  assert.equal(nodes(render()).some(node => node.props.target === 'codingPlans.qwen'), false, 'CLI 模式不收集 API Key')
  sourceSelect().props.onChange({ target: { value: 'local' } })
  assert.ok(!textOf(render()).includes(t('codingPlanRefreshIntervalLabel')))
  tree = render()
  nodes(tree).find(node => node.props.placeholder === t('qwenRatesModelPlaceholder')).props.onChange({ target: { value: 'qwen3.8-flash' } })
  button(render(), t('qwenRatesAdd')).props.onClick()
  tree = render()
  assert.ok(rowFor(tree, 'qwen3.8-flash'), '添加后存在空行')
  assert.equal(draft.codingPlans.qwen.rates['qwen3.8-flash'], undefined, '空行不会作为无效费率发送给服务端')
  // 模拟无关设置自动保存/轮询；空行必须仍可输入。
  draft = state.config = roundTrip(draft)
  tree = render()
  let row = rowFor(tree, 'qwen3.8-flash')
  assert.ok(row, '服务端回读后空行仍存在(#103)')
  const fields = nodes(row).filter(node => node.type === 'input')
  fields[0].props.onChange({ target: { value: '12.5' } })
  draft = state.config = roundTrip(draft)
  row = rowFor(render(), 'qwen3.8-flash')
  assert.equal(Number(nodes(row).find(node => node.type === 'input').props.value), 12.5, '未填齐三项时草稿也不会被轮询清空')
  assert.equal(draft.codingPlans.qwen.rates['qwen3.8-flash'], undefined, '部分费率不能成为计费依据')
  nodes(row).filter(node => node.type === 'input')[1].props.onChange({ target: { value: '1.5' } })
  row = rowFor(render(), 'qwen3.8-flash')
  nodes(row).filter(node => node.type === 'input')[2].props.onChange({ target: { value: '30' } })
  const saved = applyConfigPatch(state.config, { codingPlans: draft.codingPlans })
  assert.deepEqual(saved.errors, [])
  draft = state.config = roundTrip(saved.config)
  row = rowFor(render(), 'qwen3.8-flash')
  assert.equal(Number(nodes(row).find(node => node.type === 'input').props.value), 12.5, '费率保存回读一致')
  assert.equal(draft.codingPlans.qwen.rates['qwen3.8-flash'].input, 12.5)
  for (let index = 0; index < 3; index++) {
    row = rowFor(render(), 'qwen3.8-flash')
    nodes(row).filter(node => node.type === 'input')[index].props.onChange({ target: { value: '' } })
  }
  const cleared = applyConfigPatch(state.config, { codingPlans: draft.codingPlans })
  assert.deepEqual(cleared.errors, [])
  assert.equal(cleared.config.codingPlans.qwen.rates['qwen3.8-flash'], undefined, '三项清空后服务端不能深合并复活旧费率')
  draft = state.config = roundTrip(cleared.config)
  assert.ok(rowFor(render(), 'qwen3.8-flash'), '清空最后一个费率仍保留编辑行')
  button(rowFor(render(), 'qwen3.8-flash'), t('overrideRemove')).props.onClick()
  assert.equal(rowFor(render(), 'qwen3.8-flash'), undefined, '显式移除后不再显示')

  timers.clear()
  const key = 'test-provider:unknown-model'
  const today = { ...zeroDay('2026-09-08'), byProviderModel: { [key]: { input: 5, output: 2, calls: 1, cost: 0 } } }
  const originalUsage = JSON.stringify(today)
  let current = { config: roundTrip({ locale, priceOverrides: { [key]: 'default' } }), today, month: today, total: today, history: [], balance: {} }
  const api = { updateConfig: async patch => {
    const result = applyConfigPatch(current.config, patch)
    assert.deepEqual(result.errors, [])
    current = { ...current, config: roundTrip(result.config) }
  } }
  const props = () => ({ useCost: () => ({ state: current, status: 'ready' }), api })
  let section = renderer(ui.CostSection, props)
  button(section(), t('tabDisplay')).props.onClick()
  const codexSidebarInput = () => nodes(section()).find(n => n.type === 'label' && textOf(n).includes(t('codexQuotaSidebar')))?.children.find(n => n?.type === 'input')
  assert.equal(codexSidebarInput().props.checked, true)
  codexSidebarInput().props.onChange({ target: { checked: false } })
  section()
  for (const fn of [...timers.values()]) fn()
  timers.clear()
  await Promise.resolve(); await Promise.resolve()
  section()
  assert.equal(current.config.codexQuotaSidebar, false, 'checkbox auto-save persists in both locales')
  assert.equal(codexSidebarInput().props.checked, false)
  for (const key of ['hideSessionCostHeader', 'hideSessionCostDock', 'hideTurnCost', 'sessionCostCompact']) {
    const checkbox = () => nodes(section()).find(n => n.type === 'label' && textOf(n) === t(key))?.children.find(n => n?.type === 'input')
    for (const checked of [true, false]) {
      checkbox().props.onChange({ target: { checked } }); section()
      for (const fn of [...timers.values()]) fn()
      timers.clear()
      await Promise.resolve(); await Promise.resolve(); section()
      assert.equal(current.config[key], checked, `${locale}: ${key} auto-save`)
      assert.equal(checkbox().props.checked, checked)
    }
  }
  const openPrices = () => { const tree = section(); button(tree, t('tabPricing')).props.onClick(); return section() }
  tree = openPrices()
  row = rowFor(tree, 'unknown-model')
  assert.ok(row)
  button(row, t('overrideRemove')).props.onClick()
  tree = section()
  assert.equal(rowFor(tree, 'unknown-model'), undefined, '删除映射后账本不会立即重新生成该行(#104)')
  for (const fn of [...timers.values()]) fn()
  timers.clear()
  await Promise.resolve(); await Promise.resolve()
  tree = section()
  assert.equal(rowFor(tree, 'unknown-model'), undefined, '自动保存回读后仍隐藏')
  assert.equal(current.config.priceMatchDismissed[0], key)
  assert.equal(current.config.priceOverrides[key], undefined)
  assert.equal(JSON.stringify(today), originalUsage, '移除匹配行保留全部用量记录')
  // 整个设置组件重新挂载，持久隐藏仍生效；用户可主动恢复。
  section = renderer(ui.CostSection, props)
  tree = openPrices()
  assert.equal(rowFor(tree, 'unknown-model'), undefined)
  button(tree, t('restorePriceMatches', { count: 1 })).props.onClick()
  tree = section()
  assert.ok(rowFor(tree, 'unknown-model'), '支持恢复未命中模型')
  timers.clear()

  const compact = applyConfigPatch(sanitizeConfig({ locale }), { sidebarStyle: 'compact' })
  assert.deepEqual(compact.errors, [])
  assert.equal(roundTrip(compact.config).sidebarStyle, 'compact', '紧凑布局配置可往返')
  assert.ok(applyConfigPatch(compact.config, { sidebarStyle: 'invalid' }).errors.length > 0)
  assert.equal(ui.codingPlanWindowLabel('daily', t), t('goShortDaily'), 'daily 窗口双语标签')

  // #157: selecting the official CNY source preserves the display rate and history;
  // the hint remains until an actual CNY table has been synced.
  timers.clear()
  const patches = []
  current = { ...current, config: roundTrip({ locale, currency: 'CNY', pricingCurrency: 'USD', exchangeRate: 7.2 }) }
  const currencyApi = { updateConfig: async patch => {
    patches.push(patch)
    current = { ...current, config: roundTrip(applyConfigPatch(current.config, patch).config) }
  } }
  section = renderer(ui.CostSection, () => ({ useCost: () => ({ state: current, status: 'ready' }), api: currencyApi }))
  tree = openPrices()
  assert.ok(textOf(tree).includes(t('pricingCnyHint', { rate: 7.2 })))
  button(tree, t('pricingCurrencyCny')).props.onClick()
  section()
  for (const fn of [...timers.values()]) fn()
  timers.clear()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(patches.length, 1)
  assert.equal(JSON.stringify(patches[0]), JSON.stringify({ pricingCurrency: 'CNY' }))
  assert.equal(current.config.exchangeRate, 7.2)
  assert.ok(textOf(section()).includes(t('pricingCnyHint', { rate: 7.2 })))
  for (const patch of [{ prices: { ...current.config.prices, currency: 'CNY' } }, { currency: 'USD' }]) {
    current = { ...current, config: roundTrip({ ...current.config, ...patch }) }
    assert.ok(!textOf(section()).includes(t('pricingCnyHint', { rate: 7.2 })))
  }
  timers.clear()
}
assert.ok(applyConfigPatch(sanitizeConfig({}), { priceMatchDismissed: [null] }).errors.length > 0)
assert.deepEqual(sanitizeConfig({ priceMatchDismissed: ['a:b', 'a:b', '', null] }).priceMatchDismissed, ['a:b'])
const named = parseAntigravityQuota({ groups: [{ id: 'stable-id', display_name: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.5 }] }] })
assert.equal(named.windows[0].id, 'stable-id:five-hour', '显示名不会改变服务端明确的分组 ID')
assert.equal(named.windows[0].label, 'Gemini · 5h')
const credits = qwenTokenPlanWindows({ '2026-09-08': { byProviderModel: { 'qwen:Qwen3.8-Flash': { input: 1e6, cacheRead: 2e6, output: 1e6 } } } }, {
  planCredits: 500000, rates: { 'qwen3.8-flash': { input: 12.5, cachedInput: 1.5, output: 30 } },
}, Date.parse('2026-09-08T00:00:00Z'))
assert.equal(credits.used, 45.5, '带点号和连字符的模型名覆盖确实参与 Credits 折算(#103)')
console.log('[ok] 设置交互：千问空费率/自动保存回读/模型移除与恢复/用量保留/侧栏样式/日标签通过')
