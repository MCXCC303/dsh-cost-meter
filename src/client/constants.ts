/**
 * 客户端共享常量:模型花费卡片默认值、Coding Plan 厂商行等。
 *
 * 原先散落在 03-model-sidebar / 03-settings-panels-main 片段里,被配置规整(logic.ts)、
 * 设置分块与启动包卡片共用,迁到独立模块避免循环依赖与重复定义。
 */

/** 模型花费卡片默认配置(enabled/period/topN/…)。 */
export const MODEL_SIDEBAR_DEFAULTS = {
  enabled: false, period: 'today', topN: 5, summary: 'total', position: 'last',
  defaultOpen: false, remember: true, tokens: false, shares: true, refreshSeconds: 60, dock: false,
} as const

/**
 * Coding Plan 厂商行(11 家):设置分块(PlanQuotaCard)与启动包额度卡(ui-quota/ui-sidebar/guides)
 * 共用同一份,避免两处副本漂移。
 */
export const CODING_PLAN_ROWS = [
  { id: 'anthropic', labelKey: 'codingPlanAnthropic' },
  { id: 'zai', labelKey: 'codingPlanZai' },
  { id: 'minimax', labelKey: 'codingPlanMinimax' },
  { id: 'kimi', labelKey: 'codingPlanKimi' },
  { id: 'openrouter', labelKey: 'codingPlanOpenrouter' },
  { id: 'siliconflow', labelKey: 'codingPlanSiliconflow' },
  { id: 'commandcode', labelKey: 'codingPlanCommandcode' },
  { id: 'scnet', labelKey: 'codingPlanScnet' },
  { id: 'volcengine', labelKey: 'codingPlanVolcengine' },
  { id: 'qwen', labelKey: 'codingPlanQwen' },
  { id: 'mimo', labelKey: 'codingPlanMimo' },
]
