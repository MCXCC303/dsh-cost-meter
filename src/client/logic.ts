import { MODEL_SIDEBAR_DEFAULTS } from './constants.js'
/**
 * 客户端共享逻辑层:服务端数据校验/codec、客户端计价、格式化、轻量 store。
 *
 * 这些是纯逻辑(除 makeStore 外不碰 React),被各 UI 模块与按需分块共用。
 * 迁移自原 02-validators-helpers-sidebar 片段的前 1213 行。
 */
import { LEGACY_BASE_BOUNDARY_MS, isPeakHour } from './peak-core.js'
import { PERIOD_KEYS, supportedLocale } from './t.js'

// 峰谷纯计算(相位/谷价区间/倒计时)已拆到 ./peak-core.js;此处原样转出,
// 既有引用(峰谷条、设置页预览、测试)仍可从 './logic.js' 取用。
export {
  WEEKEND_OFFPEAK_EFFECTIVE_MS, weekendZoneAt, holidayZoneAt, offPeakZoneAt, isPeakHour,
  LEGACY_BASE_BOUNDARY_MS, peakPhaseAt, peakView, phaseLabelKeys, countdownText,
} from './peak-core.js'

/** 线路上行/快照数据的宽松记录类型:宿主侧 zod 清单已校验必要字段,客户端解析器只做字段级守卫。 */
type JsonRecord = Record<string, any>
// TODO(types): 按 codec 逐步收紧为具体接口(PriceEntry / PlanStats / UsageBucket 等),
// 用线路类型替换上面的宽松记录;目前仅覆盖动态取键的边界解析。

// ── 线路校验器(与服务端 zod 清单对应,宽松校验必要字段) ─────────────────

