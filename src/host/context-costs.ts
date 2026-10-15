/** Read-only current-context costs. Never writes the session, ledger or prices. */
import { providerPriceEntryFor, tierFor, usdFromCost } from './pricing.js'
import { billingClassOf, enabledPlanSetOf } from './plan-billing.js'
import { replaySessionRecords } from './backfill.js'
import { costFromSamples } from './turn-cost.js'
import type { CostCall } from './turn-cost.js'

/** dsh-context 发布的可选投影(服务边界值,形状由对方保证)。 */
interface ContextProjections {
  /** 官方 system / tools / messages 拆分。 */
  contextBreakdown?: Record<string, any>
  // TODO(types): 收紧为 { systemTokens: number; toolsTokens: number; messageTokens: number }。
  /** 各上下文类别的当前 token 数。 */
  contextTimeline?: { current?: Record<string, number | undefined> }
}

/** 一条会话事件行(快照 / 日志行的形状子集)。 */
interface SessionEventRow {
  type?: string
  seq?: number
  data?: any
  // TODO(types): data 为宿主会话日志的任意 JSON payload,待 backfill 侧给出事件类型后收敛。
}

export const CONTEXT_PARTS = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool', 'other']
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const zeroParts = () => Object.fromEntries(CONTEXT_PARTS.map(key => [key, 0]))
const sourceName = source => typeof source === 'string' ? source : source?.type ?? source?.kind ?? ''

// The client checks the active peer registrations and required slot APIs.
// Release numbers are informational: compatible interfaces may survive upgrades.
export async function getContextIntegration(ctx) {
  try {
    const manager = ctx.get('pluginManager')
    if (typeof manager?.listBundles !== 'function') return { version: '', compatible: false, reason: 'unavailable' }
    const bundles = await manager.listBundles()
    const peer = bundles.find(row => row.name === 'dsh-context' && row.enabled && !row.error)
    if (!peer) return { version: '', compatible: false, reason: 'missing' }
    const version = typeof peer.version === 'string' ? peer.version : ''
    return { version, compatible: true, reason: 'ready' }
  } catch { return { version: '', compatible: false, reason: 'unavailable' } }
}

/** Keep the total anchored to the host meter; composition remains an estimate. */
export function allocateContext(parts: Record<string, number>, target: number) {
  const total = Object.values(parts).reduce((sum, value) => sum + value, 0)
  if (!total) return CONTEXT_PARTS.map(key => ({ key, tokens: key === 'other' ? target : 0 }))
  return CONTEXT_PARTS.map(key => ({ key, tokens: target * parts[key] / total }))
}

export function contextParts(measurement, records, projections: ContextProjections = {}) {
  const parts = zeroParts(), official = projections.contextBreakdown, partner = projections.contextTimeline?.current
  const linked = partner && CONTEXT_PARTS.slice(0, 7).every(key => key === 'skill' && partner[key] === undefined || count(partner[key]))
  if (linked) {
    for (const key of CONTEXT_PARTS.slice(0, 7)) parts[key] = partner[key] ?? 0
  } else {
    const bySeq = new Map<number, SessionEventRow>(records.map(row => [row.seq, row]))
    let system: { raw: number } | null = null
    for (const node of measurement.nodes) {
      const record = bySeq.get(node.seq), raw = node.heuristicTokens ?? node.tokens
      let category = 'other'
      if (record?.type === 'system/message') { category = 'inject'; if (raw > 0) system = { raw } }
      else if (record?.type === 'developer/message') category = 'inject'
      else if (record?.type === 'assistant/message') category = 'assistant'
      else if (record?.type === 'tool/result') category = 'tool'
      else if (record?.type === 'user/message') {
        const source = sourceName(record.data?.source ?? record.data?.message?.source)
        category = !source || ['human', 'user', 'input'].includes(source) ? 'user' : source.includes('skill') ? 'skill' : 'inject'
      }
      parts[category] += raw
    }
    if (system) { parts.system = system.raw; parts.inject -= system.raw }
  }
  // Use the same official system/tools/messages split that dsh-context displays.
  if (official && ['systemTokens', 'toolsTokens', 'messageTokens'].every(key => count(official[key]))) {
    parts.system = official.systemTokens; parts.tools = official.toolsTokens
    const messages = CONTEXT_PARTS.slice(2), sum = messages.reduce((n, key) => n + parts[key], 0)
    for (const key of messages) parts[key] = sum ? parts[key] / sum * official.messageTokens : key === 'other' ? official.messageTokens : 0
  } else if (!linked) {
    // Without a composition projection, do not label anchor error as tool schemas.
    parts.other += Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
  }
  return { components: allocateContext(parts, measurement.totalTokens), linked: !!linked }
}

