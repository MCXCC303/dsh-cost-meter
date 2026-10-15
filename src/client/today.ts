/**
 * 侧栏"今日"数值的共享格式化。
 *
 * 单独成模块是为了断开 `ui-sidebar`(页脚)与 `ui-quota`(额度卡)之间的循环依赖:
 * 预算图框内容(ui-quota)与页脚(ui-sidebar)都要用同一口径显示"今日"。
 */
import { displayCostOf, formatMoneyUsd, formatTokens } from './logic.js'

/** 今日指标:按配置显示 token 或金额(与页脚、预算图框同口径)。 */
export function sidebarTodayValue(today: any, config: any, t: (key: string) => string): string {
  return config.sidebarTodayMetric === 'tokens'
    ? formatTokens(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
      .reduce((sum, key) => sum + (Number(today?.[key]) || 0), 0)) + ' ' + t('tokensUnit')
    : formatMoneyUsd(displayCostOf(today, config), config)
}
