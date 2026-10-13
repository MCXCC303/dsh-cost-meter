// Real React preview plus browser interaction checks; all data is synthetic.
// 用法: node test/statistics-layout.mjs [--wait] [--browser=<exe>] [--timeout=<ms>]
//   react / react-dom 默认取仓库本地 node_modules(devDeps 已装);本地解析不到时,
//   可用位置参数目录或 DSH_TEST_NODE_MODULES 兜底。
//   --wait  自己启动无头浏览器(Chrome/Chromium/Edge)打开本页,等页面把结果回报到
//           /report 后按退出码结束(全过 0 / 失败或超时 1);浏览器取自 --browser,
//           其次 CM_TEST_BROWSER,再按 PATH 与常见安装路径探测。
//   不加 --wait 时打印地址常驻服务供人工核对,页面同样会自动跑一遍并把结果回报到控制台。
//
// 注:原先第 3 条 check 断言 `.cm-stat-share-list === 3`。该断言自 ae9ae91(引入本用例)
// 起未再更新,而统计 UI 后来把三个 ShareChart 收敛成「一个 ShareChart + CostBreakdown/
// costCard」三个分区;用旧源码与现产物分别渲染后 DOM 完全一致(share-list 均为 1 个),
// 说明这是**用例陈旧**,不是产物回归。现改为按语义断言三个分区都在(composition /
// types / all-step shares,中英各一套文案)+ share-list 至少 1 个,断言强度不降。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { sanitizeConfig } from '../lib/store.js'
const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const positional = args.filter(arg => !arg.startsWith('--'))
const explicitBrowser = (args.find(arg => arg.startsWith('--browser=')) ?? '').slice('--browser='.length)
const waitForBrowser = args.includes('--wait')
const timeoutMs = Number((args.find(arg => arg.startsWith('--timeout=')) || '').split('=')[1] || (waitForBrowser ? 180000 : 120000))
// 布局回归直接跑构建产物(旧 src/statistics/index.js 片段已删):产物自带
// `window.__ModuleLoader__.load({ chunk, factory })` 注册壳,这里按平台 classic-script
// 语义执行它,再用种子 require 调 factory(平台的 require 只在 factory 调用时可用)。
const artifact = readFileSync(resolve(root, 'lib/client.statistics.js'), 'utf8')
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
let factory;window.__ModuleLoader__={load:m=>factory=m.factory};new Function(${JSON.stringify(artifact)})();
const seeds=id=>id==='react'?React:id==='react-dom'?{createPortal}:id==='@deepseek-ai/dsh-client-ui-primitives'?{Tooltip:'Tooltip'}:(()=>{throw new Error('missing seed '+id)})();
const ui=factory(seeds),params=new URLSearchParams(location.search),locale=params.get('locale')||'zh';
const bucket={input:39001,output:51899,cacheRead:1275904,cacheWrite:0,reasoning:0,calls:28,cost:0.2722,apiCost:0.2722};
const costRows=[['input',39001,1],['output',51899,4],['cacheRead',1275904,.02]].map(([bucket,tokens,rate])=>({provider:'deepseek',model:'deepseek-v4-flash',bucket,tokens,rate,cost:tokens*rate/1e6,priced:true,plan:false}));
const calls=Array.from({length:28},(_,i)=>({kind:i<26?'model':'search',turn:i<26?2:null,step:i<26?i+1:null,provider:'deepseek',model:'deepseek-v4-flash',atMs:1790762400000+i*10000,cost:bucket.cost/28,apiCost:bucket.cost/28,plan:false,priced:true,longContext:false,rows:costRows}));
const turns=[{...bucket,turn:1,cost:.00597,apiCost:.00597,calls:1},{...bucket,turn:2,cost:.26623,apiCost:.26623,calls:27}];
const shares=Array.from({length:8},(_,i)=>({...bucket,turn:2,step:i+1,other:false,unpriced:false,cost:bucket.cost*(8-i)/36,apiCost:bucket.cost*(8-i)/36,calls:i+1}));
const detail={found:true,...bucket,rows:costRows,calls,totalCalls:28,offset:0,recorded:bucket,kinds:[{...bucket,kind:'model',calls:26,unpriced:false},{...bucket,kind:'search',calls:2,unpriced:false}],turns,totalTurns:2,turnOffset:0,stepShares:{cost:shares,calls:shares.map((s,i)=>({...s,calls:i===7?0:i+1}))}};
detail.agents=[{...bucket,id:'s',title:'Main conversation',cost:.00597,apiCost:.00597,calls:1},{...bucket,id:'child',title:locale==='zh'?'验证桌面端布局的子代理':'Desktop layout verification subagent',cost:.26623,apiCost:.26623,calls:27}];
turns.forEach((row,i)=>row.sessionId=i?'child':'s');calls.forEach((row,i)=>row.sessionId=i?'child':'s');shares.forEach(row=>row.sessionId='child');
const inspection={found:true,turn:2,input:locale==='zh'?'做一个简单的网页，增加夜间模式，并确认窄窗口中的内容没有溢出。':'Build a simple website with dark mode and verify its layout in a narrow window.',inputTruncated:false,tools:[{seq:1,step:1,name:'read_file',callId:'c1',atMs:1790762400000,arguments:JSON.stringify({path:'src/index.html'},null,2),result:'<main>Welcome</main>',status:'complete',truncated:false},{seq:2,step:2,name:'exec_command',callId:'c2',atMs:1790762400000,arguments:JSON.stringify({command:'npm run build'},null,2),result:'Build completed successfully. 28 modules transformed.',status:'complete',truncated:false}],offset:0,totalTools:2};
const api={getBillingStatistics:async()=>({from:'2026-09-24',to:'2026-09-30',retainedFrom:'2026-08-14',retainedTo:'2026-09-30',totals:bucket,days:Array.from({length:7},(_,i)=>({...bucket,date:'2026-09-'+(24+i),cost:bucket.cost*(i+1)/28,apiCost:bucket.cost*(i+1)/28})),models:[{...bucket,key:'deepseek:deepseek-v4-flash',provider:'deepseek',model:'deepseek-v4-flash',priced:true}],sessions:[{...bucket,id:'s',title:locale==='zh'?'做一个简单的网页':'Build a simple website'}],providers:['deepseek'],modelOptions:['deepseek-v4-flash'],sessionCount:1,offset:0,unassignedCost:0,unmodeledCost:0}),getSessionBilling:async()=>detail,getTurnInspection:async q=>({...inspection,turn:q.turn})};
createRoot(document.getElementById('root')).render(React.createElement(ui.Statistics,{state:{config:{...${JSON.stringify(sanitizeConfig({}))},locale},meta:{dayKey:'2026-09-30',timezone:'Asia/Shanghai',now:1}},api,sessionId:'s',formatMoneyUsd:n=>'¥'+n.toFixed(n&&n<.01?6:4),formatTokens:n=>n>1000?(n/1000).toFixed(1)+'K':String(n)}));`
// react/react-dom 优先用仓库本地 node_modules(devDeps 已装);仅当本地解析不到时才用
// 位置参数目录 / DSH_TEST_NODE_MODULES 兜底。
const localReact = (() => { try { createRequire(join(root, 'package.json')).resolve('react'); return true } catch (error) { return false } })()
const hostModules = positional[0] ?? process.env.DSH_TEST_NODE_MODULES
if (!localReact && !hostModules) throw new Error('react 不可解析:请在仓库根安装依赖,或用 [node_modules 目录] / DSH_TEST_NODE_MODULES 指定')
const nodePaths = !localReact && hostModules ? { nodePaths: [resolve(hostModules)] } : {}
const bundle = await build({ stdin: { contents: entry, loader: 'js', resolveDir: root }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, ...nodePaths })

// ── 无头浏览器:让本回归在 CI 里可判定(不引入 Playwright/Puppeteer,驱动已有浏览器)──
const BROWSER_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'msedge', 'microsoft-edge']
const BROWSER_PATHS = process.platform === 'win32'
  ? [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome', '/snap/bin/chromium']
function findBrowser() {
  const explicit = explicitBrowser || process.env.CM_TEST_BROWSER || ''
  if (explicit) return existsSync(explicit) ? explicit : null
  for (const candidate of BROWSER_PATHS) if (candidate && existsSync(candidate)) return candidate
  for (const name of BROWSER_NAMES) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      const file = join(dir, process.platform === 'win32' ? name + '.exe' : name)
      if (existsSync(file)) return file
    }
  }
  return null
}
let browserProcess = null, browserProfile = null, reported = false
function cleanupBrowser() {
  try { browserProcess?.kill() } catch (error) { /* 已退出 */ }
  try { if (browserProfile !== null) rmSync(browserProfile, { recursive: true, force: true }) } catch (error) { /* 清理失败不影响结论 */ }
}
process.on('exit', () => { try { cleanupBrowser() } catch (error) { /* 退出路径上的清理失败无需上报 */ } })
function launchBrowser(url) {
  const executable = findBrowser()
  if (executable === null) {
    console.log('FAIL no headless browser found: pass --browser=<exe> or set CM_TEST_BROWSER (tried PATH and common install paths)')
    cleanupBrowser()
    process.exit(1)
  }
  // 独立的 user-data-dir:复用正在运行的桌面浏览器配置会直接被拒绝启动。
  browserProfile = mkdtempSync(join(tmpdir(), 'cm-statistics-layout-'))
  browserProcess = spawn(executable, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--user-data-dir=' + browserProfile, url], { stdio: 'ignore' })
  browserProcess.on('error', error => { console.log('FAIL browser launch failed: ' + error.message); cleanupBrowser(); process.exit(1) })
  browserProcess.on('exit', code => { if (!reported) console.log('browser exited before reporting (code ' + code + ')') })
}
const cases = [360, 768, 1100].flatMap(width => ['zh', 'en'].flatMap(locale => ['light', 'dark'].map(theme => ({ width, locale, theme }))))
const page = `<!doctype html><meta charset="utf-8"><title>Statistics UI regression</title><style>body{font:14px system-ui}iframe{height:720px;border:1px solid #ddd}section{margin:20px}</style><h1>Statistics UI · synthetic fixtures</h1><button id="run">Run regression</button><p role="status" id="result">Ready</p>${cases.map(c=>`<section>${c.width} ${c.locale} ${c.theme}<br><iframe title="${c.width}-${c.locale}-${c.theme}" width="${c.width}" src="/case?locale=${c.locale}&theme=${c.theme}"></iframe></section>`).join('')}
<script>const frames=[...document.querySelectorAll('iframe')],waitFor=(fn,timeout=8000)=>{const deadline=Date.now()+timeout;return new Promise((res,rej)=>{const tick=()=>{let v=false;try{v=fn()}catch(e){}if(v)return res();if(Date.now()>deadline)return rej(Error('timeout waiting for iframe content'));setTimeout(tick,50)};tick()})},report=tag=>{try{fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag})}).catch(()=>{})}catch(e){}};
const run=async()=>{let count=0,tag='';const check=(v,m)=>{count++;if(!v)throw Error(m)},wait=()=>new Promise(r=>setTimeout(r,50));try{await Promise.all(frames.map(f=>waitFor(()=>f.contentDocument?.querySelector?.('.cm-stat-share-list'))));for(const f of frames){const d=f.contentDocument,w=f.contentWindow;check(d.documentElement.scrollWidth<=w.innerWidth,f.title+' no page overflow');check(d.querySelectorAll('.cm-stat-metric').length===4,f.title+' four metrics');check(d.querySelectorAll('.cm-stat-share-list').length>=1&&(f.title.split('-')[1]==='en'?['Cost composition','Cost by activity','Share by step']:['费用构成','各环节费用占比','各步骤占比']).every(title=>d.body.textContent.includes(title)),f.title+' composition, types and all-step shares');check(!d.querySelector('.cm-stat-inspection'),f.title+' inspection stays lazy');d.querySelector('.cm-stat-turn-toggle').click();await wait();check(!!d.querySelector('.cm-stat-inspection'),f.title+' turn opens');check(d.querySelector('.cm-stat-pre').textContent.length>10,f.title+' user input');const tool=d.querySelector('.cm-stat-tool');tool.open=true;check(tool.textContent.includes('src/index.html'),f.title+' tool arguments');check(tool.textContent.includes('<main>Welcome</main>'),f.title+' escaped tool result');check(!tool.querySelector('main'),f.title+' result is never interpreted as HTML');d.querySelector('.cm-stat-turn-toggle').click();await wait();check(!d.querySelector('.cm-stat-inspection'),f.title+' turn closes');check(d.documentElement.scrollWidth<=w.innerWidth,f.title+' still no page overflow');}tag='PASS '+count+' assertions';}catch(e){tag='FAIL '+count+' '+e.message}document.getElementById('result').textContent=tag;document.title='RESULT:'+tag;report(tag)};
document.getElementById('run').onclick=run;run()</script>`
const server = createServer((request, response) => {
  if (request.url === '/entry.js') { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(bundle.outputFiles[0].text); return }
  // 页面把断言结果回传到这里:--wait 模式下据此决定退出码,人工模式下只打印。
  if (request.url === '/report') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let tag = 'FAIL unparsable report'
      try { tag = String(JSON.parse(body).tag || tag) } catch (error) { /* 保留 FAIL 标记 */ }
      reported = true
      console.log(tag)
      response.end('ok')
      if (waitForBrowser) { server.close(); cleanupBrowser(); process.exit(tag.startsWith('FAIL') ? 1 : 0) }
    })
    return
  }
  response.setHeader('content-type','text/html; charset=utf-8')
  const dark = request.url.includes('theme=dark')
  response.end(request.url.startsWith('/case') ? `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${dark?'dark':'light'};--dsw-alias-label-primary:${dark?'#ececef':'#25262b'};--dsw-alias-label-tertiary:${dark?'#9597a1':'#858a94'};--dsw-alias-bg-base:${dark?'#202124':'#fff'};--dsw-alias-bg-layer-1:${dark?'#27282d':'#f7f8fa'};--dsw-alias-bg-layer-2:${dark?'#292b30':'#f5f6f8'};--dsw-alias-border-l1:${dark?'#35373e':'#eceef0'};--dsw-alias-border-l3:${dark?'#35373e':'#e9eaed'};--dsw-alias-state-business-primary:${dark?'#8096ff':'#4d6bfe'};--dsw-alias-interactive-bg-hover:${dark?'#32343a':'#eff0f3'};--ds-font-family-sans:Arial,'Microsoft YaHei',sans-serif}body{margin:0;background:var(--dsw-alias-bg-base);font-family:var(--ds-font-family-sans)}#root{padding:24px;max-width:1160px;margin:auto;box-sizing:border-box}@media(max-width:600px){#root{padding:14px}}</style><div id="root"></div><script src="/entry.js"></script>` : page)
})
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port
  console.log(url)
  if (waitForBrowser) launchBrowser(url)
})
if (waitForBrowser) setTimeout(() => { console.log('FAIL timeout: no report within ' + timeoutMs + 'ms'); cleanupBrowser(); process.exit(1) }, timeoutMs).unref()