export function fail(path, expect): never {
  throw new Error('dsh-cost-meter: 服务端数据非法 (' + path + ': ' + expect + ')')
}
export function needObject(v, path) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'object')
  return v
}
export function needNum(v, path) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'number')
  return v
}
export function needStr(v, path) {
  if (typeof v !== 'string') fail(path, 'string')
  return v
}
export const oneOf = (v, list, fallback) => (typeof v === 'string' && list.includes(v) ? v : fallback)
export function parseBillingClasses(v, model = false) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  // 值来自线路快照(宿主 zod 清单已校验):断言为字符串元组,只按字符串集合过滤;
  // 非字符串值在原实现里同样不可能命中 includes,行为不变。
  return Object.fromEntries((Object.entries(v) as Array<[string, string]>).filter(([key, value]) => model ? key.length > 0 && ['plan', 'api'].includes(value) : ['auto', 'plan', 'api'].includes(value)))
}
export function needBool(v, path) {
  if (typeof v !== 'boolean') fail(path, 'boolean')
  return v
}
export const mapFields = (value, keys, parse) => Object.fromEntries(keys.map(key => [key, parse(value[key])]))
export function aggregateModelMap(v, path) {
  // 宽容解析模型聚合 map(旧账本条目可能缺字段/带 null/非对象):数值归一为有限非负数。
  const out = {}
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const key of Object.keys(v)) {
      const raw = v[key]
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
      out[key] = {
        ...mapFields(raw, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost'], num),
        // API 渠道金额(issue #64):缺席 = 旧数据按 cost 全额 API 口径。
        apiCost: raw.apiCost === undefined ? num(raw.cost) : num(raw.apiCost),
      }
    }
  }
  return out
}
export function parseUsageFields(v, path) {
  needObject(v, path)
  const out = {
    reasoning: v.reasoning === undefined ? 0 : needNum(v.reasoning, path + '.reasoning'),
    apiCost: v.apiCost === undefined ? undefined : needNum(v.apiCost, path + '.apiCost'),
    byModel: aggregateModelMap(v.byModel, path + '.byModel'),
    byProviderModel: aggregateModelMap(v.byProviderModel, path + '.byProviderModel'),
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'cost']) out[key] = needNum(v[key], path + '.' + key)
  return out
}
export function parseTurnRows(rows) {
  return (Array.isArray(rows) ? rows : fail('rows', 'array')).map(r => ({ provider: needStr(r.provider, 'provider'), model: needStr(r.model, 'model'), bucket: needStr(r.bucket, 'bucket'), tokens: needNum(r.tokens, 'tokens'), rate: needNum(r.rate, 'rate'), cost: needNum(r.cost, 'cost'), priced: needBool(r.priced, 'priced'), plan: needBool(r.plan, 'plan') }))
}
export function parseSession(v, path) {
  return {
    ...parseUsageFields(v, path),
    id: needStr(v.id, path + '.id'),
    provider: typeof v.provider === 'string' ? v.provider : '',
    model: typeof v.model === 'string' ? v.model : '',
  }
}
export function parseDay(v, path) {
  const out = {
    ...parseUsageFields(v, path),
    date: needStr(v.date, path + '.date'),
    sessions: [],
  }
  if (v.sessions !== undefined) {
    if (!Array.isArray(v.sessions)) fail(path + '.sessions', 'array')
    out.sessions = v.sessions.map((s, i) => parseSession(s, path + '.sessions[' + i + ']'))
  }
  return out
}
export function parsePriceTier(v, path, optional = ['cacheWrite', 'reasoning']) {
  const out: JsonRecord = {}
  for (const key of ['cacheHit', 'cacheMiss', 'output']) out[key] = needNum(v[key], path + '.' + key)
  for (const key of optional) if (v[key] !== undefined) out[key] = needNum(v[key], path + '.' + key)
  return out
}
export function parsePrice(v, path) {
  needObject(v, path)
  const out = parsePriceTier(v, path)
  for (const key of ['offPeak', 'peak', 'legacyBase', 'longContext']) {
    if (v[key] === undefined) continue
    out[key] = parsePriceTier(v[key], path + '.' + key, ['cacheWrite', 'reasoning', 'aboveInputTokens'])
  }
  if (v.cny !== undefined) out.cny = parsePriceTier(v.cny, path + '.cny')
  if (v.legacy !== undefined) out.legacy = needBool(v.legacy, path + '.legacy')
  if (v.rateHistory !== undefined) {
    if (!Array.isArray(v.rateHistory) || v.rateHistory.length > 16) fail(path + '.rateHistory', 'price history')
    out.rateHistory = v.rateHistory.map((period, i) => {
      if (!period || typeof period.before !== 'string' || !Number.isFinite(Date.parse(period.before))) fail(path + '.rateHistory', 'dated price')
      return { ...parsePrice({ ...period, rateHistory: undefined }, path + '.rateHistory.' + i), before: period.before }
    })
  }
  for (const key of ['billingMode', 'sourceUrl', 'checkedAt', 'notes']) if (typeof v[key] === 'string') out[key] = v[key]
  return out
}
function parseConfig(v, path) {
const parseCustomEntry = e => (e == null ? undefined : {
  ...(e.adapter === 'aliyun' ? { adapter: 'aliyun' } : {}),
  enabled: e.enabled === true,
  label: typeof e.label === 'string' ? e.label : '',
  labelEn: typeof e.labelEn === 'string' ? e.labelEn : '',
  display: oneOf(e.display, ['sidebar', 'settings', 'off'], 'both'),
  unit: ['CNY', 'EUR', 'CREDITS'].includes(e.unit) ? e.unit : 'USD',
  convertToDisplayCurrency: e.convertToDisplayCurrency === true,
  refreshMinutes: typeof e.refreshMinutes === 'number' && Number.isFinite(e.refreshMinutes) ? e.refreshMinutes : 15,
  request: e.request && typeof e.request === 'object' ? e.request : { url: '' },
  extract: e.extract && typeof e.extract === 'object' ? e.extract : {},
  allowedHosts: Array.isArray(e?.allowedHosts) ? e.allowedHosts.filter(h => typeof h === 'string') : [],
})
  needObject(v, path)
  const models = {}
  if (v.prices !== null && typeof v.prices === 'object' && v.prices.models !== null && typeof v.prices.models === 'object') {
    for (const id of Object.keys(v.prices.models)) models[id] = parsePrice(v.prices.models[id], path + '.prices.models.' + id)
  }
  return {
    locale: v.locale === 'zh' || v.locale === 'en' || v.locale === 'auto' ? v.locale : 'auto',
    position: v.position === 'header' || v.position === 'off' ? v.position : 'dock',
    sidebar: v.sidebar !== false,
    // showSessionId 曾遗漏于本白名单:checkbox 能保存但读侧恒 undefined,
    // 会话列表附显 ID 自上线以来实际从未生效(v1.5.38 起一并修复)。
    showSessionId: v.showSessionId === true,
    hideOfficialBalance: v.hideOfficialBalance === true,
    hideTodayCost: v.hideTodayCost === true,
    ...mapFields(v, ['hideSessionCostHeader', 'hideSessionCostDock', 'hideTurnCost'], value => value === true),
    sessionCostCompact: v.sessionCostCompact === true,
    contextCostsEnabled: v.contextCostsEnabled === true,
    contextCostsPromptSeen: v.contextCostsPromptSeen === true,
    sidebarTodayMetric: v.sidebarTodayMetric === 'tokens' ? 'tokens' : 'cost',
    statisticsBasis: v.statisticsBasis,
    showTotalWithPlan: v.showTotalWithPlan === true,
    sidebarSimple: v.sidebarSimple === true,
    sidebarSimplePromptSeen: v.sidebarSimplePromptSeen === true,
    sidebarModels: Object.fromEntries(Object.entries(MODEL_SIDEBAR_DEFAULTS).map(([k, v0]) => [k, v.sidebarModels?.[k] ?? v0])),
    codexQuotaEnabled: v.codexQuotaEnabled === true,
    codexQuotaSidebar: v.codexQuotaSidebar !== false,
    includeSubagentCost: v.includeSubagentCost === true,
    sidebarStyle: v.sidebarStyle === 'compact' ? 'compact' : 'standard',
    priceMatchDismissed: Array.isArray(v.priceMatchDismissed) ? v.priceMatchDismissed.filter(key => typeof key === 'string') : [],
    // 官方价格币种(issue #47):读侧白名单缺失会导致下拉选择保存后读不回。
    pricingCurrency: v.pricingCurrency === 'CNY' ? 'CNY' : 'USD',
    currency: typeof v.currency === 'string' ? v.currency : 'CNY',
    symbol: typeof v.symbol === 'string' ? v.symbol : '¥',
    decimals: needNum(v.decimals, path + '.decimals'),
    exchangeRate: needNum(v.exchangeRate, path + '.exchangeRate'),
    peakEnabled: v.peakEnabled === true,
    peakEffectiveAt: typeof v.peakEffectiveAt === 'string' ? v.peakEffectiveAt : '',
    peakWindows: Array.isArray(v.peakWindows)
      ? v.peakWindows.map((w, i) => ({ start: needNum(w.start, path + '.peakWindows[' + i + '].start'), end: needNum(w.end, path + '.peakWindows[' + i + '].end') }))
      : [],
    peakHolidays: Array.isArray(v.peakHolidays) ? v.peakHolidays.filter(date => typeof date === 'string') : [],
    peakNotice: v.peakNotice !== false,
    peakAlertEnabled: v.peakAlertEnabled !== false,
    peakAlertAhead: Number.isFinite(v.peakAlertAhead) && v.peakAlertAhead >= 1 && v.peakAlertAhead <= 30 ? v.peakAlertAhead : 2,
    peakAlertTarget: v.peakAlertTarget === 'peak' || v.peakAlertTarget === 'offpeak' ? v.peakAlertTarget : 'both',
    peakAlertPosition: v.peakAlertPosition === 'center' ? 'center' : 'corner',
    peakAlertWebNotify: v.peakAlertWebNotify === true,
    peakStyle: v.peakStyle === 'classic' ? 'classic' : 'compact',
    priceMatch: v.priceMatch === 'exact' ? 'exact' : 'auto',
    priceOverrides: (() => {
      const out = {}
      if (v.priceOverrides !== null && typeof v.priceOverrides === 'object' && !Array.isArray(v.priceOverrides)) {
        for (const [k, val] of Object.entries(v.priceOverrides)) if (typeof k === 'string' && typeof val === 'string') out[k] = val
      }
      return out
    })(),
    priceTableDisplay: (() => {
      // 键 'provider:modelId',缺省 = DeepSeek 模型直接显示、第三方收入拓展表。
      const out = {}
      if (v.priceTableDisplay !== null && typeof v.priceTableDisplay === 'object' && !Array.isArray(v.priceTableDisplay)) {
        for (const [k, val] of Object.entries(v.priceTableDisplay)) if (typeof k === 'string') out[k] = val === true
      }
      return out
    })(),
    codingPlans: (() => {
      const out = {}
      if (v.codingPlans !== null && typeof v.codingPlans === 'object' && !Array.isArray(v.codingPlans)) {
        for (const id of Object.keys(v.codingPlans)) {
          const e = v.codingPlans[id]
          if (e === null || typeof e !== 'object' || Array.isArray(e)) continue
          out[id] = {
            enabled: e.enabled === true,
            display: e.display === 'sidebar' || e.display === 'both' || e.display === 'off' ? e.display : 'settings',
            refreshMinutes: typeof e.refreshMinutes === 'number' && Number.isFinite(e.refreshMinutes) ? e.refreshMinutes : 15,
            apiKey: typeof e.apiKey === 'string' ? e.apiKey : '',
            ...(id === 'minimax' ? { baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '' } : {}),
            ...(id === 'qwen' ? { quotaSource: ['cli', 'bailian'].includes(e.quotaSource) ? e.quotaSource : 'local' } : {}),
            // SCNet / 千问本地计量字段(issue #26/#78):其余厂商无此键,缺省剔除。
            ...(typeof e.planCredits === 'number' && Number.isFinite(e.planCredits) && e.planCredits > 0 ? { planCredits: e.planCredits } : {}),
            ...(typeof e.planStart === 'string' ? { planStart: e.planStart } : {}),
            ...(e.rates !== null && typeof e.rates === 'object' && !Array.isArray(e.rates) ? { rates: e.rates } : {}),
            // 火山方舟双凭据(issue #60)
            ...(typeof e.accessKeyId === 'string' ? { accessKeyId: e.accessKeyId } : {}),
            ...(typeof e.secretAccessKey === 'string' ? { secretAccessKey: e.secretAccessKey } : {}),
          }
        }
      }
      return out
    })(),
    prices: {
      models,
      default: parsePrice(v.prices?.default ?? { cacheHit: 0, cacheMiss: 0, output: 0 }, path + '.prices.default'),
      providers: v.prices?.providers && typeof v.prices.providers === 'object' ? v.prices.providers : {},
      // 官方价格币种(issue #47):usageSplit 回退计价据此决定 CNY→USD 折算。
      // 此前白名单丢失该键,客户端恒按 USD 处理(不除汇率),展示时又乘回
      // 汇率,CNY 价目下徽章/明细金额被放大汇率倍。
      currency: typeof v.prices?.currency === 'string' && v.prices.currency.length > 0 ? v.prices.currency : undefined,
    },
    historyDays: needNum(v.historyDays, path + '.historyDays'),
    fetchedAt: v.fetchedAt === null || v.fetchedAt === undefined ? null : needStr(v.fetchedAt, path + '.fetchedAt'),
    priceSource: typeof v.priceSource === 'string' ? v.priceSource : 'bundled',
    budget: {
      enabled: v.budget?.enabled === true,
      amount: typeof v.budget?.amount === 'number' && Number.isFinite(v.budget.amount) ? v.budget.amount : 100,
      period: v.budget?.period === 'day' || v.budget?.period === 'all' || v.budget?.period === 'custom' ? v.budget.period : 'month',
      customStart: typeof v.budget?.customStart === 'string' ? v.budget.customStart : null,
      customEnd: typeof v.budget?.customEnd === 'string' ? v.budget.customEnd : null,
      detail: v.budget?.detail !== false,
    },
    balance: {
      display: oneOf(v.balance?.display, ['sidebar', 'settings', 'off'], 'both'),
      refreshMinutes: typeof v.balance?.refreshMinutes === 'number' && Number.isFinite(v.balance.refreshMinutes) ? v.balance.refreshMinutes : 5,
      showProgressBar: v.balance?.showProgressBar === true,
      budgetCap: typeof v.balance?.budgetCap === 'number' && Number.isFinite(v.balance.budgetCap) && v.balance.budgetCap > 0 ? v.balance.budgetCap : null,
      clickHintSeen: v.balance?.clickHintSeen === true,
    },
    goQuota: {
      enabled: v.goQuota?.enabled !== false,
      display: oneOf(v.goQuota?.display, ['sidebar', 'settings', 'off'], 'both'),
      refreshMinutes: typeof v.goQuota?.refreshMinutes === 'number' && Number.isFinite(v.goQuota.refreshMinutes) ? v.goQuota.refreshMinutes : 15,
      apiKey: typeof v.goQuota?.apiKey === 'string' ? v.goQuota.apiKey : '',
      main: v.goQuota?.main === 'weekly' || v.goQuota?.main === 'monthly' ? v.goQuota.main : 'rolling',
      detail: v.goQuota?.detail !== false,
    },
    customBalance: parseCustomEntry(v.customBalance),
    // 多配置形态(v1.7.0,issue #79):运行期真源;旧 customBalance 键仅为
    // 兼容镜像。快照缺数组时回落单条包装(旧宿主快照)。
    gatewayQuotas: (() => {
      const raw = Array.isArray(v.gatewayQuotas) ? v.gatewayQuotas : v.gatewayQuotas?.sources
      const sources = Array.isArray(raw) ? raw.slice(0, 4).filter(x => x !== null && typeof x === 'object' && !Array.isArray(x)).map(x => ({
        id: typeof x.id === 'string' ? x.id.slice(0, 48) : '',
        type: 'cliproxyapi',
        label: typeof x.label === 'string' ? x.label.slice(0, 80) : '',
        baseURL: typeof x.baseURL === 'string' ? x.baseURL : '',
        enabled: x.enabled !== false,
        display: oneOf(x.display, ['sidebar', 'settings', 'off'], 'both'),
        refreshMinutes: typeof x.refreshMinutes === 'number' && Number.isFinite(x.refreshMinutes) ? Math.min(1440, Math.max(1, Math.floor(x.refreshMinutes))) : 15,
        includeProviders: Array.isArray(x.includeProviders) ? [...new Set(x.includeProviders.filter(p => typeof p === 'string').map(p => p.toLowerCase()).filter(p => GATEWAY_PROVIDERS.includes(p)))] : GATEWAY_PROVIDERS,
        allowedHosts: Array.isArray(x.allowedHosts) ? x.allowedHosts.filter(h => typeof h === 'string').slice(0, 16) : [],
        allowInsecureHttp: x.allowInsecureHttp === true,
        antigravityOnlyGemini: x.antigravityOnlyGemini === true,
        keyVar: typeof x.keyVar === 'string' ? x.keyVar : '',
      })) : []
      return { sources }
    })(),
    customBalances: (() => {
      if (Array.isArray(v.customBalances)) return v.customBalances.filter(x => x !== null && typeof x === 'object').slice(0, 8).map(parseCustomEntry).filter(Boolean)
      const single = parseCustomEntry(v.customBalance)
      return single ? [single] : []
    })(),
    corner: {
      enabled: v.corner?.enabled === true,
      goRolling: v.corner?.goRolling !== false,
      goWeekly: v.corner?.goWeekly !== false,
      goMonthly: v.corner?.goMonthly !== false,
      budget: v.corner?.budget !== false,
    },
    quotaStrip: {
      enabled: v.quotaStrip?.enabled === true,
      budget: v.quotaStrip?.budget !== false,
      go: v.quotaStrip?.go !== false,
      plans: v.quotaStrip?.plans !== false,
      promptSeen: v.quotaStrip?.promptSeen === true,
    },
    usage: {
      position: v.usage?.position === 'general' || v.usage?.position === 'section' ? v.usage.position : 'cost',
    },
    // 进度条方向(issue #67):非法值回落各组默认(balance=remaining,其余=used)。
    barDirections: (() => {
      const src = v.barDirections !== null && typeof v.barDirections === 'object' && !Array.isArray(v.barDirections) ? v.barDirections : {}
      const pick = (key, fallback) => (src[key] === 'remaining' || src[key] === 'used' ? src[key] : fallback)
      return {
        balance: pick('balance', 'remaining'),
        budget: pick('budget', 'used'),
        go: pick('go', 'used'),
        plan: pick('plan', 'used'),
      }
    })(),
    // Plan/API 双轨计费分类(issue #64):读侧白名单,非法值回落默认。
    planBilling: {
      providers: parseBillingClasses(v.planBilling?.providers),
      models: parseBillingClasses(v.planBilling?.models, true),
    },
  }
}
    const numOrNull = x => (typeof x === 'number' && Number.isFinite(x) ? x : null)
