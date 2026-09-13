#!/usr/bin/env node
/**
 * 工作台：一个地址、一套外壳，把给人看的页面全放进页签里。开工第一件事就是把它起来，人随时能查。
 *
 * 用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]
 *
 * 页签（2026-09-13 项目所有者要直白的名字，「审阅」「审查」太像）：谁在干什么（scene）· 等你答（scene 的 /questions：攒着的问题列一页，问卷模式用）· 走故事（story）· 模型图（story 的 /model）· 这段改了什么（model-delta，按当前段落现算）
 *      · 审模型（review，读 reports/validate-1.json，校验器对模型的判断）· 审代码对模型（codemodel，读 reports/validate-2.json，方向 ② 留给人的判断）· 审代码（review，读 reports/pre-pr-*.json，pre-pr 审查的发现）· 编码计划（plans/<当前段落>.md 现渲染）· 试原型（proto，给了 --code 且 src/proto/main.ts 在才起）
 * 它自己把这几个服务拉起来：每个现挑一个空闲端口、只听 127.0.0.1、不许它们自己弹浏览器；页面统统从工作台这一个口代理出去（/p/<页面>/…），
 * 所以人只需要开 http://localhost:4870 这一个地址，别的口不用管也看不见。进程退出时把自己拉起来的一并关掉。
 * 当前段落读 reports/_scene.json；页签上「等你」的标记也从那里来，每 5 秒刷一次。
 *
 * 由来：2026-09-13 验收项目所有者：「现在有好几种 html 的 interface，统一一下做成一个工作台；dev-team 一开工应该就要 host 起来，人可以随时查。」
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { flipHtml } = require('./lib/theme')

// 白天 / 黑夜（2026-09-13 项目所有者要的）。每张页面本来是深是浅不一样：
// 现场页与外壳生来是深色，走故事、审模型、试原型、模型图、计划、增量生来是浅色。
// 人选了哪一头，跟它本来那一头不一样的页面就整页翻面（tools/lib/theme.js：色相不动、明度翻过来）。
const BORN_DARK = new Set(['scene'])
const themeOf = (req) => {
  // 地址上带 ?theme=dark|light 就按它来（截图、试样子、把某一页发给人看都用得上），否则看 cookie
  const q = (/[?&]theme=(light|dark)\b/.exec(req.url ?? '') ?? [])[1]
  if (q) return q
  return (/(?:^|;\s*)wb-theme=(light|dark)/.exec(req.headers.cookie ?? '') ?? [])[1] ?? null
}
/** 按人选的主题把一张页面调成该有的样子；没选过就原样发（外壳的脚本会按系统偏好选一次） */
function themed(html, who, theme) {
  if (!theme) return html
  // 外壳是「深色工具条 + 内容区」的两截结构，整页翻面会把工具条翻成浅色、内容区翻成深色，正好拧着。
  // 工具条两头都保持深色，只换内容区那块底。
  if (who === '外壳') {
    const mark = `<style data-theme-scheme>:root{color-scheme:${theme};--page:${theme === 'dark' ? '#0e1115' : '#f6f7f9'}}</style>`
    return html.includes('</head>') ? html.replace('</head>', mark + '</head>') : mark + html
  }
  const born = BORN_DARK.has(who) ? 'dark' : 'light'
  if (theme !== born) return flipHtml(html, theme)
  // 本来就是这一头的页面不用翻，但也要报一句 color-scheme：滚动条、输入框这些浏览器自己画的东西照它走
  const mark = `<style data-theme-scheme>:root{color-scheme:${theme}}</style>`
  return html.includes('</head>') ? html.replace('</head>', mark + '</head>') : mark + html
}

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null
if (!root || !fs.existsSync(path.join(root, 'project.json'))) { console.error('用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]'); process.exit(2) }
const codebase = opt('--code') ? path.resolve(opt('--code')) : (() => { try { const c = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).codebase; return c ? path.resolve(root, c) : null } catch { return null } })()
const port = Number(opt('--port', 4870))
// 子服务的口每次现挑空闲的、只听本机、不告诉人：给人的地址只有工作台这一个（2026-09-13 项目所有者：「统一了之后只开 4870 那一个就够了」）
const INNER = {} // 名字 → 端口，startAll 时填
const tools = __dirname
const projectName = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).name } catch { return path.basename(root) } })()
const logDir = path.join(root, 'reports', '_workbench')
fs.mkdirSync(logDir, { recursive: true })

