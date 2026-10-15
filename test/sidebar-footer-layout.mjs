// Browser regression for #192. Start with:
// node test/sidebar-footer-layout.mjs [node_modules dir] [--wait] [--browser=<exe>] [--baseline v1.7.42]
//   --wait   自己启动无头浏览器打开本页,等页面把结果回报到 /report 后按退出码结束
//            (全过 0 / 失败或超时 1);否则打印地址常驻服务供人工核对。
// 页面在 ?autorun=1 时自动跑一遍(人工模式下点 Run regression 亦可)。No real host/account is contacted.
//
// 迁移说明:旧实现在页面里内联拼接 src/client/*.js 片段并注入 `exports.preview = { SidebarFooter }`。
// 片段已删,现改为按平台 classic-script 语义执行构建产物 lib/client.js,再走**真实激活路径**
// (apply(ctx) → slots 注册)取回页脚组件 —— 与线上注册同源,顺带覆盖注册本身。
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
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
const baselineIndex = args.indexOf('--baseline')
const baseline = baselineIndex < 0 ? null : args[baselineIndex + 1] ?? 'v1.7.42'
// 客户端实现来自构建产物:旧片段已删,产物由 scripts/build.mjs --client 生成。
// baseline 模式同样取该 tag 下的产物(历史上 lib/client.js 一直随仓库提交)。
const clientArtifact = baseline
  ? execFileSync('git', ['show', `${baseline}:lib/client.js`], { cwd: root, encoding: 'utf8' })
  : readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const config = sanitizeConfig({ locale: 'zh', hideOfficialBalance: true, goQuota: { enabled: false },
  peakEnabled: true, peakNotice: true, sidebarModels: { enabled: true } })