export const num0 = x => numOrNull(x) ?? 0
export const EMPTY_BAL = { status: 'off', message: '', fetchedAt: 0, currency: '', totalBalance: 0, grantedBalance: 0, toppedUpBalance: 0 }
export const EMPTY_GO = { status: 'off', message: '', fetchedAt: 0, rolling: null, weekly: null, monthly: null }
export const emptyCustomSnapshot = (index = null) => ({ status: 'off', message: '', fetchedAt: 0, label: '', unit: 'USD', remaining: 0, maxBudget: null, spend: null, index })
export function parseSnapshotStatus(v, path) {
  needObject(v, path)
  return {
    status: v.status === 'ok' || v.status === 'error' ? v.status : 'off',
    message: typeof v.message === 'string' ? v.message : '',
    fetchedAt: typeof v.fetchedAt === 'number' ? v.fetchedAt : 0,
  }
}
export function parseBalance(v, path) {
  return {
    ...parseSnapshotStatus(v, path),
    keyConfigured: v.keyConfigured === true,
    keySource: typeof v.keySource === 'string' ? v.keySource : '',
    currency: typeof v.currency === 'string' ? v.currency : '',
    totalBalance: num0(v.totalBalance),
    grantedBalance: num0(v.grantedBalance),
    toppedUpBalance: num0(v.toppedUpBalance),
  }
}
export function parseGoWindow(v, path) {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object' || Array.isArray(v)) fail(path, 'object')
  return {
    percent: num0(v.percent),
    resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : '',
  }
}
export function parseGoQuota(v, path) {
  return {
    ...parseSnapshotStatus(v, path),
    rolling: parseGoWindow(v.rolling, path + '.rolling'),
    weekly: parseGoWindow(v.weekly, path + '.weekly'),
    monthly: parseGoWindow(v.monthly, path + '.monthly'),
  }
}
export function parseCustomBalance(v, path) {
  return {
    ...parseSnapshotStatus(v, path),
    label: typeof v.label === 'string' ? v.label : '',
    unit: typeof v.unit === 'string' ? v.unit : 'USD',
    remaining: num0(v.remaining),
    maxBudget: numOrNull(v.maxBudget),
    spend: numOrNull(v.spend),
    // 条目索引(v1.7.0,issue #79):多配置形态下逐条刷新按钮的定位依据。
    index: typeof v.index === 'number' && Number.isFinite(v.index) && v.index >= 0 ? Math.floor(v.index) : null,
  }
}

