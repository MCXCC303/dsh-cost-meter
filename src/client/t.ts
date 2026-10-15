/**
 * 客户端共享基座:语言解析、翻译函数、样式注入。
 *
 * 迁移自原 01-open-styles-i18n 片段末尾的工具部分;`styles.ts` 提供 CSS 文本,
 * `i18n-messages.ts` 提供词典,这里只保留可执行的逻辑。
 */
import { MESSAGES } from './i18n-messages.js'
import { css } from './styles.js'

/** Token 用量统计的显示位置切换(通用设置 / 独立分节)暂时隐藏:仅固定在「费用」设置分节内。 */
export const USAGE_POSITION_SWITCHABLE = false

/** 浏览器语言偏好:取第一个受支持的语言,否则回落 zh。 */
export function detectBrowserLocale(): 'zh' | 'en' {
  const raw = typeof navigator === 'undefined' ? '' : navigator.language ?? ''
  return raw.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/**
 * 受支持的语言集合:大小写不敏感、忽略地区后缀,非法值返回 null。
 * 例:`zh-CN` / `EN` / `en_US` → `zh` / `en` / `en`。
 * (与旧片段同语义——`meta.locale` 常带地区后缀,严格相等会误判。)
 */
export function supportedLocale(value: unknown): 'zh' | 'en' | null {
  const lang = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : ''
  return lang === 'zh' || lang === 'en' ? lang : null
}

/** 解析当前应使用的语言:显式配置 > 浏览器偏好。 */
export function resolveLocale(config: { activeLocale?: unknown } | null | undefined): 'zh' | 'en' {
  return supportedLocale(config?.activeLocale) ?? detectBrowserLocale()
}

/** 取翻译函数:{name} 占位符替换;缺失键回落 en,再回落键名。 */
export function makeT(locale: 'zh' | 'en') {
  const dict = MESSAGES[locale] ?? {}
  const fallback = MESSAGES.en ?? {}
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dict[key] ?? fallback[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
  }
}

/** 期间键 → 词典键(预算周期标签)。 */
export const PERIOD_KEYS: Record<string, string> = {
  day: 'periodDay', month: 'periodMonth', all: 'periodAll', custom: 'periodCustomRange',
}

/**
 * 注入样式表:按内容比对,内容一致复用旧节点(兼容客户端热更新换代码),
 * 内容陈旧时就地更新。返回已注入的节点。
 */
export function createStyleTag(doc: Document = document): HTMLStyleElement | null {
  const id = 'dsh-cost-meter/client.css'
  const text = css
  // 宿主/测试可能提供没有 head 的最小 document 桩;此时无法注入,直接放弃。
  if (doc === undefined || doc.createElement === undefined || doc.head === undefined || doc.head === null) return null
  const existing = doc.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null && existing.textContent === text) return existing
  const node = existing ?? doc.createElement('style')
  node.dataset.pluginCss = id
  node.textContent = text
  if (existing === null) doc.head.appendChild(node)
  return node
}
