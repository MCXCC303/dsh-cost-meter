import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { sanitizeConfig } from '../lib/store.js'
import { DEFAULT_PROVIDER_PRICE_TABLE, normalizePrice, costOf } from '../lib/pricing.js'

/**
 * 构建客户端 bundle 一次;每个 environment() 复制成独立文件再 import,复刻旧 vm
 * 沙箱「每个环境独立模块状态」的语义(codexQuotaCache 等模块级缓存互不串味)。
 * 源码已是 ES 模块(旧片段已删),fetchCodexQuota 未 export,打包时追加等价 export。
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
let clientBundlePath = null
let clientInstanceSeq = 0
async function instantiateClient() {
  if (clientBundlePath === null) {
    const work = mkdtempSync(join(tmpdir(), 'cm-client-issues-'))
    const reactStub = join(work, 'react-stub.cjs')
    const primitivesStub = join(work, 'primitives-stub.cjs')
    writeFileSync(reactStub, 'const base = { Fragment: "fragment", createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),'
      + ' useState: value => [typeof value === "function" ? value() : value, () => {}], useEffect: () => {}, useRef: value => ({ current: value ?? null }),'
      + ' useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: (_sub, get) => get() }\n'
      + 'const R = Object.assign({}, base, globalThis.__cmReactStub ?? {})\nmodule.exports = R\nmodule.exports.default = R\n')
    writeFileSync(primitivesStub, 'module.exports = { Tooltip: "Tooltip", Button: "Button" }\nmodule.exports.default = module.exports\n')
    const entry = join(work, 'entry.ts')
    writeFileSync(entry, ['logic', 'ui-badge', 'ui-quota', 'ui-sidebar', 'ui-balance']
      .map(name => `export * from ${JSON.stringify(fileURLToPath(new URL(`../src/client/${name}.ts`, import.meta.url)))}\n`).join(''))
    const outfile = join(work, 'bundle.cjs')
    await esbuild({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
      banner: { js: CLIENT_ENV_BANNER },
      alias: { react: reactStub, '@deepseek-ai/dsh-client-ui-primitives': primitivesStub },
      plugins: [{
        name: 'expose-private',
        setup(build) {
          build.onLoad({ filter: /ui-quota\.ts$/ }, args => {
            const source = readFileSync(args.path, 'utf8')
            const missing = ['fetchCodexQuota'].filter(name => !new RegExp(`export (?:function|const|let|class) ${name}\\b`).test(source))
            return { contents: missing.length > 0 ? source + `\nexport { ${missing.join(', ')} }\n` : source, loader: 'ts' }
          })
        },
      }],
    })
    clientBundlePath = outfile
  }
  const copy = clientBundlePath.replace(/\.cjs$/, `-${++clientInstanceSeq}.cjs`)
  copyFileSync(clientBundlePath, copy)
  const mod = await import(pathToFileURL(copy).href)
  return mod.default ?? mod
}

const element = (type, props, ...children) => ({ type, props: props ?? {}, children })
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.children)] : []
const textOf = value => Array.isArray(value) ? value.map(textOf).join(' ') : value && typeof value === 'object' ? textOf(value.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// 每个实例拥有自己的 hook 槽位;effect 依赖变化先 cleanup,异步 setState 支持函数更新。
async function environment(fetchImpl = async () => ({ ok: false })) {
  let current, nextTimer = 0
  const storage = new Map(), timers = new Map(), requests = []
  const schedule = (fn, delay, repeat) => { const id = ++nextTimer; timers.set(id, { fn, delay, repeat }); return id }
  const React = {
    createElement: element, Fragment: 'fragment',
    useState(init) {
      const owner = current, index = owner.cursor++
      if (!owner.hooks[index]) owner.hooks[index] = { value: typeof init === 'function' ? init() : init }
      const slot = owner.hooks[index]
      return [slot.value, update => {
        if (owner.disposed) return
        const value = typeof update === 'function' ? update(slot.value) : update
        if (!Object.is(slot.value, value)) { slot.value = value; owner.dirty = true }
      }]
    },
    useRef(value) { const index = current.cursor++; return current.hooks[index] ??= { current: value } },
    useEffect(effect, dependencies) {
      const owner = current, index = owner.cursor++, previous = owner.hooks[index]
      if (!previous || dependencies === undefined || !previous.dependencies || dependencies.some((item, i) => !Object.is(item, previous.dependencies[i]))) {
        owner.effects.push(() => {
          previous?.cleanup?.()
          const cleanup = effect()
          owner.hooks[index] = { dependencies, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
      }
    },
  }
  // 旧 vm 沙箱的等价物:客户端模块读到的 React / window / fetch / 计时器由本环境提供
  // (banner 在实例化时绑定到模块作用域),互不串味、也不污染宿主与其它测试。
  globalThis.__cmReactStub = React
  globalThis.__cmEnv = {
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) } },
    navigator: { language: 'en' }, AbortSignal,
    fetch: (...args) => { requests.push(args); return fetchImpl(...args) },
    setTimeout: (fn, delay) => schedule(fn, delay, false), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
  }
  const ui = await instantiateClient()
  for (const name of ['mergeSessionUsage', 'useSessionUsage', 'SessionCost', 'DockLine', 'fetchCodexQuota', 'useCodexQuota', 'codexQuotaCache', 'CodexPlanBox', 'SidebarFooter', 'GatewayQuotaBox', 'parsePrice', 'normalizeClientPrice', 'tierFor', 'costOfBuckets', 'TurnCost', 'QuotaStrip']) {
    assert.ok(ui[name] !== undefined, '客户端符号可取: ' + name)
  }
  const instances = []
  const mount = (render, props = {}) => {
    const owner = { hooks: [], cursor: 0, effects: [], dirty: false, disposed: false, props, tree: null }
    owner.render = (next = owner.props) => {
      owner.props = next
      let loops = 0
      do {
        assert.ok(loops++ < 20, 'hook harness 不应产生同步渲染循环')
        owner.cursor = 0; owner.effects = []; owner.dirty = false
        current = owner; owner.tree = render(owner.props); current = null
        for (const effect of owner.effects) effect()
      } while (owner.dirty)
      return owner.tree
    }
    owner.dispose = () => { owner.disposed = true; for (const slot of owner.hooks) slot?.cleanup?.() }
    instances.push(owner)
    owner.render()
    return owner
  }
  const flush = async () => {
    for (let n = 0; n < 12; n++) {
      await Promise.resolve()
      for (const owner of instances) if (owner.dirty && !owner.disposed) owner.render()
    }
  }
  const tick = async delay => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay || !timers.has(id)) continue
      if (!timer.repeat) timers.delete(id)
      timer.fn()
    }
    await flush()
  }
  return { ui, storage, requests, mount, flush, tick, timers, dispose: () => instances.forEach(owner => owner.dispose()) }
}

const config = sanitizeConfig({ locale: 'en', currency: 'USD', symbol: '$', exchangeRate: 1, decimals: 2, peakEnabled: false,
  sidebar: false, hideTodayCost: true, hideOfficialBalance: true, goQuota: { enabled: false }, budget: { enabled: false } })
const usage = (input, cost, apiCost) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost, ...(apiCost === undefined ? {} : { apiCost }) })
const snapshot = (own, subagents = usage(0, 0, 0), found = true) => ({ own, subagents, found, subagentCount: subagents.input > 0 ? 1 : 0 })
const e = await environment()
// #205: show exact bucket arithmetic, keep Plan separate and reject stale replies.
{
  const requests = []
  let cfg = { ...config }
  const p = id => ({ sessionId: id, turn: { start: { seq: 1 }, end: { seq: 4 } },
    useCost: pick => pick({ state: { config: cfg } }), api: { getTurnCost: (...args) => { const d = deferred(); requests.push({ ...d, args }); return d.promise } } })
  const card = e.mount(e.ui.TurnCost, p('one'))
  assert.deepEqual(requests[0].args, ['one', 1, 4])
  card.render(p('two'))
  requests[1].resolve({ found: true, cost: 0.0002, apiCost: 0.0001, rows: [
    { provider: 'test', model: 'm', bucket: 'input', tokens: 100, rate: 1, cost: 0.0001, priced: true, plan: false },
    { provider: 'test', model: 'plan', bucket: 'output', tokens: 50, rate: 2, cost: 0.0001, priced: true, plan: true },
  ], calls: [
    { kind: 'model', provider: 'test', model: 'm', atMs: 1800000000000, cost: 0.0001, plan: false, priced: true, longContext: true, rows: [] },
    { kind: 'search', provider: 'deepseek-official', model: 'deepseek-v4-flash', atMs: 1800000000001, cost: 0.00000001, plan: false, priced: true, rows: [] },
    { kind: 'compaction', provider: 'test', model: 'plan', atMs: 1800000000002, cost: 0.0001, plan: true, priced: true, rows: [] },
  ] }); await e.flush()
  assert.match(textOf(card.tree), /Turn cost\s+≈ \$0\.0001/)
  assert.match(textOf(card.tree), /100 × \$1 \/ 1,000,000 ≈ \$0\.0001/)
  assert.match(textOf(card.tree), /Plan ≈ \$0\.0001/)
  assert.match(textOf(card.tree), /Individual calls \(3\)/)
  assert.match(textOf(card.tree), /Native search.*\$0\.00000001/)
  assert.match(textOf(card.tree), /Context compaction/)
  assert.match(textOf(card.tree), /long context/)
  requests[0].resolve({ found: true, cost: 99, apiCost: 99, rows: [], calls: [] }); await e.flush()
  assert.doesNotMatch(textOf(card.tree), /99/)
  cfg = structuredClone(cfg)
  card.render(p('two'))
  assert.equal(requests.length, 2, 'state polling with unchanged prices must not reread every turn')
  cfg = { ...cfg, locale: 'zh', showTotalWithPlan: true }
  card.render(p('two'))
  assert.match(textOf(card.tree), /本轮费用\s+≈ \$0\.0002/)
  assert.match(textOf(card.tree), /输入/)
  assert.equal(requests.length, 2)
  card.render({ ...p('two'), turn: { start: { seq: 1 } } })
  assert.equal(card.tree, null, 'unfinished turns do not request partial totals')
  card.dispose()
}
assert.equal(e.requests.length, 0, '加载 factory 不探测 Codex 插件')
const oldProjection = usage(10, 1), own = usage(100, 5, 3), child = usage(20, 2, 1)
assert.equal(e.ui.mergeSessionUsage(oldProjection, snapshot(own, child), false, config), own)
const merged = e.ui.mergeSessionUsage(oldProjection, snapshot(own, child), true, config)
assert.equal(merged.input, 120)
assert.equal(merged.cost, 7, '使用完整主账替代旧投影后仅加一次子代理')
assert.equal(merged.apiCost, 4, 'API 与 Plan 双轨保留账本实际金额')
assert.equal(e.ui.mergeSessionUsage(oldProjection, snapshot(own, child), false, config).cost, 5, '关闭后恢复主账')
assert.equal(e.ui.mergeSessionUsage(undefined, snapshot(usage(0, 0), child, false), true, config).cost, 2, '仅有子代理用量也能展示')
const freshProjection = usage(110, 6)
assert.equal(e.ui.mergeSessionUsage(freshProjection, snapshot(own, child), true, config).cost, 7, '账本金额优先于Token更多的投影，保持累计费用一致')
assert.equal(e.ui.mergeSessionUsage(freshProjection, snapshot(own, child), true, config).apiCost, 4)
const planProjection = { ...usage(200, 12), byProviderModel: { 'opencode-go:plan-model': usage(100, 7), 'deepseek:deepseek-v4-flash': usage(100, 5) } }
assert.equal(e.ui.mergeSessionUsage(planProjection, snapshot(own, child), true, { ...config, goQuota: { enabled: true } }).apiCost, 4, '投影的当前分类不改写历史账本金额')
assert.equal(e.ui.mergeSessionUsage(freshProjection, snapshot(usage(0, 0), child, false), true, config).cost, 2, '未入账/已超保留期投影不加入累计费用')
const sameBucketOwn = { ...own, byProviderModel: { 'custom:model': { ...own } } }
const sameBucketChild = { ...child, byProviderModel: { 'custom:model': { ...child } } }
const mergedBuckets = e.ui.mergeSessionUsage(oldProjection, snapshot(sameBucketOwn, sameBucketChild), true, config)
assert.equal(mergedBuckets.byProviderModel['custom:model'].cost, 7)
assert.equal(mergedBuckets.byProviderModel['custom:model'].apiCost, 4, '父子同一provider桶保留API分类合计')
assert.equal(mergedBuckets.apiCost, 4, '展示金额始终以完整顶层API成本为准')
const preserved = structuredClone(own)
e.ui.mergeSessionUsage(own, snapshot(own, child), true, config)
assert.deepEqual(own, preserved, '合并不改RPC快照或投影原对象')

let currentState = { config: { ...config, includeSubagentCost: true }, meta: { now: 1 } }
let projection = oldProjection
const pending = []
const api = { getSessionCost: id => { const request = deferred(); pending.push({ id, ...request }); return request.promise }, reload() {} }
const props = id => ({ sessionId: id, api, useProjection: () => projection, useCost: pick => pick({ state: currentState }) })
const session = e.mount(e.ui.useSessionUsage, props('A'))
assert.equal(pending[0].id, 'A')
session.render(props('B'))
assert.equal(pending[1].id, 'B')
pending[1].resolve(snapshot(usage(80, 8, 8), child)); await e.flush()
assert.equal(session.tree.usage.cost, 10)
pending[0].resolve(snapshot(usage(999, 99, 99))); await e.flush()
assert.equal(session.tree.usage.cost, 10, '切换后旧会话RPC迟到不能覆盖当前费用')
currentState = { ...currentState, config: { ...currentState.config, includeSubagentCost: false } }
session.render(props('B'))
assert.equal(session.tree.usage.cost, 1, '开关切换后不短暂展示旧聚合快照')
assert.equal([...e.timers.values()].filter(timer => timer.repeat).length, 0, '关闭子代理轮询时清理interval')
pending[2].resolve(snapshot(usage(80, 8, 8))); await e.flush()
assert.equal(session.tree.usage.cost, 8)
projection = usage(90, 9)
session.render(props('B'))
assert.equal(session.tree.usage.cost, 8, '等待RPC时保持已入账金额')
pending[3].reject(new Error('old server lacks RPC')); await e.flush()
assert.equal(session.tree.usage.cost, 8, 'RPC拒绝保留最近账本快照')
session.dispose()

projection = undefined
currentState = { config: { ...config, includeSubagentCost: true }, meta: { now: 2 } }
const onlyChild = e.mount(e.ui.DockLine, { ...props('child-only'), api: { getSessionCost: async () => snapshot(usage(0, 0), child, false) } })
await e.flush()
assert.ok(onlyChild.tree, '主会话无投影但子代理有费用时DockLine可见')
assert.match(textOf(onlyChild.tree), /This session \$1 \(API\)/, '仅子代理场景按真实API费用展示')
onlyChild.dispose()

// #160: cache reads / (uncached input + cache reads + cache writes), before Input.
for (const locale of ['en', 'zh']) {
  const dockConfig = { ...config, locale }
  for (const [tokens, expected] of [
    [{ input: 20, cacheRead: 60, cacheWrite: 20, output: 900 }, '60.0%'],
    [{ input: 20, cacheRead: 0, cacheWrite: 80 }, '0.0%'],
    [{ input: 0, cacheRead: 100, cacheWrite: 0 }, '100.0%'],
    [{ input: 0, cacheRead: 0, cacheWrite: 0, output: 10 }, '—'],
  ]) {
    const card = e.mount(e.ui.DockLine, { useProjection: () => ({ ...usage(0, 1), ...tokens }), useCost: pick => pick({ state: { config: dockConfig } }) })
    const text = textOf(card.tree)
    assert.ok(text.includes(expected))
    assert.ok(text.indexOf(expected) < text.indexOf(locale === 'en' ? 'Input' : '输入'))
    card.dispose()
  }
}

// #236: compact text retains the full line on hover and the header stays unchanged.
for (const locale of ['en', 'zh']) {
  let dockConfig = { ...config, locale, sessionCostCompact: false }
  const row = { ...usage(20, 7, 4), cacheRead: 60, cacheWrite: 20, output: 900 }
  const tokens = { ...row, byProviderModel: { 'custom:model': row } }
  const p = { useProjection: () => tokens, useCost: pick => pick({ state: { config: dockConfig } }) }
  const dock = e.mount(e.ui.DockLine, p), header = e.mount(e.ui.SessionCost, p)
  const full = textOf(dock.tree), headerText = textOf(header.tree), headerTitle = header.tree.props.label
  assert.match(full, /60\.0%/)
  dockConfig = { ...dockConfig, sessionCostCompact: true }
  dock.render(); header.render()
  assert.equal(textOf(dock.tree), locale === 'en' ? 'This session $4 (API) · Plan equiv. $3' : '本会话 $4(API)· Plan 等值 $3')
  assert.equal(dock.tree.props.title, full + '; custom:model $7', 'compact hover preserves full token/cache hit and model details')
  assert.equal(textOf(header.tree), headerText)
  assert.equal(header.tree.props.label, headerTitle)
  dockConfig = { ...dockConfig, showTotalWithPlan: true }
  dock.render()
  assert.equal(textOf(dock.tree), locale === 'en' ? 'This session $7' : '本会话 $7')
  assert.match(dock.tree.props.title, /60\.0%/)
  assert.doesNotMatch(dock.tree.props.title, /Plan/)
  dockConfig = { ...dockConfig, sessionCostCompact: false }
  dock.render()
  assert.match(textOf(dock.tree), /60\.0%/, 'turning compact off immediately restores token details')
  dock.dispose(); header.dispose()

  const outputOnly = e.mount(e.ui.DockLine, { useProjection: () => ({ ...usage(0, 1), output: 10 }),
    useCost: pick => pick({ state: { config: { ...dockConfig, sessionCostCompact: true } } }) })
  assert.equal(textOf(outputOnly.tree), locale === 'en' ? 'This session $1' : '本会话 $1')
  assert.match(outputOnly.tree.props.title, /—/, 'output-only sessions retain the unknown hit rate on hover')
  outputOnly.dispose()

  const childCost = e.mount(e.ui.DockLine, { sessionId: 'compact-child', useProjection: () => usage(999, 99),
    useCost: pick => pick({ state: { config: { ...dockConfig, sessionCostCompact: true, includeSubagentCost: true } } }),
    api: { getSessionCost: async () => snapshot(usage(80, 8, 8), usage(20, 2, 2)) } })
  await e.flush()
  assert.equal(textOf(childCost.tree), locale === 'en' ? 'This session $10' : '本会话 $10', 'compact uses retained ledger plus subagents, not stale projection')
  assert.match(childCost.tree.props.title, /100/)
  assert.doesNotMatch(childCost.tree.props.title, /999/)
  childCost.dispose()
}

// Codex 插件查询是显式选择:关闭状态不探测,开启才查询同源路由,关闭解除订阅。
const quotaRequest = deferred()
const quota = await environment(() => quotaRequest.promise)
const disabled = quota.mount(p => quota.ui.useCodexQuota(p.enabled), { enabled: false })
await quota.flush()
assert.equal(quota.requests.length, 0)
await quota.ui.fetchCodexQuota(true, false)
assert.equal(quota.requests.length, 0, '强制刷新也不能绕过禁用开关')
disabled.render({ enabled: true })
assert.equal(quota.requests.length, 1)
assert.equal(quota.requests[0][0], '/plugins/dsh-openai-codex/auth/status')
assert.equal(quota.requests[0][1].credentials, 'same-origin')
disabled.render({ enabled: false })
assert.equal(quota.ui.codexQuotaCache.listeners.length, 0)
quotaRequest.resolve({ ok: true, json: async () => ({ status: 'signed-in', usage: { rateLimits: [{ id: 'codex', windows: [{ windowSeconds: 604800, remainingPercent: 72, resetAt: 1800000000 }] }] } }) })
await quota.flush()
assert.equal(disabled.tree.status, 'idle', '关闭后进行中的返回不写已取消订阅的hook')
disabled.render({ enabled: true }); await quota.flush()
assert.equal(disabled.tree.status, 'ok', '重新启用可恢复在关闭期间完成的缓存')
assert.equal(disabled.tree.windows.weekly.percent, 28)
assert.equal(quota.requests.length, 1, '有效缓存无需重复查询')
const visible = quota.mount(quota.ui.CodexPlanBox, { state: { config: { ...config, codexQuotaEnabled: true } }, wide: true })
await quota.flush()
assert.ok(visible.tree)
// #207: sidebar display is independent of the conversation's quota strip.
let quotaConfig = { ...config, codexQuotaEnabled: true, codexQuotaSidebar: false, quotaStrip: { enabled: true, budget: false, go: false, plans: false } }
const quotaProps = () => ({ wide: true, useCost: pick => pick({ state: { config: quotaConfig } }) })
visible.render({ state: { config: quotaConfig }, wide: true })
assert.equal(visible.tree, null)
const sidebar = quota.mount(quota.ui.SidebarFooter, quotaProps())
const strip = quota.mount(quota.ui.QuotaStrip, quotaProps())
await quota.flush()
assert.equal(sidebar.tree, null, 'hiding the only sidebar card leaves no empty footer')
assert.match(textOf(strip.tree), /Codex/)
quotaConfig = { ...quotaConfig, codexQuotaSidebar: true }
sidebar.render(quotaProps())
assert.ok(nodes(sidebar.tree).some(n => n.type === quota.ui.CodexPlanBox), 're-enabling restores the sidebar card')
quotaConfig = { ...quotaConfig, codexQuotaEnabled: false }
sidebar.render(quotaProps()); strip.render(quotaProps())
assert.equal(sidebar.tree, null)
assert.equal(strip.tree, null, 'the global toggle still hides both surfaces')
sidebar.dispose(); strip.dispose()
visible.render({ state: { config: { ...config, codexQuotaEnabled: false } }, wide: true })
assert.equal(visible.tree, null, '禁用后即使缓存是ok也隐藏卡片')
disabled.render({ enabled: false })
await quota.tick(60000); await quota.tick(300000)
assert.equal(quota.requests.length, 1, '关闭后不重试、不轮询')
quota.dispose()

const missing = await environment(async () => ({ ok: false, status: 404 }))
const missingHook = missing.mount(p => missing.ui.useCodexQuota(p.enabled), { enabled: true })
await missing.flush()
assert.equal(missingHook.tree.status, 'unavailable')
missingHook.render({ enabled: false })
await missing.tick(60000); await missing.tick(300000)
assert.equal(missing.requests.length, 1, '插件未安装且已关闭时不反复请求空路由')
missing.dispose()

// 账号标识与来源隔离;相同label不当作同一账号,列表重排保持选择。
const gateway = await environment()
const account = (id, percent, empty = false) => ({ id, label: 'Shared label', provider: 'codex', windows: empty ? [] : [{ id: 'weekly', label: 'window-' + id, percent }], credits: null })
const a = account('a', 10), b = account('b', 20), blank = account('blank', 0, true)
let sourceDef = { id: 'source-a', label: 'Gateway A' }, accounts = [a, b, blank], refreshes = 0
const gatewayProps = (wide = true) => ({ source: sourceDef, snapshot: { accounts, fetchedAt: 0 }, state: { config }, wide,
  api: { refreshGatewayQuota: async () => { refreshes++ } } })
const card = gateway.mount(gateway.ui.GatewayQuotaBox, gatewayProps())
const switcher = () => nodes(card.tree).find(node => node.props.className === 'cm-gw-switcher')
const invokeSwitch = async key => {
  let stopped = false, prevented = false
  const event = { ...(key ? { key } : {}), stopPropagation() { stopped = true }, preventDefault() { prevented = true } }
  const target = switcher()
  assert.ok(target)
  target.props[key ? 'onKeyDown' : 'onClick'](event)
  // 模拟冒泡,能证明按钮处理不会触发外层刷新。
  if (!stopped) nodes(card.tree).find(node => node.props.className?.includes('clickable'))?.props[key ? 'onKeyDown' : 'onClick']?.(event)
  await gateway.flush()
  return { stopped, prevented }
}
assert.match(textOf(card.tree), /window-a/)
await invokeSwitch()
assert.match(textOf(card.tree), /window-b/)
assert.equal(gateway.storage.get('cm.gw.source-a'), 'b', '同名账号按id保存')
accounts = [b, blank, a]
card.render(gatewayProps())
assert.match(textOf(card.tree), /window-b/, '列表重排后保留已选账号')
assert.match(textOf(switcher()), /1\/3/)
await invokeSwitch()
assert.equal(gateway.storage.get('cm.gw.source-a'), 'blank')
assert.ok(switcher(), '空额度账号仍可切换离开')
assert.match(textOf(card.tree), /—/)
await invokeSwitch()
assert.match(textOf(card.tree), /window-a/)
gateway.storage.set('cm.gw.source-b', 'b')
sourceDef = { id: 'source-b', label: 'Gateway B' }
accounts = [a, b]
card.render(gatewayProps())
assert.match(textOf(card.tree), /window-b/, '切来源读取来源自己的账号选择')
card.render(gatewayProps(false))
assert.equal(switcher().props.role, 'button')
assert.equal(switcher().props.tabIndex, 0)
assert.deepEqual(await invokeSwitch('Enter'), { stopped: true, prevented: true })
assert.equal(gateway.storage.get('cm.gw.source-b'), 'a')
assert.deepEqual(await invokeSwitch(' '), { stopped: true, prevented: true })
assert.equal(gateway.storage.get('cm.gw.source-b'), 'b')
assert.equal(refreshes, 0, '鼠标/Enter/Space切账号均不触发外层额度刷新')
assert.equal(gateway.storage.get('cm.gw.source-a'), 'a', '切换来源不覆盖其他来源的选择')
card.dispose(); gateway.dispose()

// 同一官方价经过 RPC parser、客户端规范化与计费后,缓存写和长上下文边界与服务器一致。
const astra = DEFAULT_PROVIDER_PRICE_TABLE.openai.models['gpt-6-astra']
const serverPrice = normalizePrice(astra)
const clientRawPrice = e.ui.normalizeClientPrice(astra)
const clientRpcPrice = e.ui.parsePrice(serverPrice, 'prices.models.gpt-6-astra')
const at = Date.parse('2026-09-11T06:00:00Z')
for (const price of [clientRawPrice, clientRpcPrice, e.ui.normalizeClientPrice(clientRpcPrice)]) {
  assert.equal(price.cacheWrite, 12.5)
  assert.equal(price.longContext.cacheWrite, 25)
  assert.equal(price.longContext.aboveInputTokens, 272000)
  for (const buckets of [{ input: 272000, output: 1000 }, { input: 272001, output: 1000 },
    { cacheRead: 272000, cacheWrite: 1 }, { input: 100000, cacheRead: 100000, cacheWrite: 72000, output: 1000 },
    { input: 100000, cacheRead: 100000, cacheWrite: 72001, output: 1000 }, { cacheWrite: 1000 }, { input: 1, output: 1000000 }]) {
    const expected = costOf(buckets, serverPrice, at, { enabled: false })
    const actual = e.ui.costOfBuckets(buckets, e.ui.tierFor(price, at, { enabled: false }))
    assert.ok(Math.abs(actual - expected) < 1e-12, `Astra客户端/服务器计费一致: ${JSON.stringify(buckets)}`)
  }
}
e.dispose()

console.log('✓ 客户端会话聚合竞态、Codex按需查询、网关多账号及Astra计价一致性通过')