export const gatewayAccountStatuses = new Set(['ok', 'partial', 'unknown', 'error', 'stale', 'unsupported', 'capability_missing'])
export const gatewaySourceStatuses = new Set(['off', 'loading', 'ok', 'partial', 'stale', 'error'])
// 六家网关 Provider 白名单与展示名(与服务端 lib/store.js 的 GATEWAY_PROVIDER_IDS 一致);
// 侧边栏卡片(02)与设置页面板(03)共用,故定义在首个使用方之前。
export const GATEWAY_PROVIDERS = ['antigravity', 'claude', 'codex', 'kimi', 'xai', 'workbuddy']
export const GATEWAY_PROVIDER_LABELS = { antigravity: 'Antigravity', claude: 'Claude', codex: 'Codex', kimi: 'Kimi', xai: 'xAI', workbuddy: 'WorkBuddy' }
export function parseGatewayQuota(v, path) {
  needObject(v, path)
  const s0 = (s, d = '') => (typeof s === 'string' ? s : d)
  const n = x => numOrNull(x)
  const windowOf = x => x !== null && typeof x === 'object' && !Array.isArray(x) ? { id: s0(x.id), label: s0(x.label), ...(n(x.percent) === null ? {} : { percent: n(x.percent) }), resetsAt: s0(x.resetsAt), periodHours: n(x.periodHours), scope: s0(x.scope) } : null
  const creditsOf = x => x !== null && typeof x === 'object' && !Array.isArray(x) ? { unit: s0(x.unit, 'credits'), used: n(x.used), remaining: n(x.remaining), limit: n(x.limit), fetchedAt: s0(x.fetchedAt), packages: Array.isArray(x.packages) ? x.packages.filter(p => p !== null && typeof p === 'object' && !Array.isArray(p)).map(p => ({ id: s0(p.id), label: s0(p.label), used: n(p.used), remaining: n(p.remaining), limit: n(p.limit), startsAt: s0(p.startsAt), resetsAt: s0(p.resetsAt) })) : [] } : undefined
  return { id: s0(v.id), type: 'cliproxyapi', label: s0(v.label), status: gatewaySourceStatuses.has(v.status) ? v.status : 'error', message: s0(v.message), fetchedAt: n(v.fetchedAt) ?? 0, attemptedAt: n(v.attemptedAt) ?? 0, serverVersion: s0(v.serverVersion), keyConfigured: v.keyConfigured === true, keySource: s0(v.keySource, 'none'), accounts: Array.isArray(v.accounts) ? v.accounts.filter(a => a !== null && typeof a === 'object' && !Array.isArray(a)).slice(0, 16).map(a => ({ id: s0(a.id), provider: s0(a.provider, 'unknown'), label: s0(a.label, 'unknown'), status: gatewayAccountStatuses.has(a.status) ? a.status : 'unknown', message: s0(a.message), plan: s0(a.plan), windows: Array.isArray(a.windows) ? a.windows.map(windowOf).filter(Boolean) : [], credits: creditsOf(a.credits) })) : [], unsupportedProviders: Array.isArray(v.unsupportedProviders) ? v.unsupportedProviders.filter(x => typeof x === 'string').slice(0, 32) : [] }
}
export function parsePlanStats(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const providers = {}
  if (v.providers !== null && typeof v.providers === 'object' && !Array.isArray(v.providers)) {
    for (const [id, raw] of Object.entries<JsonRecord>(v.providers)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const windows = {}
      const intervals = {}
      if (raw.windows !== null && typeof raw.windows === 'object' && !Array.isArray(raw.windows)) {
        for (const [wk, w] of Object.entries<JsonRecord>(raw.windows)) {
          if (w === null || typeof w !== 'object' || Array.isArray(w)) continue
          windows[wk] = {
            ...mapFields(w, ['percent', 'localTokens', 'localCost', 'sampleCount'], num0),
            ...mapFields(w, ['sampleAt', 'per1Tokens', 'per1Cost', 'fullTokens', 'fullCost'], numOrNull),
            resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : '',
            method: w.method === 'sample' || w.method === 'live' ? w.method : 'none',
            confidence: w.confidence === 'high' || w.confidence === 'low' ? w.confidence : null,
          }
        }
      }
      if (raw.intervals !== null && typeof raw.intervals === 'object' && !Array.isArray(raw.intervals)) {
        for (const [wk, list] of Object.entries(raw.intervals)) {
          if (!Array.isArray(list)) continue
          intervals[wk] = list.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x))
            .map(x => mapFields(x, ['t0', 't1', 'tokens', 'cost', 'pct', 'per1Tokens', 'per1Cost'], num0))
        }
      }
      providers[id] = { windows, intervals }
    }
  }
  return { generatedAt: num0(v.generatedAt), providers }
}
export function parseState(v, path) {
  needObject(v, path)
  return {
    today: parseDay(v.today, path + '.today'),
    month: parseDay(v.month, path + '.month'),
    total: parseDay(v.total, path + '.total'),
    budgetUsed: typeof v.budgetUsed === 'number' && Number.isFinite(v.budgetUsed) ? v.budgetUsed : undefined,
    balance: v.balance == null ? EMPTY_BAL : parseBalance(v.balance, path + '.balance'),
    goQuota: v.goQuota == null ? EMPTY_GO : parseGoQuota(v.goQuota, path + '.goQuota'),
    customBalance: v.customBalance == null ? emptyCustomSnapshot() : parseCustomBalance(v.customBalance, path + '.customBalance'),
    // 多配置形态(v1.7.0,issue #79):全部条目快照;缺失/畸形回落空数组
    // (旧宿主快照),渲染退化为旧单条 customBalance 镜像。
    customBalances: Array.isArray(v.customBalances)
      ? v.customBalances.filter(x => x !== null && typeof x === 'object').map((x, i) => parseCustomBalance(x, path + '.customBalances[' + i + ']'))
      : [],
    gatewayQuotas: Array.isArray(v.gatewayQuotas)
      ? v.gatewayQuotas.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x)).map((x, i) => parseGatewayQuota(x, path + '.gatewayQuotas[' + i + ']'))
      : [],
    // {{VAR}} 占位符凭据状态(v1.7.6,issue #86):缺失/畸形回落空对象(凭据输入区全部按未配置渲染)。
    customVarStatus: v.customVarStatus !== null && typeof v.customVarStatus === 'object' && !Array.isArray(v.customVarStatus)
      ? Object.fromEntries(Object.entries<JsonRecord>(v.customVarStatus)
        .filter(([, s]) => s !== null && typeof s === 'object')
        .map(([name, s]) => [name, { configured: s.configured === true, source: typeof s.source === 'string' ? s.source : '' }]))
      : {},
    codingPlans: v.codingPlans !== null && typeof v.codingPlans === 'object' && !Array.isArray(v.codingPlans) ? v.codingPlans : {},
    // Token Plan 统计(issue #64):宽容解析,缺失/畸形回落 null(UI 隐藏面板)。
    planStats: parsePlanStats(v.planStats),
    history: Array.isArray(v.history) ? v.history.map((d, i) => parseDay(d, path + '.history[' + i + ']')) : [],
    externalUsage: v.externalUsage && Array.isArray(v.externalUsage.sources) ? {
      fetchedAt: Number(v.externalUsage.fetchedAt) || 0,
      stale: v.externalUsage.stale === true,
      sources: v.externalUsage.sources.map(s => ({ source: String(s.source), today: parseDay(s.today, path + '.external.today'), month: parseDay(s.month, path + '.external.month'), total: parseDay(s.total, path + '.external.total'), history: (s.history ?? []).map(d => parseDay(d, path + '.external.history')) })),
      combined: Object.fromEntries(['today', 'month', 'total', 'history'].map(k => [k, k === 'history' ? (v.externalUsage.combined.history ?? []).map(d => parseDay(d, path + '.external.history')) : parseDay(v.externalUsage.combined[k], path + '.external.' + k)])),
    } : null,
    config: parseConfig(v.config, path + '.config'),
    reconcile: v.reconcile === null || v.reconcile === undefined ? undefined : { ok: v.reconcile.ok === true, message: typeof v.reconcile.message === 'string' ? v.reconcile.message : '' },
    // 扩展价格表目录(宿主只读下发;缺失时 UI 自动隐藏目录面板)。
    priceCatalog: v.priceCatalog !== null && typeof v.priceCatalog === 'object' && !Array.isArray(v.priceCatalog) ? v.priceCatalog : null,
    meta: {
      ...(supportedLocale(v.meta?.locale) ? { locale: supportedLocale(v.meta.locale) } : {}),
      now: typeof v.meta?.now === 'number' ? v.meta.now : Date.now(),
      timezoneOffsetMinutes: typeof v.meta?.timezoneOffsetMinutes === 'number' ? v.meta.timezoneOffsetMinutes : 0,
      timezone: typeof v.meta?.timezone === 'string' ? v.meta.timezone : '',
      dayKey: typeof v.meta?.dayKey === 'string' ? v.meta.dayKey : '',
      monthKey: typeof v.meta?.monthKey === 'string' ? v.meta.monthKey : '',
    },
  }
}
export function parseFetchResult(v, path) {
  needObject(v, path)
  const out: { ok: boolean; message: string; state?: ReturnType<typeof parseState> } = {
    ok: v.ok === true,
    message: typeof v.message === 'string' ? v.message : '',
  }
  if (v.state !== undefined && v.state !== null) out.state = parseState(v.state, path + '.state')
  return out
}
export function codecOf(parse) {
  return { parse }
}
export const stateCodec = codecOf(parseState)
export const patchCodec = codecOf(v => needObject(v, 'patch'))
export const fetchCodec = codecOf(parseFetchResult)
export const providerCodec = codecOf(v => {
  return needStr(v, 'provider')
})
// 自定义余额条目索引(v1.7.1):0-7 整数或 undefined(缺省 = 全量刷新)。
export const indexCodec = codecOf(v => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 7) fail('index', '0-7 integer')
  return v
})
export const dateCodec = codecOf(v => {
  return needStr(v, 'date')
})
export const dayCodec = codecOf(v => needObject(v, 'day'))
export const limitCodec = codecOf(v => {
  if (!Number.isFinite(Number(v))) fail('limit', 'number')
  return Number(v)
})
export const sortCodec = codecOf(v => {
  return needStr(v, 'sort')
})
export const topSessionsCodec = codecOf(v => needObject(v, 'topSessions'))
// 密钥目标与明文(v1.6.8):target 为受限枚举,明文仅单向上行,永不回传。
export const credTargetCodec = codecOf(v => {
  return needStr(v, 'target')
})
export const credValueCodec = codecOf(v => {
  return needStr(v, 'value')
})

// ── RPC 贡献(与服务端 ./typert 清单一一对应) ───────────────────────────
export const strictCodec = (name, schema) => ({ mode: 'strict', typeSymbol: 'dsh-cost-meter#' + name, schema, create: () => schema })
export const rpcParam = (name, type, schema, optional = false) => ({ name, wire: name, source: 'json', codec: strictCodec(type, schema), ...(optional ? { acceptsUndefined: true } : {}) })

export const CONTRIBUTION = {
  package: 'dsh-cost-meter',
  descriptors: [
    ...['getState', 'getLocalState'].map(method => ({ method, result: strictCodec('CostState', stateCodec) })),
    {
      method: 'updateConfig',
      parameters: [rpcParam('patch', 'ConfigPatch', patchCodec)],
      result: strictCodec('CostState', stateCodec),
    },
    {
      method: 'fetchPrices',
      },
    {
      method: 'refreshBalance',
      },
    {
      method: 'refreshGoQuota',
      },
    {
      method: 'refreshCustomBalance',
      // index(v1.7.1):与宿主侧 manifest 同口径——acceptsUndefined 允许旧调用
      // 不带参数(等价全量刷新);codec 与 providerCodec 同为本地 parse 形态。
      parameters: [rpcParam('index', 'CustomBalanceIndex', indexCodec, true)],
      },
    {
      method: 'refreshCodingPlan',
      parameters: [rpcParam('provider', 'CodingPlanProvider', providerCodec)],
      },
    {
      method: 'loginCodingPlan',
      parameters: [rpcParam('provider', 'CodingPlanProvider', providerCodec)],
      },
    {
      method: 'refreshGatewayQuota',
      parameters: [rpcParam('sourceId', 'GatewayQuotaSourceId', codecOf(v => {
        if (v === undefined || v === null) return undefined
        if (typeof v !== 'string' || v.length > 48 || !/^[a-z0-9][a-z0-9_-]*$/.test(v)) fail('sourceId', 'gateway source id')
        return v
      }), true)],
      },
    {
      method: 'resetHistory',
      result: strictCodec('CostState', stateCodec),
    },
    {
      method: 'importLegacyHistory',
      },
    {
      method: 'getDaySessions',
      parameters: [rpcParam('date', 'DayKey', dateCodec)],
      result: strictCodec('DayRecord', dayCodec),
    },
    {
      method: 'getSessionCost',
      parameters: [rpcParam('sessionId', 'SessionId', providerCodec)],
      result: strictCodec('SessionCost', codecOf(v => ({ own: parseSession(v.own, 'own'), subagents: parseSession(v.subagents, 'subagents'), found: needBool(v.found, 'found'), subagentCount: needNum(v.subagentCount, 'subagentCount') }))),
    },
    {
      id: 'dsh-cost-meter#costMeter/getTurnCost', service: 'costMeter', namespace: 'costMeter', method: 'getTurnCost', invocation: { kind: 'direct' },
      parameters: [rpcParam('sessionId', 'SessionId', codecOf(v => needStr(v, 'sessionId'))), ...['startSeq', 'endSeq'].map(name => rpcParam(name, 'TurnSeq', codecOf(v => { if (!Number.isSafeInteger(v) || v < 0) fail(name, 'nonnegative integer'); return v })))],
      result: strictCodec('TurnCost', codecOf(v => ({ found: needBool(v.found, 'found'), cost: needNum(v.cost, 'cost'), apiCost: needNum(v.apiCost, 'apiCost'), rows: parseTurnRows(v.rows),
        calls: (Array.isArray(v.calls) ? v.calls : fail('calls', 'array')).map(c => ({ kind: needStr(c.kind, 'kind'), provider: needStr(c.provider, 'provider'), model: needStr(c.model, 'model'), atMs: needNum(c.atMs, 'atMs'), cost: needNum(c.cost, 'cost'), apiCost: needNum(c.apiCost, 'apiCost'), plan: needBool(c.plan, 'plan'), priced: needBool(c.priced, 'priced'), longContext: needBool(c.longContext, 'longContext'), rows: parseTurnRows(c.rows) })) }))),
    },
    {
      method: 'getTopSessions',
      parameters: [
        rpcParam('limit', 'SessionLimit', limitCodec),
        rpcParam('sort', 'SessionSort', sortCodec, true),
        rpcParam('dir', 'SessionSortDir', sortCodec, true),
      ],
      result: strictCodec('TopSessions', topSessionsCodec),
    },
    {
      // 写入一枚密钥到 DSH 凭据库(v1.6.8):与服务端 typert 清单一一对应。
      method: 'setCredential',
      parameters: [
        rpcParam('target', 'CredentialTarget', credTargetCodec),
        rpcParam('value', 'CredentialValue', credValueCodec),
      ],
      },
    {
      // 从 DSH 凭据库移除一枚密钥(v1.6.8)。
      method: 'clearCredential',
      parameters: [
        rpcParam('target', 'CredentialTarget', credTargetCodec),
      ],
      },
  ].map(def => ({ id: 'dsh-cost-meter#costMeter/' + def.method, service: 'costMeter', namespace: 'costMeter',
    invocation: { kind: 'direct' }, parameters: [], result: strictCodec('FetchPricesResult', fetchCodec), ...def })),
}

