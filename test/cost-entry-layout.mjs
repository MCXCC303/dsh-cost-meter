// Browser regression for #214. Run with:
//   node test/cost-entry-layout.mjs [node_modules dir] [--wait] [--browser=<exe>]
//   --wait  自己启动无头浏览器跑完整套用例,等页面把结果回报到 /report 后按退出码结束
//           (全过 0 / 失败或超时 1);不加 --wait 时打印地址常驻服务供人工核对。
// 页面在 ?autorun=1 时自动跑一遍(人工模式下点 Run regression 亦可)。
//
// 迁移说明:旧实现在页面里内联拼接 src/client/*.js 片段并注入
// `exports.preview = { SessionStatisticsButton, CornerChips }`。片段已删,现改为按平台
// classic-script 语义执行构建产物 lib/client.js,再走**真实激活路径**(apply(ctx) → slots
// 注册)取回两个组件 —— 与线上注册同源,顺带覆盖注册本身。
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
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
const clientArtifact = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {createPortal, flushSync} from 'react-dom';
let factory;window.__ModuleLoader__={load:m=>factory=m.factory};
new Function(${JSON.stringify(clientArtifact)})();
const seeds=id=>id==='react'?React:id==='react-dom'?{createPortal,flushSync}:id==='@deepseek-ai/dsh-client-ui-primitives'?{Tooltip:({children})=>React.createElement(React.Fragment,null,children)}:(()=>{throw new Error('missing seed '+id)})();
const main=factory(seeds);
const locale=new URLSearchParams(location.search).get('locale')||'zh';
const config={...${JSON.stringify(sanitizeConfig({ corner: { enabled: true, budget: true }, budget: { enabled: true, amount: 100 } }))},locale};
const state={config,today:{cost:1},month:{cost:1},total:{cost:1},history:[],balance:{status:'off'},goQuota:{status:'off'},codingPlans:{},gatewayQuotas:{sources:[]}};
const registrations=new Map();
const slots={inject:(_,cb)=>{cb()},register:(options,component)=>{registrations.set(options.name+':'+options.id,component);return()=>{}},entries:()=>[]};
const rpc={getLocalState:async()=>({ok:true,value:state}),getState:async()=>({ok:true,value:state})};
const ready=main.apply({remote:{$mount:async()=>()=>{}},get:n=>n==='remote.costMeter'?rpc:n==='slots'?slots:undefined,effect:fn=>fn(),on:()=>()=>{}});
const props={sessionId:'synthetic',useCost:()=>({state:{config,budgetUsed:0}}),api:{loadStatistics:async()=>()=>React.createElement('p',null,'Synthetic details')}};
const title=locale==='zh'?'这是一段需要保留可读性的会话标题':'A conversation title that must remain readable';
// 角标注册发生在首次快照到位后的 sync(与线上一致):等两条注册都出现再渲染。
const waitFor=key=>new Promise((resolve,reject)=>{const started=Date.now();const tick=()=>registrations.has(key)?resolve(registrations.get(key)):(Date.now()-started>5000?reject(new Error('timeout waiting for '+key)):setTimeout(tick,20));tick()});
Promise.all([waitFor('conversation.composer.dock:cost-meter-statistics'),waitFor('conversation.composer.dock:cost-meter-corner')]).then(([SessionStatisticsButton,CornerChips])=>{createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
  React.createElement('header',null,React.createElement('span',{className:'title'},title),React.createElement('button',null,'PTC'),React.createElement(SessionStatisticsButton,{...props,entryPosition:'header'})),
  React.createElement('main',null,'Synthetic conversation'),
  React.createElement('footer',null,React.createElement('div',{'data-slot':'conversation.composer.dock'},
    React.createElement('div',{className:'native-stats'},
      React.createElement('span',{className:'native-pill'},locale==='zh'?'◷ 2 轮 26 步 · 273 tok/s':'◷ 2 turns 26 steps · 273 tok/s'),
      React.createElement('span',{className:'native-pill'},locale==='zh'?'▤ 1.4M tok · 缓存命中 98%':'▤ 1.4M tok · cache hit 98%')),
    React.createElement(SessionStatisticsButton,{...props,entryPosition:'dock'}),
    React.createElement(CornerChips,props)),React.createElement('span',{className:'context-meter'},'◌ 8%'))))}).catch(error=>{const pre=document.createElement('pre');pre.id='boot-error';pre.textContent='BOOT FAIL '+(error&&error.message||error);document.body.appendChild(pre)});`
const localReact = (() => { try { createRequire(join(root, 'package.json')).resolve('react'); return true } catch (error) { return false } })()
const hostModules = positional[0] ?? process.env.DSH_TEST_NODE_MODULES
if (!localReact && !hostModules) throw new Error('react 不可解析:请在仓库根安装依赖,或用 [node_modules 目录] / DSH_TEST_NODE_MODULES 指定')
const nodePaths = !localReact && hostModules ? { nodePaths: [resolve(hostModules)] } : {}
const bundle = await build({ stdin: { contents: entry, loader: 'js', resolveDir: root }, bundle: true, write: false,
  format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, ...nodePaths })
const widths = [320, 360, 390, 414, 480, 640, 641, 768, 1440]
const overview = `<!doctype html><meta charset="utf-8"><title>Cost entry layout regression</title>
<style>body{font:14px system-ui}iframe{height:150px;border:1px solid #aaa}section{margin:12px 0}</style>
<h1>#214 费用入口窄屏回归</h1><button id="run">Run regression</button><p id="result" role="status">Ready</p>
${widths.flatMap(width => ['zh','en'].map(locale => `<section>${width}px · ${locale}<br><iframe title="${width}-${locale}" width="${width}" src="/case?locale=${locale}"></iframe></section>`)).join('')}
<script>
document.getElementById('run').onclick=async()=>{let checks=0;const check=(ok,msg)=>{checks++;if(!ok)throw Error(msg)};
const waitFor=(fn,timeout=8000)=>{const deadline=Date.now()+timeout;return new Promise((res,rej)=>{const tick=()=>{let v=false;try{v=fn()}catch(e){}if(v)return res();if(Date.now()>deadline)return rej(Error('timeout waiting for iframe content'));setTimeout(tick,50)};tick()})};
try{const frames=[...document.querySelectorAll('iframe')];await Promise.all(frames.map(f=>waitFor(()=>f.contentDocument?.querySelector?.('.cm-stat-entry'))));for(const frame of frames){const doc=frame.contentDocument,win=frame.contentWindow,header=doc.querySelector('.cm-stat-header'),dock=doc.querySelector('.cm-stat-dock'),title=doc.querySelector('.title');
check(!!header&&!!dock,frame.title+' both configured entries mounted');
check(dock.getBoundingClientRect().height<=24,frame.title+' compact typography');
check(doc.documentElement.scrollWidth<=win.innerWidth,frame.title+' no horizontal page overflow');
if(win.innerWidth<=640){check(win.getComputedStyle(header).display==='none',frame.title+' header entry hidden');const before=title.getBoundingClientRect().width;header.style.display='none';check(title.getBoundingClientRect().width===before,frame.title+' title keeps full baseline width');header.style.display='';}
else check(header.getBoundingClientRect().width>0,frame.title+' desktop entry visible');
check(dock.getBoundingClientRect().width>0,frame.title+' composer entry remains accessible');
check(dock.scrollWidth<=dock.clientWidth,frame.title+' details label stays readable');
const stats=doc.querySelector('.native-stats'),corner=doc.querySelector('.cm-corner'),meter=doc.querySelector('.context-meter'),footer=doc.querySelector('footer');
for(const part of [stats,corner,meter])check(Math.abs(part.getBoundingClientRect().top+part.getBoundingClientRect().height/2-dock.getBoundingClientRect().top-dock.getBoundingClientRect().height/2)<2,frame.title+' native stats, details, budget and context stay in one row');
check(footer.getBoundingClientRect().height<=28,frame.title+' no extra footer row or blank space');
check(dock.getBoundingClientRect().right<=corner.getBoundingClientRect().left+1,frame.title+' details do not overlap quota chips');
check(dock.getAttribute('aria-label')===dock.title,frame.title+' full accessible label retained');
dock.click();await new Promise(r=>setTimeout(r,40));check(!!doc.querySelector('dialog[open]'),frame.title+' details open');
doc.querySelector('dialog button').click();await new Promise(r=>setTimeout(r,20));check(!doc.querySelector('dialog'),frame.title+' details close');
}const tag='PASS '+checks+' assertions';finish(tag);}catch(e){finish('FAIL '+checks+' '+e.message)}};
function finish(tag){document.getElementById('result').textContent=tag;document.title='RESULT:'+tag;try{fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag})}).catch(()=>{})}catch(e){}}
if(new URLSearchParams(location.search).get('autorun')==='1')setTimeout(()=>document.getElementById('run').onclick(),50);
</script>`

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
  browserProfile = mkdtempSync(join(tmpdir(), 'cm-cost-entry-layout-'))
  browserProcess = spawn(executable, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--user-data-dir=' + browserProfile, url], { stdio: 'ignore' })
  browserProcess.on('error', error => { console.log('FAIL browser launch failed: ' + error.message); cleanupBrowser(); process.exit(1) })
}

const server = createServer((request, response) => {
  if (request.url.startsWith('/report')) {
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
  if (request.url === '/entry.js') { response.setHeader('content-type','text/javascript; charset=utf-8'); response.end(bundle.outputFiles[0].text); return }
  response.setHeader('content-type','text/html; charset=utf-8')
  response.end(request.url.startsWith('/case') ? `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui;color:#222}header,footer{display:flex;align-items:center;gap:12px;box-sizing:border-box;max-width:100%}header{padding:12px}.title{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}header>button{flex-shrink:0}main{padding:8px}footer{font-size:12px;justify-content:center;padding:4px 4px 0}[data-slot]{display:contents}.native-stats{display:flex;justify-content:center;gap:12px;min-width:0;max-width:100%;line-height:20px}.native-pill{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.context-meter{flex:none;white-space:nowrap;line-height:20px}button{font:inherit}dialog{box-sizing:border-box}
</style><div id="root"></div><script src="/entry.js"></script>` : overview)
})
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port
  console.log(url)
  if (waitForBrowser) launchBrowser(url + '/?autorun=1')
})
if (waitForBrowser) setTimeout(() => {
  if (reported) return
  console.log('FAIL timeout: no report within ' + timeoutMs + 'ms')
  cleanupBrowser()
  process.exit(1)
}, timeoutMs).unref()
