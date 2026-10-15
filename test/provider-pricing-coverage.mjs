import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { DEFAULT_PROVIDER_PRICE_TABLE, normalizePrice, providerPriceEntryFor, buildPriceCatalog, tierFor, costOf, upgradeProviderPriceDefaults } from '../lib/pricing.js'
import { VERIFIED_PROVIDER_PRICES } from '../lib/provider-prices.js'
import { billingClassOf, enabledPlanSetOf, planProviderIdOf } from '../lib/plan-billing.js'
import { defaultConfig, sanitizeConfig, applyConfigPatch, Ledger, zeroDay } from '../lib/store.js'
import { stateSchema } from '../lib/typert.host.js'

/**
 * 现场打包客户端模块并取回导出。
 *
 * 旧 `src/client/*.js` 拼接片段已删,测试不再拼接源码;这里把与 `lib/` 产物同源的
 * `src/client/*.ts` 打成临时 CJS(平台种子保持 external,由调用方注入桩)后 require,
 * 取同一实现。NodeNext 的 `.js` 后缀导入也只有打包器能解析。
 */
async function clientExports(entry, seeds = {}) {
  const result = await build({
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    id => { if (id in seeds) return seeds[id]; throw new Error('missing seed module: ' + id) }, module, module.exports)
  return module.exports
}

const config = defaultConfig()
assert.equal(planProviderIdOf('zen'), 'go', 'legacy host routing kept')
assert.equal(planProviderIdOf('opencode'), 'go', 'legacy host routing kept')
assert.equal(planProviderIdOf('opencode-zen'), null, 'explicit PAYG route')
assert.equal(billingClassOf('opencode-zen', 'gpt-6.1-sol', config.planBilling, new Set(['go']), config.prices), 'api')
assert.equal(billingClassOf('opencode-zen', 'gpt-6.1-sol', { ...config.planBilling, models: { 'opencode-zen:gpt-6.1-sol': 'plan' } }, new Set(), config.prices), 'plan', 'manual override remains authoritative')
assert.equal(billingClassOf('deepseek', 'qwen3.8-flash', config.planBilling, new Set(['go']), config.prices), 'api', 'catalog additions never infer a new subscription')

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
const modelsOf = p => VERIFIED_PROVIDER_PRICES[p].models
assert.equal(Object.keys(modelsOf('opencode-zen')).length, 83, 'all 83 published Zen endpoints covered')
assert.equal(Object.keys(modelsOf('opencode-go')).length, 30, 'all 30 published Go endpoints covered')
const shipped = JSON.parse(readFileSync(new URL('../docs/provider-pricing.json', import.meta.url)))
assert.deepEqual(shipped.providers, DEFAULT_PROVIDER_PRICE_TABLE, 'shipped catalog and executable prices agree')
for (const [provider, table] of Object.entries(VERIFIED_PROVIDER_PRICES)) {
  for (const [id, raw] of Object.entries(table.models)) {
    const normalized = normalizePrice(raw)
    assert.ok(normalized, `${provider}:${id} has a valid catalog row`)
    assert.equal(providerPriceEntryFor(provider, id, config.prices, { mode: 'exact' }).priced, raw.unpriced !== true, `${provider}:${id} exact mounted price`)
    assert.match(raw.sourceUrl, /^https:\/\//)
    assert.equal(raw.checkedAt, '2026-10-03')
    if (raw.unpriced !== true) for (const value of [normalized.cacheHit, normalized.cacheMiss, normalized.output]) assert.ok(Number.isFinite(value) && value >= 0)
  }
}
const catalog = buildPriceCatalog()
assert.ok(Object.values(catalog).flatMap(f => Object.values(f).flatMap(Object.keys)).length >= 206)

// New issue #224 models and official cache-write/full-input context tiers.
const expected = [
  ['openai', 'gpt-6-sol', 2, 0.2, 2.5, 10],
  ['openai', 'gpt-6.1-sol', 2, 0.1, 2.5, 10],
  ['openai', 'gpt-6-luna', 0.1, 0.01, 0.125, 0.5],
  ['anthropic', 'claude-fable-5.1', 10, 0.25, 12.5, 50],
  ['anthropic', 'claude-opus-5.5', 4, 0.2, 5, 20],
  ['anthropic', 'claude-sonnet-5.5', 2, 0.2, 2.5, 10],
]
const now = Date.parse('2026-10-03T02:00:00Z')
for (const [provider, id, input, read, write, output] of expected) {
  const result = providerPriceEntryFor(provider, id, config.prices)
  assert.equal(result.priced, true, `${provider}:${id}`)
  assert.equal(result.billingMode, 'flat')
  assert.deepEqual([result.entry.cacheMiss, result.entry.cacheHit, result.entry.cacheWrite, result.entry.output], [input, read, write, output])
  near(costOf({ input: 1000, cacheRead: 2000, cacheWrite: 3000, output: 4000 }, result.entry, now), (input + 2*read + 3*write + 4*output)/1000)
}
const sol = providerPriceEntryFor('openai', 'gpt-6.1-sol', config.prices).entry
near(costOf({ input: 100000, cacheRead: 100000, cacheWrite: 72000, output: 1000 }, sol, now), 0.4)
near(costOf({ input: 100000, cacheRead: 100000, cacheWrite: 72001, output: 1000 }, sol, now), 0.795005)
near(costOf({ input: 272000, output: 1000000 }, sol, now), 10.544, 'output does not affect OpenAI input threshold')

// Same model, separate direct/Zen/Go routes; hourly cache storage is not cache writes.
const directGemini = providerPriceEntryFor('google', 'gemini-3.8-flash', config.prices)
const zenGemini = providerPriceEntryFor('opencode-zen', 'google/gemini-3.8-flash', config.prices)
assert.equal(directGemini.entry.cacheMiss, 0.75)
assert.equal(directGemini.entry.output, 3.75)
assert.equal(directGemini.entry.cacheWrite, undefined, 'Gemini storage USD/M/hour is excluded from per-request token prices')
assert.equal(zenGemini.entry.cacheMiss, 1.5)
assert.equal(zenGemini.entry.output, 7.5)
assert.equal(providerPriceEntryFor('opencode-zen', 'deepseek-v4-pro', config.prices).entry.cacheMiss, 1.74)
const go = providerPriceEntryFor('opencode-go', 'deepseek-v4-pro', { ...config.prices, currency: 'CNY' })
assert.equal(go.billingMode, 'utc-peak')
assert.equal(go.currency, 'USD', 'Go reference prices are USD even when direct prices are CNY')
const peak = { enabled: true, effectiveAtMs: 0, holidays: ['2026-10-01'] }
assert.equal(tierFor(go.entry, Date.parse('2026-10-01T02:00:00Z'), peak).cacheMiss, 1.32, 'UTC Go weekday peak ignores direct Beijing holiday discount')
assert.equal(tierFor(go.entry, Date.parse('2026-10-03T02:00:00Z'), peak).cacheMiss, 0.66)
assert.equal(tierFor(go.entry, Date.parse('2026-10-01T04:00:00Z'), peak).cacheMiss, 0.66)
assert.equal(tierFor(go.entry, Date.parse('2026-10-01T02:00:00Z'), { enabled: false }).cacheMiss, 0.66)
assert.equal(providerPriceEntryFor('opencode-zen', 'mimo-v2.6-flash-free', config.prices).priced, true)
assert.equal(providerPriceEntryFor('custom-route', 'mimo-v2.6-flash-free', config.prices).priced, false, 'Zen free offer does not leak to another route')

// Older user-configured rows stay whole while newly missing defaults are mounted.
const manual = { input: 9, output: 90, notes: 'manual no-discount price' }
const stored = sanitizeConfig({ prices: { providers: { openai: { models: { 'gpt-6.1-sol': manual } } } } })
assert.deepEqual(stored.prices.providers.openai.models['gpt-6.1-sol'], manual)
assert.equal(providerPriceEntryFor('openai', 'gpt-6.1-sol', stored.prices).entry.cacheHit, 9)
assert.equal(providerPriceEntryFor('openai', 'gpt-6.1-sol', stored.prices).entry.longContext, undefined)
assert.equal(stored.prices.providers.openai.models['gpt-6-luna'], undefined, 'sanitize does not remount deliberately absent models')
const legacySol = { input: 2, cachedInput: 0.2, output: 10, billingMode: 'flat', sourceUrl: 'https://opencode.ai/docs/zen', checkedAt: '2026-08-25', notes: '≤272K 档;超过 272K 按 $4/$15 计(缓存读 $0.40、写入 $5);缓存写入 $2.50;目录标注 2026-09-18 前为五折促销价(issue #58)' }
const upgrade = { prices: { providers: { openai: { models: { 'gpt-5.6-sol': legacySol, 'gpt-6.1-sol': manual } } } } }
upgradeProviderPriceDefaults(upgrade)
assert.deepEqual(upgrade.prices.providers.openai.models['gpt-6.1-sol'], manual)
for (const value of [{ prices: 1 }, { prices: { providers: [] } }, null]) assert.doesNotThrow(() => upgradeProviderPriceDefaults(value))
const ttl = { input: 5, cachedInput: 0.5, output: 25, billingMode: 'flat', sourceUrl: 'https://opencode.ai/docs/zen', checkedAt: '2026-08-17', notes: '缓存写入 $6.25', cacheCreation1h: 99 }
const customized = { prices: { providers: { anthropic: { models: { 'claude-opus-4-8': ttl } } } } }
upgradeProviderPriceDefaults(customized)
assert.deepEqual(customized.prices.providers.anthropic.models['claude-opus-4-8'], ttl, 'schema-supported custom TTL fields are not discarded by normalized equality')
const patched = applyConfigPatch(config, { prices: { providers: { 'opencode-go': { models: modelsOf('opencode-go') } } } })
assert.deepEqual(patched.errors, [])
stateSchema.shape.config.parse(patched.config)
const path = mkdtempSync(join(tmpdir(), 'cm-pricing-coverage-'))
try {
  const ledgerPath = join(path, 'ledger.json')
  const ledger = new Ledger(stored, {}, ledgerPath)
  ledger.scheduleWrite(); ledger.flush(); ledger.close()
  const reopened = Ledger.load(ledgerPath)
  assert.deepEqual(reopened.config.prices.providers.openai.models['gpt-6.1-sol'], manual)
  assert.ok(reopened.config.prices.providers.openai.models['gpt-6-luna'], 'one-time upgrade adds new IDs to old ledgers')
  assert.equal(reopened.config.prices.providers.openai.models['gpt-5.6-sol'], undefined, 'old unmounted ID is not restored')
  delete reopened.config.prices.providers.openai.models['gpt-6-luna']
  reopened.config.prices.providers.google.models['gemini-3.8-flash'] = { unpriced: true, notes: 'disabled' }
  reopened.scheduleWrite(); reopened.flush(); reopened.close()
  const twice = Ledger.load(ledgerPath)
  assert.equal(twice.config.prices.providers.openai.models['gpt-6-luna'], undefined, 'unmount survives reload after catalog migration')
  assert.deepEqual(twice.config.prices.providers.google.models['gemini-3.8-flash'], { unpriced: true, notes: 'disabled' })
  twice.close()
} finally { rmSync(path, { recursive: true, force: true }) }

// Exercise emitted browser codecs and token arithmetic, including the separate UTC calendar.
const client = await clientExports(`export { resolveClientPrice, normalizeClientPrice, tierFor, costOfBuckets, parseState } from './logic.js'`)
// logic.ts 未导出 parseConfig(它是 parseState 的内部实现):经 parseState 走同一函数。
const parseClientConfig = source => client.parseState({ today: zeroDay('2026-10-03'), month: zeroDay('2026-10-03'), total: zeroDay('2026-10-03'), config: source }, 'state').config
for (const [provider, id] of expected) {
  const back = providerPriceEntryFor(provider, id, config.prices)
  const front = client.resolveClientPrice(provider, id, config)
  assert.equal(front.priced, back.priced)
  near(client.costOfBuckets({ input: 1000, cacheRead: 2000, cacheWrite: 3000, output: 4000 }, client.tierFor(client.normalizeClientPrice(front.entry), now, { enabled: false })), costOf({ input: 1000, cacheRead: 2000, cacheWrite: 3000, output: 4000 }, back.entry, now))
}
const parsedConfig = parseClientConfig(JSON.parse(JSON.stringify(config)))
const frontGo = client.resolveClientPrice('opencode-go', 'deepseek-v4-pro', { ...parsedConfig, prices: { ...parsedConfig.prices, currency: 'CNY' } })
assert.equal(frontGo.currency, 'USD')
assert.equal(frontGo.billingMode, 'utc-peak')
assert.equal(client.tierFor(client.normalizeClientPrice(frontGo.entry), Date.parse('2026-10-01T02:00:00Z'), peak).cacheMiss, 1.32)
console.log('[ok] #224 provider catalogs: complete Zen/Go coverage, verified new API rates, cache/context tiers, scoped prices, UTC Go calendar, codecs and manual-price persistence')

const sourceAudit = spawnSync(process.execPath, [fileURLToPath(new URL('./check-opencode-catalog.mjs', import.meta.url)), '--fixture=' + fileURLToPath(new URL('./fixtures/opencode-pricing-2026-10-03.json', import.meta.url))], { encoding: 'utf8' })
assert.equal(sourceAudit.status, 0, sourceAudit.stdout + sourceAudit.stderr)
console.log(sourceAudit.stdout.trim())