const scene = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'reports', '_scene.json'), 'utf8')) } catch { return {} } }
const currentSlice = () => scene().slice || null

// ---------- 子服务 ----------
const children = []
// 用「连得上」判断端口有没有人在听：用 listen 试探会漏掉只听 ::1 的老进程（2026-09-13 踩过）
function connectable(host, p) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port: p }).once('connect', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
    c.setTimeout(800, () => { c.destroy(); resolve(false) })
  })
}
async function portBusy(p) { return (await connectable('127.0.0.1', p)) || (await connectable('::1', p)) }
// 现挑一个空闲口：让系统分配再让开，子进程紧接着就去占
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject).listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => resolve(pt)) })
  })
}
async function waitServed(name, p, seconds = 6) {
  for (let i = 0; i < seconds * 4; i++) { if (await portBusy(p)) return true; await new Promise((r) => setTimeout(r, 250)) }
  console.log(`${name}：${seconds} 秒内没起来，先不等它了；两分钟内起来了会自动接上。看 reports/_workbench/${name}.log`)
  return false
}
/** 超时之后还接着看：子服务（多半是要先编译的原型）晚起来了就接上，页签不用一直显示「还没起来」 */
function adoptLater(name, p) {
  let left = 120
  const t = setInterval(async () => {
    if (INNER[name]) return clearInterval(t)
    if (await portBusy(p)) { INNER[name] = p; console.log(`${name}：起来了，已接上`); return clearInterval(t) }
    if (--left <= 0) { clearInterval(t); console.log(`${name}：两分钟了还没起来，放弃；看 reports/_workbench/${name}.log`) }
  }, 1000)
  t.unref()
}
/** 起一个子服务：现挑口、只听本机、不许它自己弹浏览器；起好了记进 INNER，页面就从工作台代理过去 */
async function ensure(name, argvOf, cwd, seconds) {
  const p = await freePort()
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a')
  const child = spawn(process.execPath, argvOf(p), { cwd: cwd ?? root, stdio: ['ignore', out, out], windowsHide: true })
  children.push({ name, child })
  if (await waitServed(name, p, seconds)) INNER[name] = p
  else adoptLater(name, p)
  return INNER[name] ?? null
}
async function startAll() {
  await ensure('scene', (p) => [path.join(tools, 'scene.js'), root, 'serve', '--port', String(p)])
  await ensure('story', (p) => [path.join(tools, 'story.js'), 'serve', root, ...(currentSlice() ? [currentSlice()] : []), '--port', String(p), '--no-open'])
  const report = path.join(root, 'reports', 'validate-1.json')
  if (fs.existsSync(report)) await ensure('review', (p) => [path.join(tools, 'review.js'), report, '--port', String(p), '--no-open'])
  // 方向 ②：代码解码回来对模型，校验器留给人的判断（多半是「模型文字与代码注释是不是同一个意思」）
  const report2 = path.join(root, 'reports', 'validate-2.json')
  if (fs.existsSync(report2)) await ensure('codemodel', (p) => [path.join(tools, 'review.js'), report2, '--port', String(p), '--no-open'])
  const prepr = ['pre-pr-proto.json', 'pre-pr-shell.json'].map((x) => path.join(root, 'reports', x)).find((x) => fs.existsSync(x))
  if (prepr) await ensure('prepr', (p) => [path.join(tools, 'review.js'), prepr, '--port', String(p), '--no-open'])
  if (codebase && fs.existsSync(path.join(codebase, 'src', 'proto', 'main.ts'))) {
    const hostPort = await freePort()
    await ensure('proto', (p) => [path.join(tools, 'proto.js'), 'serve', root, '--code', codebase, '--port', String(p), '--proto-port', String(hostPort), '--story-base', '/p/story', '--no-open'], undefined, 30)
  }
}
// 页签背后那一页没起来时，页面上直说为什么，别让人对着一个连不上的空白框
const MISSING = {
  review: '审模型这一页要 <code>reports/validate-1.json</code>——校验器跑过这一段才有。',
  codemodel: '审代码对模型这一页要 <code>reports/validate-2.json</code>——代码写出来、校验器跑过方向 ② 才有。',
  prepr: '审代码这一页要 <code>reports/pre-pr-*.json</code>——pre-pr 审查交稿后才有。',
  proto: '试原型这一页要代码库里有 <code>src/proto/main.ts</code>——这一段进了编码阶段才有；刚重启的话它可能还在编译，过半分钟再点一次这个页签。',
}
function stopAll() { for (const { child } of children) { try { child.kill() } catch { /* 已退出 */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(0) })
process.on('SIGTERM', () => { stopAll(); process.exit(0) })
process.on('exit', stopAll)

// ---------- 现算的页面 ----------
function deltaPage(slice) {
  if (!slice) return null
  const r = spawnSync(process.execPath, [path.join(tools, 'model-delta.js'), root, slice], { encoding: 'utf8' })
  const f = path.join(root, 'reports', `model-delta.${slice}.html`)
  if (r.status !== 0 || !fs.existsSync(f)) return `<p style="padding:20px;font-family:system-ui">增量页算不出来：${esc((r.stderr || r.stdout || '').trim() || '未知原因')}</p>`
  return fs.readFileSync(f, 'utf8')
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
// 计划 md → 简单 HTML：标题、表格、代码块、列表、段落。够看链路与关键逻辑，不追求全功能
function mdToHtml(md) {
  const lines = md.split('\n'); const out = []; let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(rows[0]); const body = rows.slice(2).map(cells)
      out.push(`<table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`); continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^\s*[-*]\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, '')); out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue }
    if (!l.trim()) { i++; continue }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|\||```|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
  function inline(t) { return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>') }
}
function planPage(slice) {
  if (!slice) return '<p>还没指到哪一段。</p>'
  const f = path.join(root, 'plans', `${slice}.md`)
  if (!fs.existsSync(f)) return `<p>${esc(slice)} 还没有编码计划（模型确认后由开发指挥 <code>plan build</code> 算出）。</p>`
  return planGate(slice) + `<article class="md">${mdToHtml(fs.readFileSync(f, 'utf8'))}</article>`
}
/** 计划页顶上的关卡：这份计划人确认了没有。没确认就给一个按钮，按下去跟命令行 plan confirm 走的是同一段代码 */
function planGate(slice) {
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(path.join(root, 'plans', `${slice}.json`), 'utf8')) } catch { return '' }
  const done = plan.steps.filter((x) => x.doneAt).length
  if (plan.confirmedAt) return `<div class="gate ok">✓ 这份计划已于 ${esc(plan.confirmedAt)} 由你确认（${plan.steps.length} 步，已写完 ${done} 步）</div>`
  const unfilled = plan.steps.filter((x) => x.needsKeyLogic && !x.keyLogic).length
  if (unfilled) return `<div class="gate wait">这份计划还有 ${unfilled} 步关键逻辑没补，${esc(plan.role)}角色补完才能请你确认。</div>`
  return `<div class="gate ask"><b>等你确认：</b>${plan.steps.length} 步（${esc(plan.role)}角色写）。看过下面的链路与关键逻辑，没问题就按这一下——按了它才开写。
