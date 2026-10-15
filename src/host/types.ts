/**
 * 宿主侧共享领域类型(`src/host/**` 的 TS 迁移收敛用)。
 *
 * 约定见 docs/client-ts-migration.md「硬性约定」:边界处(DSH ctx、RPC
 * payload、第三方模块)允许 `any`,但必须紧跟 `// TODO(types): <怎么收紧>`。
 *
 * 本文件只收**跨模块反复出现**的核心形状;模块内部的局部结构留在各模块内联
 * 标注,避免过度设计。所有类型都只是编译期描述,`src/host/**` 的运行期语义
 * 不因本文件而改变。
 */

/**
 * DSH 宿主上下文(`ctx`)。
 *
 * 插件只使用 ctx 的少数字段(on / effect / inject / llm / get / provide /
 * now / logger / fiber / costMeter / registry),未导入 cordis 的 Service 类,
 * 因此这里先给 `any` 放行,保证与宿主运行时实例解耦。
 */
export type HostContext = any
// TODO(types): 若后续要收紧,从 @deepseek-ai/cordis 引入 Context 类型(需新增
// peer 依赖),或在本文件按实际用到的成员声明一个最小结构接口。

// ── 价格 ──────────────────────────────────────────────────────────────────

/**
 * 规范化后的一档价格(价表币种 / 1M tokens)。
 * 三桶写法为 cacheHit/cacheMiss/output;reasoning、cacheWrite 为可选加价桶。
 */
export interface PriceTier {
  cacheHit: number
  cacheMiss: number
  output: number
  reasoning?: number
  cacheWrite?: number
  /** 单次请求输入超过 aboveInputTokens 时整次按长上下文档计费。 */
  longContext?: LongContextTier
}

/** 长上下文加价档(阈值 + 该档三桶价)。 */
export interface LongContextTier extends PriceTier {
  aboveInputTokens: number
}

/** 历史价档(priceAt 生效边界之前的一段价格)。 */
export interface RatePeriod extends PriceTier {
  /** 生效边界时刻(ISO 字符串,含时区)。 */
  before: string
  offPeak?: PriceTier
  peak?: PriceTier
}

/**
 * 计价模式:
 *  - flat = 固定价;
 *  - deepseek-peak = DeepSeek 官方北京时区峰谷;
 *  - utc-peak = OpenCode Go 的 UTC 工作日峰谷;
 *  - batch = 批处理价(不参与峰谷)。
 */
export type BillingMode = 'flat' | 'deepseek-peak' | 'utc-peak' | 'batch'

/** 一条模型价格记录(normalizePrice 规范化之后的形状)。 */
export interface PriceEntry extends PriceTier {
  billingMode?: BillingMode
  /** 显式「无价」占位记录(false = 可计价);计费方以 priced 标记为准。 */
  unpriced?: boolean
  legacy?: boolean
  sourceUrl?: string
  checkedAt?: string
  notes?: string
  /** 官方人民币价(价表币种为 USD 时并列保存,供切换币种用)。 */
  cny?: PriceTier
  offPeak?: PriceTier
  peak?: PriceTier
  /** 峰谷改版前的基础价(仅历史计费用)。 */
  legacyBase?: PriceTier
  rateHistory?: RatePeriod[]
  /** 以下三键仅出现在解析入参里(两档简写);规范化后只保留 cacheHit/cacheMiss。 */
  input?: number
  cachedInput?: number
  cacheRead?: number
}

/** 价格表:{ models, default } 加可选的拓展渠道表 providers。 */
export interface PriceTable {
  models: Record<string, PriceEntry>
  default: PriceEntry
  /** 价表币种:'USD' | 'CNY'(缺省按 USD)。 */
  currency?: string
  /** 拓展 Provider 价格表:provider → { models }。 */
  providers?: Record<string, { models: Record<string, PriceEntry> }>
}

/** 峰谷时段窗口(UTC 小时,半开区间 [start, end))。 */
export interface PeakWindow {
  start: number
  end: number
}

/** 峰谷配置(计价入口结构;window/holiday 由账本配置派生)。 */
export interface PeakConfig {
  enabled: boolean
  effectiveAtMs?: number
  windows?: PeakWindow[]
  holidays?: string[]
}

// ── 用量与账本 ────────────────────────────────────────────────────────────

