/**
 * dsh-cost-meter 构建配置(tsdown)。
 *
 * 本插件是自用分支,不受 DSH STORE 的 256 KiB 单文件限制约束,因此不再需要
 * "按文件名排序拼接片段 + 全量压缩"的产物技巧,改为真正的模块划分:
 *
 *   * `src/host/index.ts`      → `lib/index.js`      宿主半:Loader 行入口
 *                                `lib/typert.js`     typert 清单(客户端编解码用)
 *   * `src/client/index.ts`    → `lib/client.js`     浏览器启动包:侧栏/徽章/峰谷条
 *   * `src/client/settings.ts` → `lib/client.settings.js`  设置分块(按需)
 *   * `src/client/statistics.ts` → `lib/client.statistics.js` 统计分块(按需)
 *   * `src/client/openrouter.ts` → `lib/client.openrouter.js` 价格目录分块(按需)
 *   * `src/client/peak.ts`     → `lib/client.peak.js` 动态峰谷样式分块(按需)
 *
 * 浏览器半必须是 **classic script**:Harness 以 `/plugins/<pkg>/client.js` 直接
 * `<script src>` 引入并拼接成 combo 脚本,注册方式固定为
 * `window.__ModuleLoader__.load({id, factory})`;factory 里的 `require` 只能解析
 * 平台种子模块(目前是 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`),
 * 分块由 `require.async('./client.<name>.js')` 取回。因此这里用 iife 格式,
 * 不用 esm(避免顶层 import/export 与 require 标识符冲突)。
 *
 * 产物提交进仓库:链接安装(`dsh plugin add <path>`)直接读 checkout,
 * git 安装时 pnpm 不允许跑构建脚本,所以 `lib/` 必须随仓库分发;
 * `npm run build` 是开发与 CI 步骤,CI 比对 `lib/` 与 `src/` 是否一致。
 */
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    // 宿主半 + typert 清单(Node ESM,由 cordis Loader 直接 import)。
    entry: { index: 'src/host/index.ts', typert: 'src/host/typert.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: false,
    // zod / dsh-* 是运行时依赖或宿主提供的 peer,不打进产物。
    external: ['zod', /^@deepseek-ai\//],
  },
  {
    // 浏览器启动包。
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    // 每个分块都是自包含的 classic script,不做跨入口代码分割。
    codeSplitting: false,
    external: ['react', /^@deepseek-ai\//],
  },
  {
    // 浏览器按需分块:名字必须保持 `client.<name>.js`,与 require.async 的路径一致。
    entry: {
      'client.peak': 'src/client/peak.ts',
      'client.settings': 'src/client/settings.ts',
      'client.statistics': 'src/client/statistics.ts',
      'client.openrouter': 'src/client/openrouter.ts',
    },
    outDir: 'lib',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    codeSplitting: false,
    external: ['react', /^@deepseek-ai\//],
  },
])