<button id="confirmPlan">确认这份计划</button><span id="confirmMsg"></span></div>
<script>document.getElementById('confirmPlan').onclick=async function(){this.disabled=true;var m=document.getElementById('confirmMsg');m.textContent='写着…';
var r=await fetch('/plan/confirm?slice='+encodeURIComponent(${JSON.stringify(slice)}),{method:'POST'});var t=await r.text();
if(r.ok){m.textContent='已确认，刷新中…';location.reload()}else{this.disabled=false;m.innerHTML='<b style="color:#cf222e">没确认成：</b>'+t.replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}}</script>`
}
const wrap = (body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 24px;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff}
.md h1{font-size:20px}.md h2{font-size:16px;margin-top:22px;border-bottom:1px solid #e6e8eb;padding-bottom:4px}.md h3{font-size:14px;color:#57606a}
.md table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}.md th,.md td{border:1px solid #e6e8eb;padding:5px 8px;text-align:left;vertical-align:top}.md th{background:#f6f8fa}
.gate{margin:0 0 14px;padding:10px 14px;border-radius:6px;border:1px solid #e6e8eb;background:#f6f8fa}.gate.ok{border-color:#a7d9b3;background:#eaf7ed}.gate.ask{border-color:#f3d27a;background:#fff8e1}.gate.wait{color:#57606a}.gate button{font:inherit;margin-left:10px;padding:4px 14px;border-radius:6px;border:1px solid #8a6d00;background:#ffd76a;cursor:pointer}.gate button:disabled{opacity:.5;cursor:default}#confirmMsg{margin-left:10px}
.md pre{background:#f6f8fa;border:1px solid #e6e8eb;border-radius:6px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5}.md code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px}
</style></head><body>${body}</body></html>`

