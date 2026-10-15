import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { sanitizeConfig } from '../lib/store.js'

/**
 * 现场打包客户端模块并取回导出。
 *
 * 旧 `src/client/*.js` 拼接片段已删,测试不再拼接源码;这里把与 `lib/` 产物同源的
 * `src/client/*.ts` 打成临时 CJS(平台种子保持 external,由调用方注入桩;`globals`
 * 用于替换 Date 这类全局,等价于旧 `vm.runInNewContext` 的上下文注入)后 require。
 */
async function clientExports(entry, seeds = {}, globals = {}) {
  const result = await build({
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const names = Object.keys(globals)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...names, result.outputFiles[0].text)(
    id => { if (id in seeds) return seeds[id]; throw new Error('missing seed module: ' + id) },
    module, module.exports, ...names.map(name => globals[name]))
  return module.exports
}

const now = Date.parse('2026-09-10T07:00:00Z')
class Clock extends Date { static now() { return now } }
const el = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = { createElement: el, Fragment: 'fragment', useRef: value => ({ current: value }), useEffect() {}, useState: value => [typeof value === 'function' ? value() : value, () => {}] }
const ui = await clientExports(`
  export { SidebarFooter, BudgetBoxContent } from './ui-sidebar.js'
  export { BalanceBox, BalanceRowContent } from './ui-balance.js'
  export { codexQuotaCache } from './ui-quota.js'
`, { react: React, '@deepseek-ai/dsh-client-ui-primitives': { Tooltip: 'tooltip' } }, { Date: Clock })
const render = n => Array.isArray(n) ? n.map(render) : n && typeof n === 'object'
  ? typeof n.type === 'function' ? render(n.type(n.props)) : { ...n, children: n.children.map(render) } : n
const nodes = n => Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...nodes(n.children)] : []
const text = n => Array.isArray(n) ? n.map(text).join('') : n && typeof n === 'object' ? text(n.children) : n == null ? '' : String(n)
const hasClass = (n, cls) => n.props.className?.split(' ').includes(cls)
ui.codexQuotaCache.status = 'off'
const totals = cost => ({ cost, apiCost: cost, calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })
const state = { today: totals(1 / 7.2), month: totals(8 / 7.2), total: totals(9 / 7.2), budgetUsed: 8 / 7.2,
  balance: { status: 'ok', totalBalance: 47.68, grantedBalance: 0, toppedUpBalance: 47.68, currency: 'CNY', fetchedAt: now },
  codingPlans: {}, gatewayQuotas: { sources: [] }, goQuota: { status: 'ok', rolling: { percent: 20 }, weekly: { percent: 40 }, monthly: { percent: 60 }, fetchedAt: now } }

let combinations = 0
for (const sidebarSimple of [false, true]) for (const wide of [false, true]) for (const budget of [false, true])
for (const hideTodayCost of [false, true]) for (const peakEnabled of [false, true]) for (const peakNotice of [false, true])
for (const peakStyle of ['compact', 'classic', 'dynamic']) for (const go of [false, true]) {
  state.config = sanitizeConfig({ sidebarSimple, hideTodayCost, peakEnabled, peakNotice, peakStyle,
    balance: { display: 'sidebar', showProgressBar: true }, budget: { enabled: budget, amount: 10 }, goQuota: { enabled: go, display: 'sidebar' } })
  const tree = render(ui.SidebarFooter({ wide, useCost: pick => pick({ state }) }))
  const peakClasses = ['cm-peak-strip', 'cm-peak-classic', 'cm-peak-rail', 'cm-peak-rail-classic']
  const strips = nodes(tree).filter(n => peakClasses.some(cls => hasClass(n, cls)))
  const expected = peakEnabled && peakNotice && (!wide || budget || !hideTodayCost) ? 1 : 0
  assert.equal(strips.length, expected, JSON.stringify({ sidebarSimple, wide, budget, hideTodayCost, peakEnabled, peakNotice, peakStyle, go }))
  // dynamic 样式的渲染在按需分块里:未注入加载器时退回简洁样式(本测试不注入),
  // classic/compact 维持各自类名,避免懒加载接线把既有样式带偏。
  if (expected) {
    const shape = wide
      ? peakStyle === 'classic' ? 'cm-peak-classic' : 'cm-peak-strip'
      : peakStyle === 'classic' ? 'cm-peak-rail-classic' : 'cm-peak-rail'
    assert.ok(hasClass(strips[0], shape), JSON.stringify({ peakStyle, wide, expected: shape }))
    assert.ok(!hasClass(strips[0], 'cm-pkw'), '主包不内联动态样式的分段结构')
  }
  const summaries = nodes(tree).filter(n => hasClass(n, 'cm-simple-summary'))
  assert.equal(summaries.length, sidebarSimple && wide && !hideTodayCost ? 1 : 0)
  if (sidebarSimple && wide && budget && !hideTodayCost) {
    assert.match(text(summaries[0]), /今日 \/ 本月预算.*¥1 \/ ¥10/)
    assert.ok(hasClass(summaries[0], 'warn'), '按本月已用 80% 预警，不能按今日 10% 降级')
    assert.ok(nodes(tree).some(n => n.type === 'tooltip' && String(n.props.label).includes('80.0%')))
  }
  combinations++
}

for (const [period, label, used] of [['day', '今日', 1], ['month', '本月', 8], ['all', '累计', 9], ['custom', '自定义区间', 5]]) {
  state.config = sanitizeConfig({ locale: 'zh', sidebarSimple: true, budget: { enabled: true, amount: 10, period, customStart: '2026-09-01', customEnd: '2026-09-10' } })
  state.budgetUsed = used / 7.2
  const tree = render(ui.BudgetBoxContent({ state, wide: true, summary: true }))
  assert.match(text(tree), new RegExp(`今日 / ${label}预算`))
  assert.match(String(tree.props.label), new RegExp(`已用 ¥${used} / ¥10`))
}
let stopped = 0
const box = render(ui.BalanceBox({ state, wide: true }))
const link = nodes(box).find(n => n.type === 'a')
assert.equal(link.props.href, 'https://platform.deepseek.com/usage')
assert.equal(link.props.target, '_blank')
assert.ok(nodes(link).some(n => n.type === 'svg'), '充值链接使用矢量图标且保留无障碍名称')
assert.ok(link.props['aria-label'])
link.props.onClick({ stopPropagation: () => { stopped++ } })
link.props.onKeyDown({ stopPropagation: () => { stopped++ } })
assert.equal(stopped, 2, '充值链接不触发外层余额刷新')
console.log(`[ok] #122/#123：${combinations} 种组合的峰谷条唯一性、隐藏项、预算周期/合并口径及充值图标交互`)
