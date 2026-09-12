#!/usr/bin/env node
/**
 * 工作台：一个地址、一套外壳，把给人看的页面全放进页签里。开工第一件事就是把它起来，人随时能查。
 *
 * 用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]
 *
 * 页签：现场（scene 4873）· 故事（story 4871）· 模型（story 的 /model）· 增量（model-delta，按当前段落现算）
 *      · 审阅（review 4874，读 reports/validate-1.json）· 审查（review 4876，读 reports/pre-pr-*.json，代码审查的发现）· 计划（plans/<当前段落>.md 现渲染）· 原型（proto 4872，给了 --code 且 src/proto/main.ts 在才起）
 * 它自己把这几个服务拉起来（端口已经有人在听就复用、不重复起），进程退出时把自己拉起来的一并关掉。
 * 当前段落读 reports/_scene.json；页签上「等你」的标记也从那里来，每 5 秒刷一次。
 *
 * 由来：2026-09-13 验收项目所有者：「现在有好几种 html 的 interface，统一一下做成一个工作台；dev-team 一开工应该就要 host 起来，人可以随时查。」
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null
if (!root || !fs.existsSync(path.join(root, 'project.json'))) { console.error('用法：node tools/workbench.js <项目目录> [--code <代码库>] [--port 4870]'); process.exit(2) }
const codebase = opt('--code') ? path.resolve(opt('--code')) : (() => { try { const c = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).codebase; return c ? path.resolve(root, c) : null } catch { return null } })()
const port = Number(opt('--port', 4870))
const PORTS = { story: 4871, proto: 4872, scene: 4873, review: 4874, protoHost: 4875, prepr: 4876 }
const tools = __dirname
const projectName = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')).name } catch { return path.basename(root) } })()
const logDir = path.join(root, 'reports', '_workbench')
fs.mkdirSync(logDir, { recursive: true })

const scene = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'reports', '_scene.json'), 'utf8')) } catch { return {} } }
const currentSlice = () => scene().slice || null

// ---------- 子服务 ----------
const children = []
// 用「连得上」判断端口有没有人在听：用 listen 试探会漏掉只听 ::1 的老进程，当成空闲再起一个，子进程就悄悄挑别的端口去了（2026-09-13 踩过）
function connectable(host, p) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port: p }).once('connect', () => { c.destroy(); resolve(true) }).once('error', () => resolve(false))
    c.setTimeout(800, () => { c.destroy(); resolve(false) })
  })
}
async function portBusy(p) { return (await connectable('127.0.0.1', p)) || (await connectable('::1', p)) }
// 起完确认那个端口真是自己的孩子在听；孩子发现端口被占会自己挑别的口，那样页签就指错地方
async function waitServed(name, p) {
  for (let i = 0; i < 20; i++) { if (await portBusy(p)) return true; await new Promise((r) => setTimeout(r, 250)) }
  console.log(`${name}：5 秒内 ${p} 上没人听，看 reports/_workbench/${name}.log`)
  return false
}
async function ensure(name, p, argv, cwd) {
  if (await portBusy(p)) { console.log(`${name}：${p} 已有进程在听，复用`); return 'reused' }
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a')
  const child = spawn(process.execPath, argv, { cwd: cwd ?? root, stdio: ['ignore', out, out], windowsHide: true })
  children.push({ name, child })
  console.log(`${name}：起在 ${p}（日志 reports/_workbench/${name}.log）`)
  await waitServed(name, p)
  return 'started'
}
async function startAll() {
  await ensure('scene', PORTS.scene, [path.join(tools, 'scene.js'), root, 'serve', '--port', String(PORTS.scene)])
  await ensure('story', PORTS.story, [path.join(tools, 'story.js'), 'serve', root, ...(currentSlice() ? [currentSlice()] : []), '--port', String(PORTS.story)])
  const report = path.join(root, 'reports', 'validate-1.json')
  if (fs.existsSync(report)) await ensure('review', PORTS.review, [path.join(tools, 'review.js'), report, '--port', String(PORTS.review)])
  else console.log('审阅：还没有 reports/validate-1.json，页签会说明')
  const prepr = ['pre-pr-proto.json', 'pre-pr-shell.json'].map((x) => path.join(root, 'reports', x)).find((x) => fs.existsSync(x))
  if (prepr) await ensure('prepr', PORTS.prepr, [path.join(tools, 'review.js'), prepr, '--port', String(PORTS.prepr)])
  else console.log('审查：还没有 reports/pre-pr-*.json，页签会说明')
  if (codebase && fs.existsSync(path.join(codebase, 'src', 'proto', 'main.ts'))) await ensure('proto', PORTS.proto, [path.join(tools, 'proto.js'), 'serve', root, '--code', codebase, '--port', String(PORTS.proto), '--proto-port', String(PORTS.protoHost)])
  else console.log('原型：代码库还没有 src/proto/main.ts，页签会说明')
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
  return `<article class="md">${mdToHtml(fs.readFileSync(f, 'utf8'))}</article>`
}
const wrap = (body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 24px;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff}
.md h1{font-size:20px}.md h2{font-size:16px;margin-top:22px;border-bottom:1px solid #e6e8eb;padding-bottom:4px}.md h3{font-size:14px;color:#57606a}
.md table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}.md th,.md td{border:1px solid #e6e8eb;padding:5px 8px;text-align:left;vertical-align:top}.md th{background:#f6f8fa}
.md pre{background:#f6f8fa;border:1px solid #e6e8eb;border-radius:6px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5}.md code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px}
</style></head><body>${body}</body></html>`

// ---------- 外壳 ----------
const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>工作台 · ${esc(projectName)}</title>
<style>
:root{--bg:#0f172a;--fg:#e5e7eb;--dim:#94a3b8;--line:#1e293b;--on:#38bdf8;--warn:#fbbf24}
html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9}
header{display:flex;align-items:center;gap:6px;padding:0 14px;height:44px;background:var(--bg);color:var(--fg);flex-shrink:0}
header h1{font-size:14px;margin:0 14px 0 0;font-weight:600;white-space:nowrap}header h1 span{color:var(--dim);font-weight:400;margin-left:8px}
header button{font:inherit;color:var(--dim);background:none;border:0;border-bottom:2px solid transparent;padding:0 12px;height:44px;cursor:pointer;white-space:nowrap}
header button.on{color:#fff;border-bottom-color:var(--on)}header button .b{display:inline-block;margin-left:6px;font-size:11px;padding:0 6px;border-radius:999px;background:var(--warn);color:#111}
header .sp{flex:1}header .now{color:var(--dim);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}header a{color:var(--dim);font-size:12px;margin-left:12px;text-decoration:none}header a:hover{color:#fff}
main{flex:1;position:relative}iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
</style></head><body>
<header><h1>工作台<span>${esc(projectName)}</span></h1>
<button data-t="scene" class="on">现场</button><button data-t="story">故事</button><button data-t="model">模型</button><button data-t="delta">增量</button><button data-t="review">审阅</button><button data-t="prepr">审查</button><button data-t="plan">计划</button><button data-t="proto">原型</button>
<span class="sp"></span><span class="now" id="now"></span><a id="open" href="#" target="_blank" title="在新窗口打开这一页">新窗口 ↗</a></header>
<main><iframe id="f" src="http://localhost:${PORTS.scene}/"></iframe></main>
<script>
const P=${JSON.stringify(PORTS)};let cur='scene';let slice=null;let who=null
const url=(t)=>({scene:'http://localhost:'+P.scene+'/',story:'http://localhost:'+P.story+'/story'+(slice?'?slice='+slice:''),model:'http://localhost:'+P.story+'/model',delta:'/delta'+(slice?'?slice='+slice:''),review:'http://localhost:'+P.review+'/',prepr:'http://localhost:'+P.prepr+'/',plan:'/plan'+(slice?'?slice='+slice:''),proto:'http://localhost:'+P.proto+'/'})[t]
const f=document.getElementById('f'),open=document.getElementById('open')
function show(t){cur=t;for(const b of document.querySelectorAll('header button'))b.classList.toggle('on',b.dataset.t===t);f.src=url(t);open.href=url(t);try{localStorage.setItem('wb-tab',t)}catch{}}
for(const b of document.querySelectorAll('header button'))b.addEventListener('click',()=>show(b.dataset.t))
async function poll(){try{const s=await (await fetch('/state')).json();slice=s.slice;who=s.who
  document.getElementById('now').textContent=(s.slice?s.slice+' · ':'')+(s.phase?s.phase+' · ':'')+(s.who?s.who+' · ':'')+(s.step||'')
  const badge=(t,on)=>{const b=document.querySelector('header button[data-t="'+t+'"]');let x=b.querySelector('.b');if(on&&!x){x=document.createElement('span');x.className='b';x.textContent='等你';b.appendChild(x)}if(!on&&x)x.remove()}
  badge('scene',s.who==='人')
  // 审阅页有没填的判断、故事页有没过的步骤：粗略按现场阶段标
  badge('review',s.who==='人'&&/审阅|判断/.test(s.step||''));badge('prepr',s.who==='人'&&/审查|pre-pr/.test(s.step||''));badge('story',s.who==='人'&&/走故事|预测|过卡|故事页/.test(s.step||''));badge('delta',s.who==='人'&&/增量|确认模型/.test(s.step||''));badge('plan',s.who==='人'&&/计划|链路|plan/.test(s.step||''))
}catch{}}
poll();setInterval(poll,5000)
let t0=null;try{t0=localStorage.getItem('wb-tab')}catch{}
if(t0&&t0!=='scene')setTimeout(()=>show(t0),300)
</script></body></html>`

const server = http.createServer((req, res) => {
  const [url, qs] = (req.url ?? '/').split('?')
  const q = Object.fromEntries(new URLSearchParams(qs ?? ''))
  const html = (b) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b) }
  if (url === '/') return html(shell)
  if (url === '/state') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(scene())) }
  if (url === '/delta') return html(deltaPage(q.slice || currentSlice()) ?? wrap('<p>还没指到哪一段。</p>'))
  if (url === '/plan') return html(wrap(planPage(q.slice || currentSlice())))
  res.writeHead(404); res.end()
})
startAll().then(() => {
  server.listen(port, () => console.log(`工作台：http://localhost:${port}　（Ctrl+C 结束；会一并关掉自己拉起来的子服务）`))
})