// ---------- 外壳 ----------
const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>工作台 · ${esc(projectName)}</title>
<style>
:root{--bg:#0f172a;--fg:#e5e7eb;--dim:#94a3b8;--line:#1e293b;--on:#38bdf8;--warn:#fbbf24}
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--page,#f6f7f9)}
header{display:flex;align-items:center;gap:6px;padding:0 14px;height:44px;background:var(--bg);color:var(--fg);flex-shrink:0}
header h1{font-size:14px;margin:0 14px 0 0;font-weight:600;white-space:nowrap}header h1 span{color:var(--dim);font-weight:400;margin-left:8px}
header button{font:inherit;color:var(--dim);background:none;border:0;border-bottom:2px solid transparent;padding:0 12px;height:44px;cursor:pointer;white-space:nowrap}
header button.on{color:#fff;border-bottom-color:var(--on)}
header button#theme{font-size:15px;padding:0 8px;border:0;opacity:.75}header button#theme:hover{opacity:1}header button .b{display:inline-block;margin-left:6px;font-size:11px;padding:0 6px;border-radius:999px;background:var(--warn);color:#111}
header .sp{flex:1}header .now{color:var(--dim);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}header a{color:var(--dim);font-size:12px;margin-left:12px;text-decoration:none}header a:hover{color:#fff}
main{flex:1;position:relative}iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--page,#fff)}
</style></head><body>
<header><h1>工作台<span>${esc(projectName)}</span></h1>
<button data-t="scene" class="on">谁在干什么</button><button data-t="ask">等你答</button><button data-t="story">走故事</button><button data-t="model">模型图</button><button data-t="delta">这段改了什么</button><button data-t="review">审模型</button><button data-t="codemodel">审代码对模型</button><button data-t="prepr">审代码</button><button data-t="plan">编码计划</button><button data-t="proto">试原型</button>
<span class="sp"></span><span class="now" id="now"></span><button id="theme" title="白天 / 黑夜">🌙</button><a id="open" href="#" target="_blank" title="在新窗口打开这一页">新窗口 ↗</a></header>
<main><iframe id="f" src="/p/scene/"></iframe></main>
<script>
let cur='scene';let slice=null;let who=null
const url=(t)=>({scene:'/p/scene/',ask:'/p/scene/questions',story:'/p/story/story'+(slice?'?slice='+slice:''),model:'/p/story/model',delta:'/delta'+(slice?'?slice='+slice:''),review:'/p/review/',codemodel:'/p/codemodel/',prepr:'/p/prepr/',plan:'/plan'+(slice?'?slice='+slice:''),proto:'/p/proto/'})[t]
const f=document.getElementById('f'),open=document.getElementById('open')
function show(t){cur=t;for(const b of document.querySelectorAll('header button'))b.classList.toggle('on',b.dataset.t===t);f.src=url(t);open.href=url(t);try{localStorage.setItem('wb-tab',t)}catch{}}
for(const b of document.querySelectorAll('header button'))b.addEventListener('click',()=>show(b.dataset.t))
async function poll(){try{const s=await (await fetch('/state')).json();slice=s.slice;who=s.who
  document.getElementById('now').textContent=(s.slice?s.slice+' · ':'')+(s.phase?s.phase+' · ':'')+(s.who?s.who+' · ':'')+(s.step||'')
  const badge=(t,on)=>{const b=document.querySelector('header button[data-t="'+t+'"]');let x=b.querySelector('.b');if(on&&!x){x=document.createElement('span');x.className='b';x.textContent='等你';b.appendChild(x)}if(!on&&x)x.remove()}
  badge('scene',s.who==='人')
  badge('ask',(s.questions||[]).some(q=>!q.answeredAt))
  // 审阅页有没填的判断、故事页有没过的步骤：粗略按现场阶段标
  badge('review',s.who==='人'&&/审阅|判断/.test(s.step||'')&&!/方向 ?②|代码对模型/.test(s.step||''));badge('codemodel',s.who==='人'&&/方向 ?②|代码对模型/.test(s.step||''));badge('prepr',s.who==='人'&&/审查|pre-pr/.test(s.step||''));badge('story',s.who==='人'&&/走故事|预测|过卡|故事页|五问|语句/.test(s.step||''));badge('delta',s.who==='人'&&/增量|确认模型/.test(s.step||''));badge('plan',s.who==='人'&&/计划|链路|plan/.test(s.step||''))
}catch{}}
poll();setInterval(poll,5000)
// 白天 / 黑夜：存 cookie，服务器按它决定每张页面翻不翻面；没选过就先照系统偏好定一次
const cookie=(k)=>((document.cookie.match('(?:^|; )'+k+'=([^;]*)')||[])[1]||'')
function setTheme(v){document.cookie='wb-theme='+v+'; path=/; max-age=31536000';location.reload()}
;(function(){
  let t=cookie('wb-theme')
  if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';setTheme(t);return}
  const b=document.getElementById('theme')
  b.textContent=t==='dark'?'🌙':'☀️'
  b.title=t==='dark'?'现在是黑夜，点一下换白天':'现在是白天，点一下换黑夜'
  b.addEventListener('click',()=>setTheme(t==='dark'?'light':'dark'))
})()
let t0=null;try{t0=localStorage.getItem('wb-tab')}catch{}
if(t0&&t0!=='scene')setTimeout(()=>show(t0),300)
</script></body></html>`

// ---------- 反向代理：子页面全从工作台这一个口出去 ----------
// 子页面里写死的根路径（fetch('/data')、href="/model"）在代理下会打到工作台自己身上，
// 所以给每张 HTML 注一小段：fetch 与点链接都自动加上这一页的前缀。
const shimOf = (base) => `<script>(function(){var B=${JSON.stringify(base)};
var F=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.slice(0,3)!=='/p/')u=B+u;return F.call(window,u,o)};
document.addEventListener('click',function(e){var t=e.target;while(t&&t.tagName!=='A')t=t.parentNode;if(!t||!t.getAttribute)return;
var h=t.getAttribute('href');if(!h||h.charAt(0)!=='/'||h.charAt(1)==='/'||h.slice(0,3)==='/p/')return;e.preventDefault();var u=B+h;
if(t.target&&t.target!=='_self')window.open(u,t.target);else location.href=u},true)})()</script>`
function proxy(name, req, res, rest) {
  const up = http.request({ host: '127.0.0.1', port: INNER[name], method: req.method, path: rest, headers: { ...req.headers, host: `127.0.0.1:${INNER[name]}` } }, (ur) => {
    const ct = String(ur.headers['content-type'] ?? '')
    // 逐跳的头一律不转：body 到这里已经被 Node 解成了普通字节，再声明 chunked / gzip 就成了坏包，
    // 浏览器那一侧 fetch 报错、页面停在「连接中…」（2026-09-13 现场页踩过）
    const hop = (h) => { const o = { ...h }; delete o['transfer-encoding']; delete o['content-encoding']; delete o['connection']; delete o['keep-alive']; return o }
    if (!/text\/html/.test(ct)) { res.writeHead(ur.statusCode ?? 200, hop(ur.headers)); return ur.pipe(res) }
    const buf = []
    ur.on('data', (c) => buf.push(c)).on('end', () => {
      let body = Buffer.concat(buf).toString('utf8')
      body = themed(body, name, themeOf(req))
      const shim = shimOf('/p/' + name)
      // 必须排在页面自己的脚本之前：页面一加载就 fetch('/data')，晚一步就打到工作台根上 404，框里是空的（2026-09-13 踩过）
      body = body.includes('</head>') ? body.replace('</head>', shim + '</head>')
        : body.includes('<body>') ? body.replace('<body>', '<body>' + shim)
        : shim + body
      // 改过正文就重算长度：上游是 chunked 传过来的，transfer-encoding 与 content-length 同时在，浏览器判成坏包，页面整个打不开
      const h = hop(ur.headers)
      h['content-length'] = String(Buffer.byteLength(body))
      h['cache-control'] = 'no-store'
      res.writeHead(ur.statusCode ?? 200, h)
      res.end(body)
    })
  })
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`${name} 这一页连不上：${e.message}`) })
  req.pipe(up)
}

// 访问日志：人说「页面不好用」时，服务器这边只看得见自己没出错，看不见他的浏览器碰到了什么。记一行就有据可查。
const accessLog = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' })
const server = http.createServer((req, res) => {
  const t0 = Date.now()
  res.on('finish', () => { try { accessLog.write(`${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms\n`) } catch { /* 日志写不动不影响页面 */ } })
  const [url, qs] = (req.url ?? '/').split('?')
  const q = Object.fromEntries(new URLSearchParams(qs ?? ''))
  const theme = themeOf(req)
  const html = (b, who = '现算') => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(themed(b, who, theme)) }
  // /p/<页面>/… → 转给对应的子服务；页面只认工作台这一个口
  const m = url.match(/^\/p\/([a-z]+)(\/.*)?$/)
  if (m) {
    const name = m[1]
    if (!INNER[name]) return html(wrap(`<p>${MISSING[name] ?? '这一页还没起来。'}</p>`))
    // theme 是工作台这一层的参数，别转给子服务：有的子服务按整串地址匹配路由，多一个参数就找不到页了
    const rest = [...new URLSearchParams(qs ?? '')].filter(([k]) => k !== 'theme')
    const q2 = new URLSearchParams(rest).toString()
    return proxy(name, req, res, (m[2] || '/') + (q2 ? '?' + q2 : ''))
  }
  // 换主题也留一个地址：/theme?set=dark|light（外壳上那个按钮走的是同一条路，脚本与截图也用得上）
  if (url === '/theme') {
    const v = q.set === 'dark' ? 'dark' : 'light'
    res.writeHead(302, { 'set-cookie': `wb-theme=${v}; Path=/; Max-Age=31536000`, location: '/', 'cache-control': 'no-store' })
    return res.end()
  }
  if (url === '/') return html(shell, '外壳')
  if (url === '/state') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(scene())) }
  if (url === '/delta') return html(deltaPage(q.slice || currentSlice()) ?? wrap('<p>还没指到哪一段。</p>'))
  if (url === '/plan') return html(wrap(planPage(q.slice || currentSlice())))
  // 页面上的「确认这份计划」按钮：不另写一份确认逻辑，直接跑命令行那一个，门禁、日志、切片记录都是同一套
  if (url === '/plan/confirm' && req.method === 'POST') {
    const slice = q.slice || currentSlice()
    if (!/^s-[0-9]{3,}$/.test(slice ?? '')) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('没指到哪一段') }
    const r = spawnSync(process.execPath, [path.join(tools, 'plan.js'), 'confirm', root, slice], { encoding: 'utf8', cwd: root })
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    console.log(`页面上确认计划 ${slice} → ${r.status === 0 ? '成' : '拒'}：${out.split('\n')[0]}`)
    res.writeHead(r.status === 0 ? 200 : 409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(out || (r.status === 0 ? '已确认' : '没确认成'))
  }
  res.writeHead(404); res.end()
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`${port} 上已经有工作台在跑了。要换成新代码就先把它停掉（Ctrl+C 或结束那个 node 进程），再起这一个。`); process.exit(2) }
  throw e
})
startAll().then(() => {
  server.listen(port, () => {
    console.log(`子页面都起在本机的临时口上、不对外（${Object.keys(INNER).join('、') || '无'}），人不用管它们`)
    console.log(`工作台：http://localhost:${port}　（Ctrl+C 结束；会一并关掉自己拉起来的子服务）`)
  })
})