// ── 计费与显示助手(与服务端 pricing.js 一致) ───────────────────────────

export function priceEntryFor(modelId, table) {
  const models = table?.models ?? {}
  if (typeof modelId === 'string' && modelId.length > 0 && models[modelId] !== undefined) return models[modelId]
  return table?.default ?? { cacheHit: 0, cacheMiss: 0, output: 0 }
}
/** 一档价格补齐(v1.6.9 起与 lib/pricing.js completeTier 同口径的客户端镜像):
 *  只认非负有限数字,补齐 cacheMiss/cacheHit 缺省;子档(offPeak/peak/legacyBase)同规则。 */
export function normalizeClientTier(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const n = key => {
    const v = raw[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  }
  const miss = n('cacheMiss') ?? n('input') ?? 0
  const hit = n('cacheHit') ?? n('cachedInput') ?? n('cacheRead') ?? miss
  const out: JsonRecord = { cacheHit: hit, cacheMiss: miss, output: n('output') ?? 0 }
  const reasoning = n('reasoning')
  if (reasoning !== undefined) out.reasoning = reasoning
  if (n('cacheWrite') !== undefined) out.cacheWrite = n('cacheWrite')
  return out
}
export function normalizeClientPrice(raw) {
  const base = normalizeClientTier(raw)
  if (base === undefined) return null
  if (raw.billingMode === 'utc-peak') base.billingMode = 'utc-peak'
  // 峰谷/历史子档必须随主档一起保留:usageSplit 回退计价与 Plan 拆分靠 tierFor
  // 取子档,剥掉会把峰时调用按基础价(= 谷价)重算、低估约一半(v1.6.9 审计修复)。
  for (const key of ['offPeak', 'peak', 'legacyBase']) {
    const tier = normalizeClientTier(raw[key])
    if (tier !== undefined) base[key] = tier
  }
  if (Number.isFinite(raw.longContext?.aboveInputTokens) && raw.longContext.aboveInputTokens > 0) base.longContext = { ...normalizeClientTier(raw.longContext), aboveInputTokens: raw.longContext.aboveInputTokens }
  if (Array.isArray(raw.rateHistory)) base.rateHistory = raw.rateHistory.slice(0, 16).map(period => {
    const out = { ...normalizeClientTier(period), before: period.before }
    for (const key of ['offPeak', 'peak']) {
      const tier = normalizeClientTier(period[key])
      if (tier !== undefined) out[key] = tier
    }
    return out
  })
  return base
}

export function priceAt(entry, atMs = Date.now()) {
  if (!entry || !Number.isFinite(atMs) || !Array.isArray(entry.rateHistory)) return entry
  let chosen: JsonRecord | null = null, boundary = Infinity
  for (const period of entry.rateHistory) {
    const until = Date.parse(period.before)
    if (atMs < until && until < boundary) { chosen = period; boundary = until }
  }
  if (!chosen) return entry
  const { before, ...rates } = chosen
  return { ...entry, ...rates }
}
// 峰谷纯计算(WEEKEND_OFFPEAK_EFFECTIVE_MS / weekendZoneAt / holidayZoneAt /
// offPeakZoneAt / isPeakHour / LEGACY_BASE_BOUNDARY_MS)已移至 ./peak-core.js,
// 并由文件头的 re-export 转出,此处只保留计价侧的 tierFor。
export function tierFor(entry, atMs, peak) {
  const base = priceAt(entry, atMs) ?? { cacheHit: 0, cacheMiss: 0, output: 0 }
  const asTier = price => ({ cacheHit: price.cacheHit, cacheMiss: price.cacheMiss, output: price.output, reasoning: price.reasoning ?? 0,
    ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }), ...(price.longContext === undefined ? {} : { longContext: price.longContext }) })
  if (base.billingMode === 'utc-peak') {
    if (peak?.enabled !== true || !Number.isFinite(atMs)) return asTier(base)
    const date = new Date(atMs), day = date.getUTCDay(), hour = date.getUTCHours()
    const high = day > 0 && day < 6 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
    return asTier((high ? base.peak : base.offPeak) ?? base)
  }
  // 峰谷时代之前按当时的基础价计费(历史正确;与 lib/pricing.js tierFor 同分支,
  // v1.6.9 审计修复:客户端镜像此前缺该分支,分界前回放桶会按当前价重算)。
  if (Number.isFinite(atMs) && atMs < LEGACY_BASE_BOUNDARY_MS) {
    const lb = base.legacyBase
    return lb === undefined ? asTier(base) : asTier(lb)
  }
  if (peak?.enabled !== true) return asTier(base)
  // 非有限(如 Date.parse('') 的 NaN)视同「未知生效时刻」,与服务端 tierFor 同口径。
  const effectiveAtMs = typeof peak.effectiveAtMs === 'number' && Number.isFinite(peak.effectiveAtMs) ? peak.effectiveAtMs : undefined
  if (isPeakHour(atMs, effectiveAtMs, peak.windows, peak.holidays)) {
    const p = base.peak
    return p === undefined ? asTier(base) : asTier(p)
  }
  if (effectiveAtMs !== undefined && atMs >= effectiveAtMs) {
    const off = base.offPeak
    return off === undefined ? asTier(base) : asTier(off)
  }
  return asTier(base)
}
export function costOfBuckets(buckets, tier) {
  const input = Math.max(0, Number(buckets.input) || 0)
  const output = Math.max(0, Number(buckets.output) || 0)
  const cacheRead = Math.max(0, Number(buckets.cacheRead) || 0)
  const cacheWrite = Math.max(0, Number(buckets.cacheWrite) || 0)
  const reasoning = Math.max(0, Number(buckets.reasoning) || 0)
  if (tier.longContext && input + cacheRead + cacheWrite > tier.longContext.aboveInputTokens) tier = tier.longContext
  return (input * tier.cacheMiss + output * tier.output + cacheRead * tier.cacheHit + cacheWrite * (tier.cacheWrite ?? tier.cacheHit) + reasoning * (tier.reasoning ?? 0)) / 1_000_000
}
export function usdFromCostLocal(cost, currency, rate) {
  const c = Number(cost)
  if (!Number.isFinite(c) || c < 0) return 0
  if (c === 0) return 0
  if (currency !== 'CNY') return c
  const r = Number(rate)
  if (!Number.isFinite(r) || r <= 0) return c
  return c / r
}
/**
 * 进度条方向(issue #67):读取配置中某组条的填充语义。
 * 'remaining' = 填充代表剩余(满条起步,随消耗递减);
 * 'used'      = 填充代表已用(空条起步,随消耗填满)。
 * 默认:balance 组 remaining(余额语义),其余组 used(#57 统一口径)。
 */