// Footer geometry copied from DSH dsh-v0.1.7-rc.2 SidebarRoot.module.css and
// bowenliang123/dsh-context src/client/styles/overview.css (2026-09-28).
// IMPORTANT: SlotOutlet in ui-renderer/src/client/scoped-slots.tsx also adds
// <div data-slot="sidebar.footer.action" style={{display:'contents'}}>.
// The wrapper has no layout box, but changes DOM ancestry for :has(>...)!
const hostCSS = `
.host{padding:6px 12px;box-sizing:border-box;background:#f7f8fa;font-size:14px}
.host.collapsed{padding:18px 10px 6px}
.footArea{flex:none;display:flex;flex-direction:column}
.settingsArea,.footerActions{flex:none;min-width:0;width:100%}
.footerActions{display:flex}
.collapsed .footArea{align-items:center}
.collapsed .settingsArea,.collapsed .footerActions{display:flex;justify-content:center;width:auto}
.lc-ov-entry{display:flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;box-sizing:border-box;margin:0 -2px;border:0;padding:0 10px 0 8px;overflow:hidden;background:transparent;border-radius:12px;color:inherit;font:inherit;line-height:22px;cursor:pointer}
.lc-ov-entry-rail{flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0;border-radius:50%}
.lc-ov-entry-icon{flex:none}
.lc-ov-entry-label{flex:1 1 auto;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.extra{width:36px;height:36px;flex:none;border:0;background:transparent}
.settingsArea{height:42px;padding-top:10px;box-sizing:border-box}
`
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {createPortal, flushSync} from 'react-dom';
let factory; window.__ModuleLoader__={load:v=>factory=v.factory};
new Function(${JSON.stringify(clientArtifact)})();
const seeds=id=>id==='react'?React:id==='react-dom'?{createPortal,flushSync}:id==='@deepseek-ai/dsh-client-ui-primitives'?{Tooltip:({children})=>React.createElement(React.Fragment,null,children)}:(()=>{throw new Error('missing seed '+id)})();
const main=factory(seeds);
const totals={cost:1,apiCost:1,calls:1,input:100,output:20,cacheRead:0,cacheWrite:0,byProviderModel:{'deepseek:deepseek-v4-pro':{cost:1,apiCost:1,input:100,output:20,cacheRead:0,cacheWrite:0}}};
const state={config:${JSON.stringify(config)},today:totals,month:totals,total:totals,history:[],balance:{status:'off'},goQuota:{status:'off'},codingPlans:{},gatewayQuotas:{sources:[]}};
// 真实激活路径:slots 注册表由桩提供,页脚组件从注册项取回(与线上同一处注册)。
const registrations=new Map();
const slots={inject:(_,cb)=>{cb()},register:(options,component)=>{registrations.set(options.name+':'+options.id,component);return()=>{}},entries:()=>[]};
const rpc={getLocalState:async()=>({ok:true,value:state}),getState:async()=>({ok:true,value:state})};
const ready=main.apply({remote:{$mount:async()=>()=>{}},get:n=>n==='remote.costMeter'?rpc:n==='slots'?slots:undefined,effect:fn=>fn(),on:()=>()=>{}});
let SidebarFooter=null;
function Scenario({width=280,simple=false,compact=false,enabled=true,hidden=false,extra=true,context=true,locale='zh',index=0,wrapped=true}){
 const wide=width>56, label=locale==='zh'?'上下文洞察':'Context Insights';
 const snapshot={...state,config:{...state.config,locale,sidebarSimple:simple,sidebarStyle:compact?'compact':'standard',hideTodayCost:hidden,peakNotice:!hidden,sidebarModels:{...state.config.sidebarModels,enabled:!hidden}}};
 const entries=<>
 {context&&<button key="context" className={'lc-ov-entry'+(wide?'':' lc-ov-entry-rail')} aria-label={label}><span className="lc-ov-entry-icon">▣</span>{wide&&<span className="lc-ov-entry-label">{label}</span>}</button>}
 {enabled&&<SidebarFooter key="cost" wide={wide} useCost={pick=>pick({state:snapshot})}/>}
 {extra&&<button key="extra" className="extra" aria-label="Remote control">↗</button>}
 </>;
 return <section data-case={index}><h2>{width}px · {simple?'简化':compact?'紧凑':'标准'} · {locale} · {wrapped?'DSH 0.1.7':'旧宿主'}</h2><div className={'host'+(wide?'':' collapsed')} style={{width}}><div className="footArea"><div className="footerActions">
 {wrapped?<div data-slot="sidebar.footer.action" style={{display:'contents'}}>{entries}</div>:entries}
 </div><div className="settingsArea">{wide?'⚙ 设置':'⚙'}</div></div></div></section>
}
function App(){const [dynamic,setDynamic]=React.useState({});update=setDynamic;return <><h1>#192 侧栏布局回归</h1><button onClick={run}>Run regression</button><p id="result" role="status">Ready</p><main>{[true,false].flatMap(wrapped=>[240,280,360,56].flatMap(width=>['standard','compact','simple'].flatMap(mode=>['zh','en'].map(locale=><Scenario key={width+mode+locale+wrapped} width={width} compact={mode==='compact'} simple={mode==='simple'} locale={locale} wrapped={wrapped} index={width+mode+locale+wrapped}/>))))}</main><h2>动态挂载 / 隐藏 / 展开收起</h2><div id="dynamic"><Scenario {...dynamic}/></div></>}
function check(ok,msg){checks++;if(!ok)throw new Error(msg)}
function measure(section){
 const host=section.querySelector('.host'), parent=section.querySelector('.footerActions'), stack=parent.querySelector('.cm-footer-stack');
 const context=parent.querySelector('.lc-ov-entry'), extra=parent.querySelector('.extra'), wide=!host.classList.contains('collapsed');
 const rect=n=>n.getBoundingClientRect(), p=rect(parent), label=section.getAttribute('data-case');
 if(stack){const s=rect(stack);check(Math.abs(s.width-p.width)<1,label+' cost has full footer width');
  for(const button of [context,extra].filter(Boolean)){const b=rect(button);check(wide?b.top>=s.bottom-1:b.bottom<=s.top+1,label+' sibling does not share cost row');}
  check(stack.scrollWidth<=stack.clientWidth+1,label+' cost has no horizontal overflow');
 }
 if(context){const c=rect(context);check(Math.abs(c.width-(wide?p.width+4-(!stack&&extra?36:0):36))<1,label+' context keeps native width');
  const text=context.querySelector('.lc-ov-entry-label');if(text)check(text.scrollWidth<=text.clientWidth+1,label+' context label visible');}
 if(extra)check(Math.abs(rect(extra).width-36)<1,label+' extra button stays 36px');
 const slot=parent.querySelector('[data-slot="sidebar.footer.action"]');
 if(slot)check(slot.style.cssText==='display: contents;',label+' slot remains layout-neutral');
 const order=[...(slot??parent).children].map(n=>n.classList.contains('lc-ov-entry')?'context':n.classList.contains('cm-footer-stack')?'cost':'extra');
 check(order.join(',')===[context&&'context',stack&&'cost',extra&&'extra'].filter(Boolean).join(','),label+' React DOM order unchanged');
 check(parent.getAttribute('style')===null,label+' host inline styles untouched');
 if(!stack){const style=getComputedStyle(parent);check(style.flexDirection==='row'&&style.flexWrap==='nowrap',label+' host layout restored');}
}
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
async function run(){const result=document.getElementById('result');checks=0;try{
 document.querySelectorAll('main section').forEach(measure);
 for(const wrapped of [true,false])for(const next of [{width:56},{width:56,hidden:true},{width:56,enabled:false},{width:280},{width:280,context:false},{width:280,context:true,extra:false},{width:56,simple:true},{width:360,compact:true},{width:280,hidden:true},{width:280}]){
  flushSync(()=>update({...next,wrapped}));await frame();measure(document.querySelector('#dynamic section'));
 }
 result.textContent='PASS: 48 layouts + 20 transitions, '+checks+' assertions';
 }catch(error){result.textContent='FAIL: '+error.message;console.error(error)}
 // 回报给 --wait 模式:标题与 /report 都带上可判定的结果串。
 const tag=result.textContent;document.title='RESULT:'+tag;
 try{fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag})}).catch(()=>{})}catch(error){/* 人工模式忽略 */}
}
ready.then(()=>{SidebarFooter=registrations.get('sidebar.footer.action:cost-meter')??null;createRoot(document.getElementById('root')).render(<App/>);if(new URLSearchParams(location.search).get('autorun')==='1')setTimeout(run,50)});
`
const localReact = (() => { try { createRequire(join(root, 'package.json')).resolve('react'); return true } catch (error) { return false } })()
const hostModules = positional[0] ?? process.env.DSH_TEST_NODE_MODULES
if (!localReact && !hostModules) throw new Error('react 不可解析:请在仓库根安装依赖,或用 [node_modules 目录] / DSH_TEST_NODE_MODULES 指定')
const nodePaths = !localReact && hostModules ? { nodePaths: [resolve(hostModules)] } : {}
const bundle = await build({ stdin: { contents: entry, loader: 'jsx', resolveDir: root },
  bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, ...nodePaths })
const html = `<!doctype html><meta charset="utf-8"><title>#192 Sidebar layout regression</title><style>
:root{--dsw-alias-label-primary:#182035;--dsw-alias-label-secondary:#454545;--dsw-alias-label-tertiary:#777;--dsw-alias-state-business-primary:#4176e6;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l1:#ddd;--dsw-alias-interactive-bg-hover:#eee}
body{font:14px Arial;padding:20px;color:#182035}main{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}h2{font-size:14px}#result{font-weight:bold}
${hostCSS}</style><div id="root"></div><script src="/app.js"></script>`

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
  browserProfile = mkdtempSync(join(tmpdir(), 'cm-sidebar-footer-layout-'))
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
  response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  response.end(request.url === '/app.js' ? bundle.outputFiles[0].contents : html)
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
