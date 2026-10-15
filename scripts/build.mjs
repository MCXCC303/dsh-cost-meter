#!/usr/bin/env node
/**
 * dsh-cost-meter 构建脚本。
 *
 * 本插件是自用分支,不受 DSH STORE 的 256 KiB 单文件限制,因此不再需要
 * "按文件名排序拼接片段 + 全量压缩 + 词典短语打包"那套产物技巧,改为
 * **真模块划分 + 按需分块**:
 *
 *   宿主(Node ESM,tsdown → 带 .d.ts)
 *     src/host/index.ts      → lib/index.js     Loader 行入口
 *     src/host/typert.ts     → lib/typert.js    客户端编解码清单
 *
 *   浏览器(classic script,esbuild bundle → 每个分块自包含)
 *     src/client/index.ts        → lib/client.js              启动包
 *     src/client/peak.ts         → lib/client.peak.js         动态峰谷样式(按需)
 *     src/client/settings.ts     → lib/client.settings.js     设置面板(按需)
 *     src/client/statistics.ts   → lib/client.statistics.js   计费统计(按需)
 *     src/client/openrouter.ts   → lib/client.openrouter.js   价格目录(按需)
 *
 * 为什么浏览器侧用 esbuild 而不是 tsdown:分块必须是 classic script(Harness 以
 * `<script src>` 引入并拼成 combo),而 rolldown/tsdown 不支持 IIFE 多入口代码分割;
 * esbuild 每个入口产出一个自包含 iife,正好匹配 `require.async('./client.x.js')`。
 *
 * 用法:
 *   node scripts/build.mjs            构建全部产物
 *   node scripts/build.mjs --host     仅宿主
 *   node scripts/build.mjs --client   仅浏览器
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as tsdown } from 'tsdown'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.includes('--host') ? 'host' : process.argv.includes('--client') ? 'client' : null

/** 浏览器分块:入口 → 产物名(产物名必须与 require.async 的路径一致)。 */
const CLIENT_CHUNKS = {
  client: 'src/client/index.ts',
  'client.peak': 'src/client/peak.ts',
  'client.settings': 'src/client/settings.ts',
  'client.statistics': 'src/client/statistics.ts',
  'client.openrouter': 'src/client/openrouter.ts',
}

/** 宿主额外导出入口(typert 清单)。 */
const HOST_ENTRIES = { index: 'src/host/index.ts', typert: 'src/host/typert.ts' }

const bytes = text => Buffer.byteLength(text, 'utf8')
const kb = n => (n / 1024).toFixed(1) + ' KiB'

async function buildHost() {
  await tsdown({
    cwd: projectRoot,
    entry: HOST_ENTRIES,
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    minify: true,
    clean: false,
    external: ['zod', /^@deepseek-ai\//],
  })
  for (const name of Object.keys(HOST_ENTRIES)) {
    const path = resolve(projectRoot, 'lib', `${name}.js`)
    if (!existsSync(path)) throw new Error(`host build did not emit lib/${name}.js`)
    console.log(`✓ lib/${name}.js ${kb(bytes(readFileSync(path, 'utf8')))}`)
  }
}

async function buildClient() {
  for (const [name, entry] of Object.entries(CLIENT_CHUNKS)) {
    const source = resolve(projectRoot, entry)
    if (!existsSync(source)) throw new Error(`missing client entry ${entry}`)
    // 关键:入口必须包进 `window.__ModuleLoader__.load({ factory })`。
    //
    // 平台的 `require` **只作为 factory 的入参**注入(全局没有 require),
    // 而 esbuild 的 iife + external 会把 `require("react")` 提升到 iife 顶层立即执行
    // → 脚本加载即抛 `Dynamic require of "react" is not supported`。
    // 因此这里用 cjs 格式(把 ESM import 编成 factory 内的 `require(...)` 调用),
    // 再用 banner/footer 套上注册壳;这就是 DSH 自家客户端插件产物的形态。
    const registration = name === 'client'
      ? `window.__ModuleLoader__.load({ id: "dsh-cost-meter", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
      : `window.__ModuleLoader__.load({ id: "dsh-cost-meter", chunk: "${name}.js", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
    const result = await esbuild({
      entryPoints: [source],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      charset: 'utf8',
      legalComments: 'none',
      banner: { js: registration },
      footer: { js: 'return module.exports; } });' },
      // 平台种子模块由宿主提供(经 factory 的 require),不内联。
      external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
      logLevel: 'warning',
    })
    const header = `// Generated from ${entry} by scripts/build.mjs; do not edit.\n`
    const output = header + result.outputFiles[0].text
    writeFileSync(resolve(projectRoot, 'lib', `${name}.js`), output)
    console.log(`✓ lib/${name}.js ${kb(bytes(output))}`)
  }
}

// 清理上一版分块产物,避免旧文件被 require.async 命中。
for (const name of readdirSync(resolve(projectRoot, 'lib'))) {
  if (/^client(\.[a-z]+)?\.js(\.map)?$/.test(name)) rmSync(resolve(projectRoot, 'lib', name), { force: true })
}

if (only !== 'client') await buildHost()
if (only !== 'host') await buildClient()
console.log('✓ 构建完成')
