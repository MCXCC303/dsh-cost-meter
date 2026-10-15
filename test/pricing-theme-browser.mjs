// #258: exercise the real settings selectors with a dark skin over a light host.
// Chromium exposes native option colors here; this fixture is not a full DSH app.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { sanitizeConfig, zeroDay } from '../lib/store.js'
import { javascriptLiteral as literal } from '../scripts/javascript-literal.mjs'

const uiModules = resolve(process.env.DSH_TEST_UI_MODULES ?? process.env.DSH_TEST_NODE_MODULES ?? '.tmp-context-host/node_modules')
const req = createRequire(join(uiModules, '__pricing_theme.cjs'))
const browserReq = createRequire(join(resolve(process.env.DSH_TEST_BROWSER_MODULES ?? uiModules), '__pricing_theme.cjs'))
const { chromium } = browserReq('playwright-core')
const executablePath = process.env.CM_TEST_BROWSER ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
assert.ok(executablePath, 'a local Chromium browser is required')
const baseline = process.argv.includes('--baseline') ? process.argv[process.argv.indexOf('--baseline') + 1] : null
// 客户端实现来自构建产物(旧 src/client/*.js 片段已删):设置面板在按需分块
// lib/client.settings.js 里,按平台 classic-script 语义执行它并取回 CostSection;
// parseConfig 未从任何产物导出,故由打包器直接取 src/client/logic.ts 的同一实现
// (onLoad 追加一条等价 export,实现零改动)。
const readArtifact = file => baseline
  ? execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
  : readFileSync(file, 'utf8')
// 样式表(.cm-input option 主题色)由启动包模块体注入,故两个产物都要执行:
// client.js 负责 createStyleTag(与线上同源),client.settings.js 提供 CostSection。
const startupArtifact = readArtifact('lib/client.js')
const settingsArtifact = readArtifact('lib/client.settings.js')
const logicPath = resolve('src/client/logic.ts')
const day = { ...zeroDay('2026-10-12'), byProviderModel: {
  'fixture:unknown': { input: 1, output: 1, calls: 1, cost: 0 },
  'deepseek:deepseek-v4-flash': { input: 1, output: 1, calls: 1, cost: .001 },
} }
const initialState = { config: sanitizeConfig({ locale: 'zh' }), today: day, month: day, total: day, history: [], balance: {} }
const code = `
import React from ${literal(req.resolve('react'))};
import * as ReactDOM from ${literal(req.resolve('react-dom'))};
import {createRoot} from ${literal(req.resolve('react-dom/client'))};
import { parseConfig } from ${literal(logicPath)};
const seeds=id=>id==='react'?React:id==='react-dom'?ReactDOM:id==='@deepseek-ai/dsh-client-ui-primitives'?{Tooltip:({children})=>children}:(()=>{throw new Error('missing seed '+id)})();
let startupFactory;window.__ModuleLoader__={load:mod=>startupFactory=mod.factory};
new Function(${literal(startupArtifact)})();
startupFactory(seeds);
let factory;window.__ModuleLoader__={load:mod=>factory=mod.factory};
new Function(${literal(settingsArtifact)})();
const {CostSection}=factory(seeds);
const state=${literal(initialState)};state.config=parseConfig(state.config,'config');
window.patches=[];
const api={loadOpenRouter:async()=>()=>null,updateConfig:async patch=>{window.patches.push(patch)}};
createRoot(document.getElementById('root')).render(React.createElement(CostSection,{useCost:()=>({state,status:'ready'}),api}));
window.fixtureReady=true;
`
const compiled = await build({
  stdin: { contents: code, resolveDir: process.cwd(), loader: 'js' },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  plugins: [{
    name: 'expose-parse-config',
    setup(build_) {
      build_.onLoad({ filter: /logic\.ts$/ }, args => ({
        contents: readFileSync(args.path, 'utf8') + '\nexport { parseConfig }\n',
        loader: 'ts',
      }))
    },
  }],
})
// Token values copied from the published skin source, with provenance pinned.
// https://github.com/RevolutionLA/dsh-dream-skin/blob/86761e4106874f3c0646c74f95a1a2d252c4b9ce/lib/client.js
const light = { '--dsw-alias-label-primary': '#25262b', '--dsw-alias-label-secondary': '#737780', '--dsw-alias-label-tertiary': '#858a94', '--dsw-alias-bg-base': '#fff', '--dsw-alias-bg-layer-1': '#f7f8fa', '--dsw-alias-border-l1': '#e5e7eb', '--dsw-alias-button-elevated-fill': '#fff', '--dsw-alias-state-business-primary': '#4d6bfe' }
const midnight = { '--dsw-alias-label-primary': '#eff0f1', '--dsw-alias-label-secondary': '#c0c1c2', '--dsw-alias-label-tertiary': '#a3a4a5', '--dsw-alias-bg-base': '#0b0b0c', '--dsw-alias-bg-layer-1': '#141415', '--dsw-alias-border-l1': 'rgba(255,255,255,.062)', '--dsw-alias-button-elevated-fill': '#141415', '--dsw-alias-state-business-primary': '#889ef6' }
const dark = { ...midnight, '--dsw-alias-label-primary': '#ececee', '--dsw-alias-bg-base': '#202022', '--dsw-alias-bg-layer-1': '#29292c' }
const html = '<!doctype html><html style="color-scheme:light"><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.5 system-ui}#root{max-width:900px;margin:auto}</style></head><body><div id="root"></div><select id="host-control"><option>Host control</option><option>Other plugin</option></select><script src="/app.js"></script></body></html>'
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end(compiled.outputFiles[0].contents) }
  else if (request.url === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html) }
  else { response.statusCode = 404; response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 950 } })