function ratesFor(tier, currency, exchangeRate) {
  return Object.fromEntries([['input', 'cacheMiss'], ['cacheRead', 'cacheHit'], ['cacheWrite', 'cacheWrite'], ['output', 'output'], ['reasoning', 'reasoning']]
    .map(([key, price]) => [key, usdFromCost(tier[price] ?? (key === 'cacheWrite' ? tier.cacheHit : 0), currency, exchangeRate)]))
}

export function getContextCosts(ledger, ctx, query, now = Date.now()) {
  const sessionId = query?.sessionId
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('Invalid context costs session')
  const empty = { status: 'unavailable', sessionId, generatedAt: now, revision: 0, provider: '', model: '', basis: 'api', priced: false,
    source: 'none', linked: false, contextTokens: 0, components: [], rates: null, longContext: null, lastCall: null }
  const session = ctx.get('sessions')?.get?.(sessionId), meter = ctx.get('tokenMeter')
  if (!session) return { ...empty, status: 'session-unavailable' }
  if (typeof meter?.measure !== 'function') return { ...empty, status: 'meter-unavailable' }
  const measurement = meter.measure(session)
  if (!count(measurement?.totalTokens) || !count(measurement.surfaceTokens) || !Array.isArray(measurement.nodes)
    || !measurement.nodes.every(node => count(node.tokens) && (node.heuristicTokens === undefined || count(node.heuristicTokens)))) return empty
  const records = session.snapshotEvents(), header = session.requestHeader?.() ?? records.filter(row => row.type === 'request/header').at(-1)?.data?.header
  const provider = header?.config?.provider, model = header?.config?.model
  if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return { ...empty, status: 'route-unavailable' }
  let projections = {}
  // Only consume published scalar projections; never depend on dsh-context internals.
  try { projections = ctx.get('sessionProjections')?.snapshot?.(session, ['contextBreakdown', 'contextTimeline'])?.values ?? {} } catch { /* optional projection service may be replacing a generation */ }
  const config = ledger.config
  const resolved = providerPriceEntryFor(provider, model, config.prices, { mode: config.priceMatch, overrides: config.priceOverrides })
  const tier = tierFor(resolved.entry, now, { enabled: ['deepseek-peak', 'utc-peak'].includes(resolved.billingMode) && config.peakEnabled,
    effectiveAtMs: Date.parse(config.peakEffectiveAt ?? ''), windows: config.peakWindows, holidays: config.peakHolidays })
  // Actual reported usage has a separate face. Never allocate its cache hits
  // to individual context categories: providers do not report that attribution.
  let lastCall: CostCall | null = null, routeHeader: SessionEventRow | null = null, sampleRecords: SessionEventRow[] | null = null
  for (const row of records) {
    if (row.type === 'request/header') routeHeader = row
    if (row.type !== 'assistant/message' || !routeHeader) continue
    const usage = row.data?.usage
    if (usage && ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => count(usage[key + 'Tokens']))) {
      sampleRecords = [routeHeader, row]
    }
  }
  if (sampleRecords) lastCall = costFromSamples(replaySessionRecords(sampleRecords, config, null, true).samples, config).calls.at(-1) ?? null
  return { ...empty, status: 'ready', revision: measurement.logRevision ?? records.length, provider, model,
    basis: billingClassOf(provider, model, config.planBilling, enabledPlanSetOf(config), config.prices) === 'plan' ? 'plan' : 'api',
    priced: resolved.priced, source: measurement.baseline?.kind === 'usage' ? 'usage' : 'estimate', contextTokens: measurement.totalTokens,
    ...contextParts(measurement, records, projections), lastCall,
    rates: resolved.priced ? ratesFor(tier, resolved.currency, config.exchangeRate) : null,
    longContext: resolved.priced && tier.longContext ? { aboveInputTokens: tier.longContext.aboveInputTokens, ...ratesFor(tier.longContext, resolved.currency, config.exchangeRate) } : null }
}