export function barDirectionOf(config, kind) {
  const bd = config?.barDirections
  const fallback = kind === 'balance' ? 'remaining' : 'used'
  if (bd === null || typeof bd !== 'object' || Array.isArray(bd)) return fallback
  const v = bd[kind]
  return v === 'remaining' || v === 'used' ? v : fallback
}
/** 简单填充条按方向换算:pct 为已用百分比,返回 { width, label }。label=null 表示无数据。 */
export function simpleBarByDirection(pct, direction) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return { width: 0, label: null }
  const used = Math.max(0, Math.min(100, Number(pct)))
  const value = direction === 'remaining' ? Math.round((100 - used) * 10) / 10 : Math.round(used * 10) / 10
  return { width: value, label: value }
}
/** 已换算币种金额 → 显示字符串(符号 + 可调小数位)。 */
export const fixedAmount = (value, decimals) => value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
export function formatMoneyValue(value, config) {
  const symbol = typeof config?.symbol === 'string' && config.symbol.length > 0 ? config.symbol : '$'
  // 合法配置的 decimals:0 须保留(`Number(x) || 2` 会把 0 误抬成 2,
  // 与 lib/pricing.js formatMoney 同规则;v1.6.9 审计修复客户端镜像漂移)。
  const req = Number(config?.decimals)
  const decimals = Math.max(0, Math.min(10, Number.isFinite(req) ? Math.floor(req) : 2))
  let effective = decimals
  if (value > 0 && value < Math.pow(10, -decimals)) effective = decimals + 2
  return symbol + fixedAmount(value, effective)
}
export function formatMoneyUsd(usd, config) {
  const rate = Number(config?.exchangeRate)
  const value = usd * (Number.isFinite(rate) && rate > 0 ? rate : 1)
  return formatMoneyValue(value, config)
}
export function formatTokens(n) {
  const v = Math.max(0, Number(n) || 0)
  const scaled = x => x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
  if (v < 1000) return String(Math.round(v))
  // ≥999500 提前进 M 档:否则 999500 会四舍五入成「1000K」的错误边界值。
  if (v >= 999500) return scaled(v / 1000000) + 'M'
  if (v < 1000000) return scaled(v / 1000) + 'K'
  return scaled(v / 1000000) + 'M'
}
/**
 * 模型名归一化(与 lib/pricing.js 的 canonModelId 同逻辑;bundle 无法导入,修改时两处同步):
 * NFKC 全角/兼容字符归一化后转小写,仅去已知渠道附注 (go)/(zen),只保留 Unicode 字母数字——大小写/空格/横杠/点号等差异全部忽略。
 */
export function modelNameText(id) {
  return String(id ?? '').normalize('NFKC').toLowerCase().replace(/[(（]\s*(?:go|zen)\s*[)）]/g, ' ').trim()
}
export function canonModelIdLocal(id) {
  return modelNameText(id).replace(/[^\p{L}\p{N}]+/gu, '')
}
/**
 * 模型名自动匹配(与 lib/pricing.js 的 matchModelId 同逻辑;bundle 无法导入,修改时两处同步)。
 * 精确 → 归一化等价 → 去日期/版本后缀 → 安全后缀。
 */
export function stripIdDecor(id) {
  // Strip request decorations one at a time; candidate snapshots keep their identity.
  return modelNameText(id).replace(/[-_./:@](?:\d{4}-?\d{2}-?\d{2}|v\d+(?:\.\d+)*|\d+k|latest)$/, '')
}

