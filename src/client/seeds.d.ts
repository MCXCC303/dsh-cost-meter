/**
 * 平台种子模块与全局挂载点的类型声明。
 *
 * 本文件**不能**出现 `import` / `export`:一旦成为模块,`declare module 'react'`
 * 会退化成"模块增补"(augmentation),而 `react` 本身并不存在,声明随即失效。
 * 保持脚本(script)形态才能作为环境声明生效。
 *
 * 浏览器半由宿主提供两个种子模块;仓库不安装它们(避免把 React 打进产物、
 * 也避免版本漂移)。这里给出最小可用声明。
 *
 * TODO(types): 后续可改为 devDependency 安装 `@types/react` 与真实的
 * dsh-client-ui-primitives 类型;当前以 any 兜底,优先保证迁移期不被阻塞。
 */
declare module 'react' {
  /** React 命名空间(createElement / Fragment / useState / useEffect / useRef 等)。 */
  const React: any
  export default React
}

declare module 'react-dom' {
  /** 宿主提供的 react-dom(createPortal 等)。 */
  const ReactDOM: any
  export function createPortal(children: any, container: any, key?: any): any
  export function createRoot(container: any): any
  export default ReactDOM
}

declare module 'react/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 宿主提供的 Tooltip 组件(悬停提示)。 */
  export const Tooltip: any
}

/**
 * 插件在 window 上暴露的调试/预览通道与平台注入点。
 *
 * TODO(types): 这些由插件运行期自行挂载,后续可收敛成正式接口并逐个标注签名。
 */
interface Window {
  /** 预览峰/谷切换弹窗:`window.cmPeakAlertPreview('peak' | 'offpeak')`。 */
  cmPeakAlertPreview?: (kind?: 'peak' | 'offpeak') => void
  /** 弹窗组件是否已挂载(供预览 API 判断宿主可用性)。 */
  __cmPeakAlertLive?: boolean
  /** 平台注入的模块加载器入口。 */
  __ModuleLoader__?: {
    load(registration: { id: string; chunk?: string; factory: (require: any) => Record<string, unknown> }): void
  }
}
