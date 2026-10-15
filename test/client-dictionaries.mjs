// The emitted runtime dictionaries must match the readable source, not just the source.
//
// 旧实现由 build.mjs 把词典压成 `Object.fromEntries([["zh", …]])`;新构建(esbuild 直接
// 打包模块)把 `MESSAGES` 原样内联成 `{zh:{…},en:{…}}`,不再有打包步骤。所以这里不再
// 拼接旧片段,而是:源码侧现场打包 `src/client/i18n-messages.ts` 取 `MESSAGES`,产物侧
// 从 `lib/client.js` 里定位并求值那个对象字面量 —— 断言不变:两个 locale 的每个 key/value
// 都必须与可读源码一致。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const runtime = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 定位并求值产物里内联的 `MESSAGES` 字面量(跳过字符串里的花括号)。 */
function locateDictionary(code) {
  const at = code.indexOf('{zh:{')
  if (at < 0) return null
  let depth = 0, quote = null
  for (let i = at; i < code.length; i++) {
    const ch = code[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return code.slice(at, i + 1)
  }
  return null
}

const dictionary = locateDictionary(runtime)
assert.ok(dictionary, 'locate generated dictionaries')
const emitted = JSON.parse(JSON.stringify(new Function('return (' + dictionary + ')')()))

/** 打包客户端源码模块并取回导出(NodeNext 的 `.js` 后缀导入只有打包器能解析)。 */
async function clientExports(entry) {
  const result = await build({
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    () => { throw new Error('i18n-messages.ts 没有种子模块依赖') }, module, module.exports)
  return module.exports
}

const { MESSAGES } = await clientExports(`export { MESSAGES } from './i18n-messages.js'`)
const original = JSON.parse(JSON.stringify(MESSAGES))
assert.deepEqual(emitted, original, 'every locale/key/value in emitted bundle must match readable source')
console.log('[ok] lossless client dictionaries:', Object.keys(original.zh).length, 'zh +', Object.keys(original.en).length, 'en translations')