const errors = [], external = [], checks = []
page.on('pageerror', error => errors.push(String(error)))
await page.route('**/*', route => {
  if (new URL(route.request().url()).origin !== new URL(url).origin) { external.push(route.request().url()); return route.abort() }
  return route.continue()
})
const luminance = color => {
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
  })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}
const output = resolve('.tmp-pricing-theme-browser'); mkdirSync(output, { recursive: true })
try {
  await page.goto(url); await page.waitForFunction(() => window.fixtureReady)
  await page.getByRole('tab', { name: '价格', exact: true }).click()
  await page.locator('.cm-match-row select').first().waitFor()
  assert.equal(await page.locator('.cm-match-row select').count(), 2, 'unknown and matched model selectors are both rendered')
  for (const [theme, tokens, scheme] of [['midnight-light-host', midnight, 'light'], ['host-dark', dark, 'dark'], ['host-light', light, 'light']]) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.evaluate(({ tokens, scheme }) => {
      document.documentElement.style.colorScheme = scheme
      for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
    }, { tokens, scheme })
    await page.mouse.move(0, 0)
    const colors = await page.locator('select.cm-input').evaluateAll(selects => selects.map(select => ({
      color: getComputedStyle(select).color, background: getComputedStyle(select).backgroundColor,
      options: [...select.options].map(option => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor })),
    })))
    assert.ok(colors.length >= 4 && colors.every(select => select.options.length > 1), 'pricing choices are present')
    for (const select of colors) for (const option of select.options) {
      assert.equal(option.background, select.background, `${theme}: every unhovered native option has the theme background`)
      assert.equal(option.color, select.color, `${theme}: every unhovered native option has the theme text color`)
      const values = [luminance(option.color), luminance(option.background)].sort((a, b) => a - b)
      assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, `${theme}: option text stays readable`)
    }
    const model = page.locator('.cm-match-row select').first()
    const before = await model.evaluate(select => [...select.options].map(option => getComputedStyle(option).backgroundColor))
    await model.hover(); await page.mouse.move(0, 0)
    assert.deepEqual(await model.evaluate(select => [...select.options].map(option => getComputedStyle(option).backgroundColor)), before, 'leaving hover preserves readable option colors')
    assert.equal(await page.locator('#host-control option').first().evaluate(option => getComputedStyle(option).backgroundColor), 'rgba(0, 0, 0, 0)', 'the fix leaves host and other plugins outside cm-input untouched')
    if (theme === 'midnight-light-host') {
      await model.click()
      await page.screenshot({ path: join(output, 'midnight-popup.png') })
      await page.keyboard.press('Escape')
    }
    await page.screenshot({ path: join(output, theme + '.png'), fullPage: true })
    checks.push({ theme, selectors: colors.length, options: colors.reduce((sum, select) => sum + select.options.length, 0) })
  }
  const model = page.locator('.cm-match-row select').first()
  await model.selectOption('__local__')
  await page.waitForFunction(() => window.patches.length === 1)
  assert.deepEqual(await page.evaluate(() => window.patches[0]), { priceOverrides: { 'fixture:unknown': '__local__' } }, 'the actual dropdown still saves only the chosen model override')
  assert.deepEqual(external, [], 'theme test sends no external requests')
  assert.deepEqual(errors, [], 'settings render without browser errors')
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, baseline, errors, external }, null, 2) + '\n')
  console.log(JSON.stringify({ checks, selectionSaved: true, browserErrors: errors.length, externalRequests: external.length }))
} catch (error) {
  console.error(JSON.stringify({ browserErrors: errors, styles: await page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].filter(rule => rule.selectorText?.includes('option')).map(rule => rule.cssText))), sample: await page.locator('select.cm-input').evaluateAll(selects => selects.map(select => ({html: select.outerHTML.slice(0, 180), background: getComputedStyle(select).backgroundColor, options: [...select.options].slice(0,2).map(option=>({html:option.outerHTML,color:getComputedStyle(option).color,background:getComputedStyle(option).backgroundColor}))}))) }))
  throw error
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve))
}