/** 一次调用 / 一个聚合桶的 token 用量。 */
export interface TokenBuckets {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/**
 * 账本聚合桶:token + 调用数 + 成本(USD)。
 *  - cost = 等值成本(Plan 类调用也记等值);
 *  - apiCost = 真金白银部分(Plan 类调用为 0)。
 */
export interface UsageBuckets extends TokenBuckets {
  calls: number
  cost: number
  apiCost: number
}

/** 单会话记录(每日账本 sessions 数组元素)。 */
export interface SessionRecord extends UsageBuckets {
  /** 会话 id(可能缺失,例如无会话的辅助调用)。 */
  sessionId?: string
  /** 会话 id 的历史字段名(sanitizeDays 会将其规范为 '' 或保留)。 */
  id?: string
  /** 会话标题(由历史回填从会话日志补齐;非字符串会被剔除)。 */
  title?: string
  /** 该会话最后入账时刻(epoch ms)。 */
  at?: number
  /** 按 provider:model 拆分的桶。 */
  byProviderModel?: Record<string, UsageBuckets>
  /** Plan 渠道 id(plan 类调用)。 */
  planId?: string | null
}

/** 单日账本记录(date 为本地日期键 YYYY-MM-DD)。 */
export interface DayRecord extends UsageBuckets {
  date: string
  byProviderModel: Record<string, UsageBuckets>
  sessions: SessionRecord[]
}

/** 一次入账的原始调用记录(Ledger.account 产出,用于合并/去重)。 */
export interface AccountCall {
  date: string
  sessionId?: string
  atMs: number
  recordedAt: number
  planId: string | null
  providerKey: string
  values: UsageBuckets
}

/** 官方余额对账参考点。 */
export interface BalanceRef {
  date: string
  total: number
  granted: number
  topped: number
  /** 币种(旧账本无此字段,undefined 表示需重置基准)。 */
  currency?: string
  at: number
  /** 基准时刻的账本当日合计(USD)。 */
  ledgerCost?: number
}

/** Plan 百分比采样样本(plan-billing.recordSamples 写入)。 */
export interface PlanSample {
  /** 采样时刻(epoch ms)。 */
  t: number
  /** 窗口百分比。 */
  p: number
  /** 本地归属 token 数。 */
  lt: number
  /** 本地归属成本(USD)。 */
  lc: number
  /** 窗口重置时刻(ISO)。 */
  r: string
  /** 窗口起点(epoch ms)。 */
  s: number
}

/** Plan 采样历史:provider → 窗口键 → 样本数组。 */
export type PlanSamples = Record<string, Record<string, PlanSample[]>>

/** provider×小时聚合桶:provider → 小时键(string) → { tokens, cost }。 */
export type PlanHourBuckets = Record<string, Record<string, { tokens: number; cost: number }>>

/** 账本结构快照(落盘形状;Ledger 类结构上满足该接口)。 */
export interface LedgerSnapshot {
  version?: number
  config: CostMeterConfig
  days: Record<string, DayRecord>
  balanceRef?: BalanceRef | null
  migrations?: string[]
  planSamples?: PlanSamples
  planHourBuckets?: PlanHourBuckets
  openrouterPriceHashes?: Record<string, string>
  historyReset?: { id: string; at: number } | null
}

// ── 配置 ──────────────────────────────────────────────────────────────────

/** 侧边栏模型花费卡片配置。 */
export interface SidebarModelsConfig {
  enabled: boolean
  period: string
  topN: number
  summary: string
  position: string
  defaultOpen: boolean
  remember: boolean
  tokens: boolean
  shares: boolean
  refreshSeconds: number
  dock: boolean
}

/** 预算配置(金额按展示币种)。 */
export interface BudgetConfig {
  enabled: boolean
  amount: number
  period: string
  customStart: string | null
  customEnd: string | null
  detail: boolean
}

/** 单家 Coding Plan 额度查询配置(各家按需增补私有字段)。 */
export interface CodingPlanConfig {
  enabled: boolean
  display: string
  refreshMinutes: number
  apiKey: string
  /** MiniMax 自定义站点。 */
  baseUrl?: string
  /** SCNet / Qwen 本地 Credits 计量。 */
  planCredits?: number
  planStart?: string
  /** Qwen 额度来源:local | cli | bailian。 */
  quotaSource?: string
  /** Qwen Credits 抵扣率表:归一模型名 → { input, cachedInput, output }。 */
  rates?: Record<string, { input: number; cachedInput: number; output: number }>
  /** 火山方舟管控面 AK/SK。 */
  accessKeyId?: string
  secretAccessKey?: string
}

/** 官方账户余额配置。 */
export interface BalanceConfig {
  display: string
  refreshMinutes: number
  showProgressBar: boolean
  budgetCap: number | null
  reconcile: boolean
  clickHintSeen: boolean
}

/** OpenCode Go 订阅额度配置。 */
export interface GoQuotaConfig {
  enabled: boolean
  display: string
  refreshMinutes: number
  apiKey: string
  main: string
  detail: boolean
}

/** 自定义余额提取规则(字符串路径或 { op, path/paths } 规则对象)。 */
export type ExtractRule = any
// TODO(types): 收紧为 string | { op: string; path?: string; paths?: (string | number)[] },
// 与 custom-balance.extractByRule 的入参分支一一对应。

/** 自定义 Provider 余额的 HTTP 请求配置。 */
export interface CustomBalanceRequest {
  url: string
  method: string
  headers: Record<string, string>
}

/** 自定义 Provider 余额的解析规则。 */
export interface CustomBalanceExtract {
  remaining: ExtractRule
  maxBudget: ExtractRule
  spend: ExtractRule
  unit: string
}

/** 自定义 Provider 余额配置(旧单配置与 customBalances[] 共用形状)。 */
export interface CustomBalanceConfig {
  enabled: boolean
  label: string
  labelEn: string
  display: string
  unit: string
  convertToDisplayCurrency: boolean
  refreshMinutes: number
  /** 内置适配器形态(如 'aliyun')时不需要 request/extract。 */
  adapter?: string
  request?: CustomBalanceRequest
  extract?: CustomBalanceExtract
  /** 凭据外带白名单(仅保留非空字符串)。 */
  allowedHosts?: string[]
  /** 旧版遗留字段(v1.5.x 单配置时代):余额进度条开关迁移来源。 */
  showProgressBar?: boolean
  /** 多配置形态 id(仅 customBalances[] 条目有)。 */
  id?: string
}

/** CLIProxyAPI 网关额度源配置。 */
export interface GatewayQuotaSource {
  id: string
  type: string
  label: string
  baseURL: string
  enabled: boolean
  display: string
  refreshMinutes: number
  includeProviders: string[]
  allowedHosts: string[]
  allowInsecureHttp: boolean
  antigravityOnlyGemini: boolean
}

/** 进度条填充语义:remaining = 满条起步随消耗递减;used = 空条起步随消耗填满。 */
export type BarDirection = 'remaining' | 'used'

/**
 * 插件配置(由 store.defaultConfig() 的默认值对象反推)。
 * 持久化副本经 sanitizeConfig 清洗后形状一致;缺键由默认值补齐。
 */
export interface CostMeterConfig {
  locale: string
  position: string
  sidebar: boolean
  currency: string
  symbol: string
  decimals: number
  /** 展示层:美元 → 币种汇率。 */
  exchangeRate: number
  /** 官方价格币种:'USD' | 'CNY'。 */
  pricingCurrency: string
  peakEnabled: boolean
  peakEffectiveAt: string
  peakWindows: PeakWindow[]
  peakHolidays: string[]
  peakNotice: boolean
  peakAlertEnabled: boolean
  peakAlertAhead: number
  peakAlertTarget: string
  peakAlertPosition: string
  peakAlertWebNotify: boolean
  showSessionId: boolean
  hideOfficialBalance: boolean
  hideTodayCost: boolean
  hideSessionCostHeader: boolean
  hideSessionCostDock: boolean
  hideTurnCost: boolean
  sessionCostCompact: boolean
  contextCostsEnabled: boolean
  contextCostsPromptSeen: boolean
  statisticsBasis: string
  sidebarTodayMetric: string
  showTotalWithPlan: boolean
  includeSubagentCost: boolean
  codexQuotaEnabled: boolean
  codexQuotaSidebar: boolean
  sidebarSimple: boolean
  sidebarSimplePromptSeen: boolean
  sidebarModels: SidebarModelsConfig
  sidebarStyle: string
  /** 安装前历史自动导入标记(0 = 尚未跑过)。 */
  legacyAutoImportedAt: number
  peakStyle: string
  priceMatch: string
  priceMatchDismissed: string[]
  priceOverrides: Record<string, string>
  priceTableDisplay: Record<string, boolean>
  prices: PriceTable
  budget: BudgetConfig
  codingPlans: Record<string, CodingPlanConfig>
  balance: BalanceConfig
  goQuota: GoQuotaConfig
  /** 旧单配置(仅供迁移读取)。 */
  customBalance: CustomBalanceConfig
  /** 多配置形态(v1.7.0 起运行期真源)。 */
  customBalances: CustomBalanceConfig[]
  gatewayQuotas: { sources: GatewayQuotaSource[] }
  corner: { enabled: boolean; goRolling: boolean; goWeekly: boolean; goMonthly: boolean; budget: boolean }
  quotaStrip: { enabled: boolean; budget: boolean; go: boolean; plans: boolean; promptSeen: boolean }
  barDirections: { balance: BarDirection; budget: BarDirection; go: BarDirection; plan: BarDirection }
  usage: { position: string }
  planBilling: { providers: Record<string, string>; models: Record<string, string> }
  historyDays: number
  /** 最近一次官方价格同步时间(ISO)或 null。 */
  fetchedAt: string | null
  priceSource: string
}

// ── 其它宿主侧公共形状 ────────────────────────────────────────────────────

/** 带业务错误码的 Error(宿主侧大量 `error.code = 'XXX'` 用法)。 */
export interface CodedError extends Error {
  code?: string
  /** 软错误标记:只提示、不中断流程。 */
  soft?: boolean
  /** 余额 401:提示重新配置开放平台 Key。 */
  balanceUnauthorized?: boolean
  /** 余额查询失败可重试(与守卫型 soft 错误相对)。 */
  balanceRetry?: boolean
}
