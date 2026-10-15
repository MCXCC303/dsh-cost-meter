import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sanitizeConfig, zeroDay } from '../lib/store.js'

// Exercises the source and shipped asset against real Cordis service lifetimes.
const root = fileURLToPath(new URL('../', import.meta.url))
const req = createRequire(new URL('../package.json', import.meta.url))
let cordisPath
if (process.env.DSH_TEST_NODE_MODULES) {
  cordisPath = createRequire(join(process.env.DSH_TEST_NODE_MODULES, '__locale_client.cjs')).resolve('@deepseek-ai/cordis')
} else {
  try { cordisPath = req.resolve('@deepseek-ai/cordis') }
  catch { cordisPath = createRequire(req.resolve('@deepseek-ai/dsh-credentials/package.json')).resolve('@deepseek-ai/cordis') }
}
const { Context, Service } = await import(pathToFileURL(cordisPath).href)
const baseline = process.argv.includes('--baseline')
const baselineRef = '77637b5b53f78719462151c99531865aa2280df3'
const readSource = path => baseline ? execFileSync('git', ['show', baselineRef + ':' + path], { cwd: root, encoding: 'utf8' }) : readFileSync(join(root, path), 'utf8')
const wait = () => new Promise(resolve => setTimeout(resolve, 30))
async function scenario({ initial = 'zh', explicit = 'auto', late = false, browser = 'en-US', noService = false, metaLocale, malformed = false }) {
  const ctx = new Context()
  const registrations = new Map(), timers = new Set(), documentListeners = new Map(), windowListeners = new Map(), localeListeners = new Set()
  let active = initial, factory, mounted = 0, unmounted = 0, writes = 0, writtenPatch
  const config = sanitizeConfig({ locale: explicit, hideOfficialBalance: true, goQuota: { enabled: false } })
  const state = { config, today: zeroDay(), month: zeroDay(), total: zeroDay(), budgetUsed: 0, codingPlans: {}, history: [], meta: { now: 1, dayKey: '2026-10-03', monthKey: '2026-10', ...(metaLocale ? { locale: metaLocale } : {}) } }
  let forcedDraft, hookIndex = 0
  const browserData = { language: browser }
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useState: initial => [forcedDraft && hookIndex++ === 0 ? forcedDraft : typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {}, useRef: value => ({ current: value }), Fragment: 'Fragment' }
  const source = readSource('lib/client.js')
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { factory = value.factory } }, addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: (name, fn) => { if (windowListeners.get(name) === fn) windowListeners.delete(name) } }, navigator: browserData,
    document: { querySelector: () => ({}), addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: (name, fn) => { if (documentListeners.get(name) === fn) documentListeners.delete(name) }, hidden: false, documentElement: { lang: '' } },
    setInterval: fn => { timers.add(fn); return fn }, clearInterval: fn => timers.delete(fn), queueMicrotask, AbortController, AbortSignal, console,
  })
  // 分块产物:按平台 classic-script 语义各自注册一个 factory,再用种子 require 调它。
  // 种子用本用例的 React 桩;`react-dom` 只需要 createPortal(context 桥在 slots 缺
  // entries 时不会启用),primitives 只需要 Tooltip。
  const loadChunk = name => {
    let chunkFactory
    vm.runInNewContext(readSource('lib/' + name), {
      window: { __ModuleLoader__: { load: value => { chunkFactory = value.factory } } }, navigator: browserData,
    })
    return chunkFactory(id => id === 'react' ? React
      : id === 'react-dom' ? { createPortal: children => children }
        : id === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: 'Tooltip' } : {})
  }
  const statistics = loadChunk('client.statistics.js')
  // 基线提交还没有 settings 分块(启动包当时不按需加载设置页),基线分支也不会渲染它。
  const settings = baseline ? null : loadChunk('client.settings.js')
  const requireMain = name => name === 'react' ? React : {}
  const chunks = { './client.statistics.js': statistics, './client.settings.js': settings }
  requireMain.async = async id => { assert.ok(chunks[id], 'unexpected chunk ' + id); return chunks[id] }
  const main = factory(requireMain)
  class Remote extends Service {
    constructor(owner) { super(owner, 'remote'); this.costMeter = { getState: async () => ({ ok: true, value: state }), updateConfig: async patch => { writes++; writtenPatch = patch; return { ok: true, value: state } } }; this.costMeter.getLocalState = this.costMeter.getState; owner.provide('remote.costMeter', this.costMeter) }
    async $mount() { mounted++; return () => { unmounted++ } }
  }
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots') }
    inject(name, fn) { return this.ctx.effect(fn) }
    register(options, component) { const key = options.name + ':' + options.id; const value = { options, component }; registrations.set(key, value); return () => { if (registrations.get(key) === value) registrations.delete(key) } }
  }
  class Locale extends Service {
    constructor(owner) { super(owner, 'locale') }
    getSnapshot() { if (malformed) throw Error('unavailable locale snapshot'); return { active, locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 } }
    subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn) }
    set(value) { active = value; for (const fn of [...localeListeners]) fn(); this.ctx.emit('locale/change', { active }) }
  }
  await ctx.plugin(Remote); await ctx.plugin(Slots)
  let localeFiber
  if (!noService && !late) { localeFiber = ctx.plugin(Locale); await localeFiber }
  const fiber = ctx.plugin(main); await fiber; await wait()
  const entry = () => registrations.get('settings.section:cost-meter')
  const label = () => entry()?.options.label
  const expected = language => language === 'en' ? 'Cost' : '费用'
  const fallback = () => metaLocale || (browserData.language?.startsWith('zh') ? 'zh' : 'en')
  const face = () => !malformed && (active === 'zh' || active === 'en') ? active : fallback()
  assert.equal(label(), baseline ? 'Cost' : expected(explicit === 'auto' ? (!late && !noService ? face() : fallback()) : explicit), baseline ? '#226 baseline reproduces browser English despite DSH Chinese' : 'first registered language')
  const store = entry().options.inject().hooks.cost
  let notifications = 0
  store.subscribe(() => { notifications++ })
  if (!baseline && late && !noService) { localeFiber = ctx.plugin(Locale); await localeFiber; await wait(); assert.equal(label(), expected(explicit === 'auto' ? face() : explicit), 'late provision adopted initial locale with no locale/change event') }
  if (!baseline && !noService) {
    const before = store.getSnapshot()
    ctx.locale.set('en'); await wait()
    assert.equal(label(), expected(explicit === 'auto' ? face() : explicit), 'live English language')
    ctx.locale.set('zh'); await wait()
    assert.equal(label(), expected(explicit === 'auto' ? face() : explicit), 'live Chinese language')
    if (explicit === 'auto') { assert.ok(notifications > 0, 'locale change notifies component store subscribers'); assert.notEqual(store.getSnapshot(), before, 'locale change publishes a new store snapshot') }
    await localeFiber.dispose(); await wait()
    assert.equal(label(), expected(explicit === 'auto' ? fallback() : explicit), 'locale provider removal immediately adopts fallback')
    active = initial
    localeFiber = ctx.plugin(Locale); await localeFiber; await wait()
    assert.equal(label(), expected(explicit === 'auto' ? face() : explicit), 'replacement locale provider is subscribed')
  }
  if (!baseline) {
    browserData.language = browserData.language?.startsWith('zh') ? 'en-US' : 'zh-CN'
    windowListeners.get('languagechange')?.(); await wait()
    assert.equal(label(), expected(explicit === 'auto' ? noService ? fallback() : face() : explicit), 'browser language change affects only a fallback automatic locale')
  }
  assert.equal(config.locale, explicit, 'locale mode is not rewritten')
  assert.equal(writes, 0, 'no updateConfig mutation for automatic locale')
  if (!baseline) {
    const api = entry().options.inject().api
    forcedDraft = { ...store.getSnapshot().state.config, activeLocale: label() === 'Cost' ? 'zh' : 'en', decimals: 4 }
    hookIndex = 0
    // 启动包注册的 settings 分节现在是「按需分块」懒组件(启动包不能静态 import 分块,
    // 首次渲染只返回 null 并异步取分块)。这里用等价取法:直接渲染分块导出的 CostSection
    // ——也就是懒包装最终挂载的组件,断言意图与强制草稿机制不变。
    const settingsSection = settings.CostSection ?? settings.mount()
    const settingsTree = settingsSection({ api, useCost: select => select(store.getSnapshot()) })
    const settingsText = JSON.stringify(settingsTree)
    assert.ok(settingsText.includes(label() === 'Cost' ? 'Overview' : '概览'), 'dirty auto draft uses the live language rather than a stale derived field')
    forcedDraft = undefined
    const Page = await api.loadStatistics()
    const props = Page({ state: store.getSnapshot().state, formatMoneyUsd: String, formatTokens: String }).props
    const rendered = statistics.Statistics(props)
    const header = rendered.props.children.find(child => child?.type === 'header')
    const title = header.props.children[0].props.children[0].props.children[0]
    assert.equal(title, label() === 'Cost' ? 'Cost statistics' : '计费统计', 'standalone statistics uses the same active language')
    await api.updateConfig({ decimals: 4, activeLocale: 'en' })
    assert.equal(writes, 1, 'manual configuration update still works')
    assert.deepEqual(JSON.parse(JSON.stringify(writtenPatch)), { decimals: 4 }, 'transient activeLocale never crosses the update RPC')
  }
  await fiber.dispose(); await wait()
  assert.equal(localeListeners.size, 0, 'locale subscriptions fully disposed')
  assert.equal(timers.size, 0, 'poll timers fully disposed')
  assert.equal(documentListeners.size, 0, 'DOM listeners fully disposed')
  assert.equal(windowListeners.size, 0, 'browser language listeners fully disposed')
  assert.equal(unmounted, mounted, 'remote contribution withdrawn')
  assert.equal(registrations.size, 0, 'slot registrations withdrawn')
  await ctx.fiber.dispose()
  return true
}