/** Exact IDs precede unique punctuation aliases and request-only safe decorations. */
export function matchModelIdLocal(modelId, candidates, exactId = modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null
  const list = Array.isArray(candidates) ? candidates.filter(c => typeof c === 'string' && c.length > 0) : []
  const exact = list.find(c => c === exactId)
  if (exact !== undefined) return exact
  let target = modelId.normalize('NFKC').trim()
  if (/[:(（]\s*(?:free|online)\b/i.test(target)) return null
  for (;;) {
    const canon = canonModelIdLocal(target)
    if (canon.length === 0) return null
    const hits = list.filter(c => canonModelIdLocal(c) === canon)
    if (hits.length > 0) return hits.length === 1 ? hits[0] : null
    const stripped = stripIdDecor(target)
    if (stripped === target.toLowerCase()) return null
    target = stripped
  }
}

export const SCOPED_PRICE_PROVIDERS = new Set(['openrouter', 'opencode-zen', 'opencode-go', 'zen', 'opencode'])
export const MODEL_VENDOR_PREFIXES = {
  openai: /^(?:gpt|o\d|codex)/i, anthropic: /^claude/i, google: /^gemini/i,
  deepseek: /^deepseek/i, moonshot: /^kimi/i, 'z-ai': /^glm/i, xai: /^grok/i,
  alibaba: /^qwen/i, minimax: /^minimax/i, tencent: /^(?:hunyuan|hy\d)/i,
  xiaomi: /^mimo/i, upstage: /^solar/i, nvidia: /^nemotron/i, mistral: /^mistral/i,
  meta: /^(?:muse|llama)/i, meituan: /^longcat/i,
}
export function priceBillingMode(entry) {
  return ['deepseek-peak', 'utc-peak'].includes(entry?.billingMode) ? entry.billingMode : 'flat'
}
// Full IDs win. Auto aliases may remove a known upstream namespace, never a routing variant.
// Gemini API model resource names use models/{model}: https://ai.google.dev/api/models
export function priceModelHit(modelId, models, provider, mode, prices) {
  if (typeof modelId !== 'string') return null
  if (Object.hasOwn(models, modelId)) return modelId
  if (mode !== 'auto') return null
  let target = modelId.normalize('NFKC').trim().replace(/^models\/(?=gemini)/i, 'google/')
  const sep = target.search(/[/:]/)
  if (sep > 0) {
    const vendor = target.slice(0, sep).trim().toLowerCase(), bare = target.slice(sep + 1).trim()
    if (Object.hasOwn(MODEL_VENDOR_PREFIXES, vendor)
      && (vendor === provider || (provider === 'opencode-zen' || provider === 'opencode-go')
        && (MODEL_VENDOR_PREFIXES[vendor].test(bare)
          || matchModelIdLocal(bare, Object.keys(vendor === 'deepseek' ? prices?.models ?? {} : prices?.providers?.[vendor]?.models ?? {})) !== null))) target = bare
    else if (Object.hasOwn(MODEL_VENDOR_PREFIXES, vendor)) return null
  }
  // Formatting a request must not create a literal hit that bypasses alias collisions.
  return matchModelIdLocal(target, Object.keys(models), modelId)
}
/**
 * 客户端价格解析(与 pricing.js providerPriceEntryFor 同口径):手动覆盖 → 精确 → 自动匹配。
 * @returns { entry, priced, billingMode, matched }。
 *   matched: 是否命中显式价格条目(含跨厂商兑底);false = DeepSeek 默认价兜底或完全未命中,
 *   未命中列表据此判定(与计费口径一致,路由 provider 前缀不再误报)。
 */
// 本地推理来源判定(v1.6.11,与 lib/pricing.js isLocalOriginProviderOrModel 同
// 名单同口径;bundle 无法直接复用宿主模块,此处为镜像副本,双侧同输入同结果
// 由 verify.mjs 漂移守卫锁定)。
export const LOCAL_PROVIDER_IDS = new Set([
  'local', 'lmstudio', 'ollama', 'jan', 'gpt4all', 'koboldcpp', 'llamacpp', 'llama-cpp', 'localai',
  'vllm', 'sglang', 'tabbyapi', 'lmdeploy', 'oobabooga', 'text-generation-webui', 'llama-server',
])
export const LOCAL_MODEL_PREFIXES = [
  'lmstudio:', 'lmstudio/', 'ollama:', 'ollama/', 'jan:', 'jan/', 'gpt4all:', 'gpt4all/',
  'koboldcpp:', 'koboldcpp/', 'llamacpp:', 'llamacpp/', 'llama-cpp:', 'llama-cpp/',
  'localai:', 'localai/', 'vllm:', 'vllm/', 'sglang:', 'sglang/', 'tabbyapi:', 'tabbyapi/',
  'lmdeploy:', 'oobabooga/', 'text-generation-webui/', 'llama-server:', 'gguf:', 'local:',
]
export function isLocalOriginClient(provider, modelId) {
  if (typeof provider === 'string' && LOCAL_PROVIDER_IDS.has(provider)) return true
  const model = typeof modelId === 'string' ? modelNameText(modelId) : ''
  return LOCAL_MODEL_PREFIXES.some(prefix => model.startsWith(prefix))
}
export function legacyDeepseekOverride(provider, override, prices, mode) {
  if (provider !== 'deepseek' && !provider.includes('deepseek')
    && typeof override === 'string' && override.length > 0 && override !== '__local__' && !override.includes(':')) {
    const dsModels = prices.models ?? {}
    const retryHit = Object.hasOwn(dsModels, override) ? override
      : (mode === 'auto' ? matchModelIdLocal(override, Object.keys(dsModels)) : null)
    if (retryHit !== null && dsModels[retryHit]?.unpriced !== true) return { entry: dsModels[retryHit], priced: true, billingMode: 'deepseek-peak', matched: true }
  }
  return null
}
export function resolveClientPriceRaw(providerRaw, modelId, config) {
  const prices = config?.prices ?? {}
  const mode = config?.priceMatch === 'exact' ? 'exact' : 'auto'
  const overrides = config?.priceOverrides && typeof config.priceOverrides === 'object' ? config.priceOverrides : {}
  let provider = String(providerRaw ?? '').trim().toLowerCase()
  if (provider.startsWith('llm-')) provider = provider.slice(4)
  if (provider === '') provider = 'deepseek'
  let targetProvider = provider
  let targetModel = modelId
  const override = overrides[provider + ':' + modelId]
  // 「本地模型(零消耗)」哨兵(与 pricing.js 同口径):覆盖目标 __local__ →
  // 未定价(token 照记、费用 0),matched=true 表示已人工指定。
  if (override === '__local__') return { entry: null, priced: false, billingMode: 'flat', matched: true }
  if (typeof override === 'string' && override.length > 0) {
    const sep = override.indexOf(':')
    if (sep > 0 && override.slice(sep + 1).length > 0) {
      targetProvider = override.slice(0, sep).trim().toLowerCase()
      targetModel = override.slice(sep + 1)
    } else {
      targetModel = override
    }
    if (targetProvider === 'deepseek' && targetModel === '__default__') {
      return { entry: prices.default ?? { cacheHit: 0, cacheMiss: 0, output: 0 }, priced: prices.default?.unpriced !== true, billingMode: 'deepseek-peak', matched: false }
    }
  }
      if (['zen', 'opencode'].includes(targetProvider)) {
    const own = priceModelHit(targetModel, prices.providers?.[targetProvider]?.models ?? {}, 'opencode-go', mode, prices)
    if (own === null) targetProvider = 'opencode-go'
    else targetModel = own
  }
  // 本地推理来源零价守卫(与 pricing.js 同口径,置于覆盖之后、目录匹配之前)。
  if (isLocalOriginClient(targetProvider, targetModel)) {
    return { entry: null, priced: false, billingMode: 'flat', matched: false }
  }
  if (targetProvider === 'openrouter') {
    const models = prices.providers?.openrouter?.models ?? {}
    const entry = Object.hasOwn(models, targetModel) ? models[targetModel] : null
    return { entry, priced: entry !== null && entry.unpriced !== true, billingMode: 'flat', matched: entry !== null }
  }
  if (targetProvider === 'deepseek' || targetProvider.includes('deepseek')) {
    const models = prices.models ?? {}
    const hit = priceModelHit(targetModel, models, 'deepseek', mode, prices)
    if (hit !== null) return models[hit]?.unpriced === true
      ? { entry: null, priced: false, billingMode: 'flat', matched: true }
      : { entry: models[hit], priced: true, billingMode: 'deepseek-peak', matched: true }
    // 回退: provider 缺失/DeepSeek 但模型实际属于 Go 等其它目录时，避免
    // 误套 DeepSeek 默认低价(与 pricing.js 同口径，修复 Go 金额偏低)。
    if (mode === 'auto') {
      let bestEntry: JsonRecord | null = null
      let bestLen = -1
      let ambiguous = false
      let bestMode = 'flat'
      for (const [prov, table] of Object.entries<JsonRecord>(prices.providers ?? {})) {
        if (SCOPED_PRICE_PROVIDERS.has(prov)) continue
        const modelsCat = table?.models ?? {}
        const h = priceModelHit(targetModel, modelsCat, prov, mode, prices)
        if (h === null) continue
        const score = +(h === targetModel || canonModelIdLocal(h) === canonModelIdLocal(targetModel))
        if (score > bestLen) {
          bestEntry = modelsCat[h]; bestLen = score; ambiguous = false
          // 与 pricing.js 同口径:命中条目自带峰谷模式时保留,否则客户端
          // 会按 flat 计与服务端入账不一致。
          bestMode = priceBillingMode(modelsCat[h])
        } else if (score === bestLen) ambiguous = true
      }
      if (ambiguous) return { entry: null, priced: false, billingMode: 'flat', matched: false }
      if (bestEntry !== null) return { entry: bestEntry, priced: bestEntry.unpriced !== true, billingMode: bestMode, matched: true }
    }
    return { entry: prices.default ?? { cacheHit: 0, cacheMiss: 0, output: 0 }, priced: prices.default?.unpriced !== true, billingMode: 'deepseek-peak', matched: false }
  }
  const catalog = prices.providers?.[targetProvider]?.models ?? {}
  const hit = priceModelHit(targetModel, catalog, targetProvider, mode, prices)
  if (hit !== null) return { entry: catalog[hit], priced: catalog[hit]?.unpriced !== true, billingMode: priceBillingMode(catalog[hit]), matched: true }
  if (SCOPED_PRICE_PROVIDERS.has(targetProvider)) return { entry: null, priced: false, billingMode: 'flat', matched: false }
  if (Object.hasOwn(MODEL_VENDOR_PREFIXES, targetProvider)) return { entry: null, priced: false, billingMode: 'flat', matched: false }
  // 跨厂商兑底(与 pricing.js 同口径):provider 未在价格表登记时按模型名全库查找。
  if (mode === 'auto') {
    let bestEntry: JsonRecord | null = null
    let bestLen = -1
    let ambiguous = false
    let bestMode = 'flat'
    for (const [prov, table] of [['deepseek', { models: prices.models ?? {} }] as [string, JsonRecord], ...Object.entries<JsonRecord>(prices.providers ?? {})]) {
      if (prov === targetProvider || SCOPED_PRICE_PROVIDERS.has(prov)) continue
      const models = table?.models ?? {}
      const h = priceModelHit(targetModel, models, prov, mode, prices)
      if (h === null) continue
      const score = +(h === targetModel || canonModelIdLocal(h) === canonModelIdLocal(targetModel))
      if (score > bestLen) {
        bestEntry = models[h]; bestLen = score; ambiguous = false
        bestMode = prov === 'deepseek' ? 'deepseek-peak' : priceBillingMode(models[h]) // 与 pricing.js 同口径
      } else if (score === bestLen) ambiguous = true
    }
    if (ambiguous) return { entry: null, priced: false, billingMode: 'flat', matched: false }
    if (bestEntry !== null) return { entry: bestEntry, priced: bestEntry.unpriced !== true, billingMode: bestMode, matched: true }
  }
  // issue #56 镜像:v1.5.42 及之前设置页下拉框把 DeepSeek 目标存成裸名,被按
  // 「同渠道换名」解析后查无此价。此处对「裸值覆盖 + 非 DeepSeek 渠道解析失败」
  // 回退 DeepSeek 主表再查一次(仅显式条目/归一化匹配,不吃默认兜底价),
  // 与宿主计费口径保持一致,存量裸名配置自愈且不进未命中列表。
  return { entry: null, priced: false, billingMode: 'flat', matched: false }
}
export function resolveClientPrice(provider, modelId, config) {
  let result = resolveClientPriceRaw(provider, modelId, config)
  if (!result.priced) {
    const normalized = String(provider ?? '').trim().toLowerCase().replace(/^llm-/, '') || 'deepseek'
    result = legacyDeepseekOverride(normalized, config?.priceOverrides?.[normalized + ':' + modelId], config?.prices ?? {}, config?.priceMatch === 'exact' ? 'exact' : 'auto') ?? result
  }
  if (result.priced && config?.prices?.currency === 'CNY' && result.entry?.cny) {
    return { ...result, entry: result.entry.cny, currency: 'CNY' }
  }
  return { ...result, currency: result.priced && result.billingMode === 'deepseek-peak' && config?.prices?.currency === 'CNY' ? 'CNY' : 'USD' }
}
/** 投影 token 桶 → 按当前时刻档位计价的美元成本。 */
/**
 * 缓存字段疑似未上报判定(issue #65 讨论,中转链路):
 * 累计调用 ≥3 次、非缓存输入 ≥100k token(多轮长上下文)而缓存命中恒为 0——
 * 直连 DeepSeek 的 prefix cache 在此形态下几乎必然命中,恒零大概率是中转/代理
 * 剥掉了 usage 的缓存扩展字段(prompt_cache_hit_tokens 等)。真零命中(单轮短
 * 上下文/冷启动)不满足量级阈值,不会被误标。
 */
export function cacheUnreportedOf(bucket) {
  const calls = Number(bucket?.calls) || 0
  const input = Number(bucket?.input) || 0
  const cacheRead = Number(bucket?.cacheRead) || 0
  return calls >= 3 && input >= 100_000 && cacheRead === 0
}

export function usageCost(usage, config) {
  if (!usage || !config) return 0
  // 宿主按事件时刻逐次计费的成本(历史正确,含峰谷时代前的旧基础价);
  // 旧宿主/旧状态缺失 cost 时回退客户端估算。
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost
  return usageSplit(usage, config).total
}
/** 记录级真金白银口径(issue #64):apiCost 缺席 = 旧数据按 cost 全额 API。 */
export function moneyCostOf(entry) {
  if (entry === null || typeof entry !== 'object') return 0
  const c = Number(entry.cost) || 0
  const a = entry.apiCost === undefined || entry.apiCost === null ? c : Number(entry.apiCost)
  return Number.isFinite(a) && a >= 0 ? Math.min(a, c) : c
}
/**
 * 展示口径(v1.6.0「含 Plan 总额」全局开关):
 *  - 关(默认):真金白银 apiCost;
 *  - 开(showTotalWithPlan):总等值 cost(含 Plan 订阅等值金额)。
 * 预算/卡片/徽章/表格等全部金额展示统一走这里,保证同一开关下口径一致。
 */
export function displayCostOf(entry, config) {
  if (config !== null && typeof config === 'object' && config.showTotalWithPlan === true) {
    return Number(entry?.cost) || 0
  }
  return moneyCostOf(entry)
}
// ── Plan/API 双轨分类(issue #64):与 lib/plan-billing.js 同逻辑的镜像实现
//    (bundle 无法导入 Node 模块,修改时两处同步)。──
export const PLAN_PROVIDER_ALIASES_LOCAL = {
  go: ['go', 'zen', 'opencode', 'opencode-go'],
  qwen: ['qwen', 'qwen-tokenplan', 'qianwen-tokenplan', 'qwen-token-plan', 'qianwen-token-plan'],
  scnet: ['scnet', 'scnet-tokenplan', 'scnet-token-plan'],
  mimo: ['mimo', 'xiaomimimo', 'mimo-token-plan', 'xiaomi-token-plan', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams'],
}
export const PLAN_PROVIDER_IDS_LOCAL = ['anthropic', 'zai', 'minimax', 'kimi', 'openrouter', 'siliconflow', 'commandcode', 'scnet', 'volcengine', 'qwen', 'mimo', 'go']
export function planProviderIdOfLocal(provider) {
  const name = String(provider ?? '').trim().toLowerCase().replace(/^llm-/, '')
  if (name.length === 0) return null
  for (const [id, aliases] of Object.entries(PLAN_PROVIDER_ALIASES_LOCAL)) {
    if (aliases.includes(name)) return id
  }
  return PLAN_PROVIDER_IDS_LOCAL.includes(name) ? name : null
}
export function enabledPlanSetOfLocal(config) {
  const out = new Set()
  const plans = config?.codingPlans
  if (plans !== null && typeof plans === 'object') {
    for (const id of PLAN_PROVIDER_IDS_LOCAL) {
      if (id !== 'go' && plans[id]?.enabled === true) out.add(id)
    }
  }
  if (config?.goQuota?.enabled === true) out.add('go')
  return out
}
// 路由调用判定(与 lib/plan-billing.js 同逻辑的镜像):provider 空/deepseek
// 且模型不在 DeepSeek 主表(canon 等价)、但在第三方目录命中 → 视为路由调用。
export const LEGACY_GO_CANON = new Set(['grok-4.5','glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','gpt-5.6-luna','kimi-k3','kimi-k2.7-code','kimi-k2.6','mimo-v2.6-flash','mimo-v2.6-pro','mimo-v2.5','mimo-v2.5-pro','minimax-m3','minimax-m2.7','qwen3.8-max','qwen3.7-max','qwen3.7-plus','qwen3.6-plus','hy3','longcat-2.0','muse-spark-1.2-contributor'].map(canonModelIdLocal))
export function isRoutedThirdPartyCallLocal(provider, modelId, config) {
  const name = String(provider ?? '').trim().toLowerCase()
  if (name.length > 0 && name !== 'deepseek' && !name.includes('deepseek')) return false
  const canon = canonModelIdLocal(modelId)
  if (canon.length === 0 || !LEGACY_GO_CANON.has(canon)) return false
  const prices = config?.prices
  const dsModels = prices?.models ?? {}
  for (const id of Object.keys(dsModels)) {
    if (canonModelIdLocal(id) === canon) return false // DeepSeek 主表模型
  }
  for (const id of Object.keys(prices?.providers?.['opencode-go']?.models ?? {})) {
    if (canonModelIdLocal(id) === canon) return true
  }
  return false
}
export function billingClassOfLocal(provider, modelId, config) {
  let planId = planProviderIdOfLocal(provider)
  if (planId === null && isRoutedThirdPartyCallLocal(provider, modelId, config)) planId = 'go'
  const models = config?.planBilling?.models
  if (models !== null && typeof models === 'object') {
    const direct = models[provider + ':' + modelId]
    if (direct === 'plan' || direct === 'api') return direct
    if (planId !== null) {
      const canonical = models[planId + ':' + modelId]
      if (canonical === 'plan' || canonical === 'api') return canonical
    }
  }
  if (planId === null) return 'api'
  const configured = config?.planBilling?.providers?.[planId]
  if (configured === 'plan' || configured === 'api') return configured
  return enabledPlanSetOfLocal(config).has(planId) ? 'plan' : 'api'
}
/**
 * 投影 token 桶 → { total(等值总额), api(真金白银部分) }(美元)。
 * 与 usageCost 回退路径同一套计价数学,仅多一步按分类拆分。
 */
export function usageSplit(usage, config) {
  if (!usage || !config) return { total: 0, api: 0 }
  const peak = {
    enabled: config.peakEnabled === true,
    effectiveAtMs: Date.parse(config.peakEffectiveAt || ''),
    windows: config.peakWindows,
    holidays: config.peakHolidays,
  }
  const now = Date.now()
  const byModel = usage.byProviderModel ?? usage.byModel ?? {}
  let total = 0
  let api = 0
  for (const providerKey of Object.keys(byModel)) {
    const separator = providerKey.indexOf(':')
    const provider = separator > 0 ? providerKey.slice(0, separator) : 'deepseek'
    const modelId = separator > 0 ? providerKey.slice(separator + 1) : providerKey
    const resolved = resolveClientPrice(provider, modelId, config)
    if (resolved.priced) {
      const c = costOfBuckets(byModel[providerKey], tierFor(normalizeClientPrice(resolved.entry), now, { ...peak, enabled: ['deepseek-peak', 'utc-peak'].includes(resolved.billingMode) && peak.enabled }))
      const billed = usdFromCostLocal(c, resolved.currency, config.exchangeRate)
      total += billed
      if (billingClassOfLocal(provider, modelId, config) === 'api') api += billed
    }
  }
  const modeled = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const modelId of Object.keys(byModel)) {
    modeled.input += byModel[modelId].input ?? 0
    modeled.output += byModel[modelId].output ?? 0
    modeled.cacheRead += byModel[modelId].cacheRead ?? 0
    modeled.cacheWrite += byModel[modelId].cacheWrite ?? 0
    modeled.reasoning += byModel[modelId].reasoning ?? 0
  }
  const leftover = {
    input: Math.max(0, (usage.input ?? 0) - modeled.input),
    output: Math.max(0, (usage.output ?? 0) - modeled.output),
    cacheRead: Math.max(0, (usage.cacheRead ?? 0) - modeled.cacheRead),
    cacheWrite: Math.max(0, (usage.cacheWrite ?? 0) - modeled.cacheWrite),
    reasoning: Math.max(0, (usage.reasoning ?? 0) - modeled.reasoning),
  }
  const leftoverCost = costOfBuckets(leftover, tierFor(priceEntryFor('default', config.prices), now, peak))
  const leftoverBilled = usdFromCostLocal(leftoverCost, config.prices?.currency === 'CNY' ? 'CNY' : 'USD', config.exchangeRate)
  total += leftoverBilled
  api += leftoverBilled
  return { total, api }
}
/** 快速判定:投影里是否存在 Plan 类模型(无则徽章/dock 走宿主精确成本快路径)。 */
export function usageHasPlanClass(usage, config) {
  if (!usage || !config) return false
  const byModel = usage.byProviderModel ?? {}
  for (const providerKey of Object.keys(byModel)) {
    const separator = providerKey.indexOf(':')
    const provider = separator > 0 ? providerKey.slice(0, separator) : 'deepseek'
    const modelId = separator > 0 ? providerKey.slice(separator + 1) : providerKey
    if (billingClassOfLocal(provider, modelId, config) === 'plan') return true
  }
  return false
}
export function billedInput(usage) {
  return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
}
export function recordedApiCost(usage, config) {
  if (usage?.apiCost !== undefined) return moneyCostOf(usage)
  if (!usageHasPlanClass(usage, config)) return usageCost(usage, config)
  let plan = 0
  for (const [key, row] of Object.entries<JsonRecord>(usage.byProviderModel ?? {})) {
    if (!Number.isFinite(row.cost)) return usageSplit(usage, config).api
    const i = key.indexOf(':')
    if (billingClassOfLocal(key.slice(0, i), key.slice(i + 1), config) === 'plan') plan += row.cost
  }
  return Math.max(0, usageCost(usage, config) - plan)
}

// ── 时区错位提示(issue #74):「今日/本月」日键按宿主机进程时区取,宿主与
//    浏览器时区不同时,用户本地午夜后的调用会落到前一日键下(今日显示 ¥0、
//    官方余额对账报偏差)——检测到错位即在概览页提示,避免误判为漏计。──

/** UTC 偏移分钟数 → 'UTC+8' / 'UTC-5:30' 展示。 */
export function formatTzOffset(minutes) {
  const abs = Math.abs(Math.round(Number(minutes) || 0))
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return 'UTC' + (Number(minutes) < 0 ? '-' : '+') + h + (m > 0 ? ':' + String(m).padStart(2, '0') : '')
}
/**
 * 宿主/浏览器时区错位判定。错位时返回 { hostLabel, browserLabel },否则 null。
 * hostLabel 优先用宿主 IANA 名(meta.timezone,如 'Asia/Shanghai (UTC+8)'),
 * 缺席回退纯偏移;browserLabel 用浏览器偏移(浏览器不暴露 IANA 名给同源代码)。
 */
export function timezoneMismatchOf(state) {
  const meta = state?.meta
  const hostOffset = Number(meta?.timezoneOffsetMinutes)
  if (!Number.isFinite(hostOffset)) return null
  const browserOffset = -new Date().getTimezoneOffset()
  if (browserOffset === hostOffset) return null
  const hostName = typeof meta?.timezone === 'string' && meta.timezone.length > 0 ? meta.timezone : ''
  const hostLabel = hostName
    ? hostName + ' (' + formatTzOffset(hostOffset) + ')'
    : formatTzOffset(hostOffset)
  return { hostLabel, browserLabel: formatTzOffset(browserOffset) }
}

// ── 客户端状态存储 ──────────────────────────────────────────────────────

export function makeStore(initial, decorate = value => value) {
  let snapshot = decorate(initial)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: fn => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: next => {
      next = decorate(next)
      if (next === snapshot) return
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}