async function mixedClients() {
  let factory
  const timers = new Set(), contexts = []
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }
  const source = readSource('lib/client.js')
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { factory = value.factory } } }, navigator: { language: 'en-US' },
    document: { querySelector: () => ({}), addEventListener() {}, removeEventListener() {}, hidden: false },
    setInterval: fn => { timers.add(fn); return fn }, clearInterval: fn => timers.delete(fn), console,
  })
  const main = factory(name => name === 'react' ? React : {})
  class Remote extends Service {
    constructor(owner) { super(owner, 'remote'); const getState = async () => ({ ok: true, value: { config: sanitizeConfig({ locale: 'auto', hideOfficialBalance: true }), meta: {} } }); owner.provide('remote.costMeter', { getState, getLocalState: getState }) }
    async $mount() { return () => {} }
  }
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots'); this.entries = new Map() }
    inject(name, fn) { return this.ctx.effect(fn) }
    register(options, component) { this.entries.set(options.id, { options, component }); return () => this.entries.delete(options.id) }
  }
  class Locale extends Service {
    constructor(owner, config) { super(owner, 'locale'); this.active = config.active; this.listeners = new Set() }
    getSnapshot() { return { active: this.active } }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
    set(active) { this.active = active; for (const fn of [...this.listeners]) fn(); this.ctx.emit('locale/change', { active }) }
  }
  try {
    for (const active of ['zh', 'en']) {
      const ctx = new Context(); contexts.push(ctx)
      await ctx.plugin(Remote); await ctx.plugin(Slots); await ctx.plugin(Locale, { active }); await ctx.plugin(main)
    }
    await wait()
    const [chinese, english] = contexts
    const snapshot = ctx => ctx.slots.entries.get('cost-meter').options.inject().hooks.cost.getSnapshot()
    assert.equal(snapshot(chinese).state.config.activeLocale, 'zh')
    assert.equal(snapshot(english).state.config.activeLocale, 'en')
    english.locale.set('zh'); chinese.locale.set('en'); await wait()
    assert.equal(snapshot(chinese).state.config.activeLocale, 'en', 'first client updates independently')
    assert.equal(snapshot(english).state.config.activeLocale, 'zh', 'second client keeps its own language from the same module factory')
    assert.equal(snapshot(chinese).state.config.locale, 'auto')
    assert.equal(snapshot(english).state.config.locale, 'auto')
    await chinese.fiber.dispose()
    assert.equal(timers.size, 1, 'disposing one client leaves the other polling lifetime intact')
    english.locale.set('en'); await wait()
    assert.equal(snapshot(english).state.config.activeLocale, 'en', 'remaining client still updates after the first disposes')
    console.log('[ok] bundle simultaneous mixed-locale clients reuse one module factory independently')
  } finally {
    for (const ctx of contexts) await ctx.fiber.dispose()
    assert.equal(timers.size, 0, 'both client lifetimes clean up')
  }
}

// 旧源码片段已删除:只跑构建产物(lib/client.js + lib/client.<name>.js 分块)。
// --baseline 改读基线提交的产物(基线提交有 client.js / client.statistics.js,尚无 settings 分块)。
for (const options of baseline ? [{ initial: 'zh', browser: 'en-US' }] : [
  { initial: 'zh' }, { initial: 'en', browser: 'zh-CN' },
  { initial: 'zh', explicit: 'en' }, { initial: 'en', explicit: 'zh' },
  { initial: 'zh', late: true }, { initial: 'en', late: true, browser: 'zh-CN' },
  { noService: true, browser: 'en-US' }, { noService: true, browser: 'zh-CN' },
  { noService: true, browser: 'en-US', metaLocale: 'zh' },
  { initial: 'fr', browser: 'en-US' }, { initial: 'zh', malformed: true, browser: 'en-US' },
]) { await scenario(options); console.log('[ok] bundle', JSON.stringify(options)) }
if (!baseline) await mixedClients()
