#!/usr/bin/env node
/**
 * 原型：把代码库编译成可跑的原型，起一个页面让人直接操作业务规则。
 *
 *   node tools/proto.js serve <项目目录> --code <代码库> [--port 4872] [--proto-port 4873]
 *       编译（tsc → <代码库>/.proto-build）、启动 src/proto/main.ts 的原型宿主、起页面：
 *       左：故事（按故事走、逐步走）与命令 / 查询清单；中：表单与结果；右：聚合状态与事件流水
 *   node tools/proto.js check <项目目录> --code <代码库>
 *       只编译 + 启动 + 对照模型：模型里的命令 / 查询 / 聚合有没有都登记进原型；退出码非 0 表示缺
 *
 * 依赖：代码库按 seed/03 写，原型入口 src/proto/main.ts 用 @shared/building-block/proto 的 ProtoHost。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const codebase = opt('--code') && path.resolve(opt('--code'))
const port = Number(opt('--port') ?? 4872)
let protoPort = Number(opt('--proto-port') ?? 4873)
const protoPortGiven = args.includes('--proto-port')
if (!['serve', 'check'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !codebase) {
  console.error('用法：node tools/proto.js <serve|check> <项目目录> --code <代码库> [--port 4872] [--proto-port 4873]')
  process.exit(2)
}
const { loadModel, loadBusiness, walk } = require('./lib/project')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const { compile } = require('./lib/compile')
const tsconfig = path.join(codebase, 'tsconfig.json')
// 编译到 <代码库>/.proto-build（与测试运行器共用 lib/compile.js）
let codebaseInBuild = null
function build() {
  const r = compile(codebase)
  codebaseInBuild = r.codebaseInBuild
  return { ok: r.ok, output: r.output }
}
let child = null
/** 端口上有没有人在听（不是我们自己起的宿主也算） */
function portBusy(p) {
  return new Promise((resolve) => {
    const s = require('node:net').createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(p, '127.0.0.1')
  })
}
async function freePort(from) {
  for (let p = from; p < from + 40; p++) if (!(await portBusy(p))) return p
  return from
}
function startHost() {
  return new Promise(async (resolve) => {
    if (child) { child.kill(); child = null }
    // 别的项目的原型可能占着这个口：占着就换，否则会连到人家的宿主，检查结果张冠李戴
    if (await portBusy(protoPort)) {
      const p = await freePort(protoPort + 1)
      if (protoPortGiven) console.error(`[原型] 端口 ${protoPort} 被占用，改用 ${p}（是别的项目的原型还在跑吗？）`)
      protoPort = p
    }
    const c = spawn(process.execPath, [path.join(__dirname, 'lib', 'proto-run.js'), codebaseInBuild, tsconfig], { env: { ...process.env, PROTO_PORT: String(protoPort) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    c.stdout.on('data', (d) => { log += d; process.stdout.write('[原型] ' + d) })
    c.stderr.on('data', (d) => { log += d; process.stderr.write('[原型] ' + d) })
    c.on('exit', (code) => { if (child === c) child = null; if (code) console.error(`[原型] 退出，代码 ${code}`) })
    child = c
    let tries = 0
    const poll = () => { hostGet('/manifest').then(() => resolve({ ok: true, log })).catch(() => { if (++tries > 50 || !child) resolve({ ok: false, log }); else setTimeout(poll, 100) }) }
    setTimeout(poll, 150)
  })
}
function hostReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: protoPort, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}
const hostGet = (p) => hostReq('GET', p)

// ---------- 模型数据给页面 ----------
function modelData() {
  const model = loadModel(root)
  const business = {}; for (const s of loadBusiness(root)) business[s.id] = { text: s.text, kind: s.kind }
  const errors = {}
  for (const el of model.elements) if (el.kind === 'error') errors[el.data.name] = { condition: el.data.condition ?? '', module: el.module, traces: el.data.traces ?? [] }
  const ops = []
  for (const el of model.elements) {
    if (el.kind === 'command-handler') ops.push({ kind: 'command', module: el.module, name: el.data.name, q: `${el.module}.${el.data.name}`, actor: el.data.actor, input: el.data.input, steps: (el.data.steps ?? []).map((s) => s.text), throws: el.data.throws ?? [], raises: el.data.raises ?? [], traces: el.data.traces ?? [] })
    if (el.kind === 'query-handler') ops.push({ kind: 'query', module: el.module, name: el.data.name, q: `${el.module}.${el.data.name}`, actor: el.data.actor, input: el.data.input, steps: (el.data.steps ?? []).map((s) => s.text), throws: [], raises: [], traces: el.data.traces ?? [] })
  }
  const aggregates = []
  for (const mf of model.moduleFiles) for (const a of mf.data.aggregates ?? []) aggregates.push({ q: `${mf.module}.${a.name}`, module: mf.module, name: a.name })
  const stories = walk(path.join(root, 'slices')).filter((p) => p.endsWith('.story.json')).map((p) => { const st = readJson(p); return { slice: st.slice, title: st.title, persona: st.persona, steps: st.steps.map((s) => ({ n: s.n, day: s.day, actor: s.actor, text: s.text, facts: s.facts ?? {}, walk: s.walk ?? null })) } }).sort((a, b) => a.slice.localeCompare(b.slice))
  return { system: model.modules?.data.system ?? '', ops, aggregates, errors, business, stories }
}

// ---------- check ----------
async function check() {
  const b = build()
  if (!b.ok) { console.error('编译失败：\n' + b.output); process.exit(1) }
  const h = await startHost()
  if (!h.ok) { console.error('原型宿主起不来：\n' + h.log); process.exit(1) }
  const m = await hostGet('/manifest')
  const d = modelData()
  const missing = []
  for (const op of d.ops) if (!(op.kind === 'command' ? m.commands : m.queries).includes(op.q)) missing.push(`${op.kind} ${op.q}`)
  for (const a of d.aggregates) if (!m.repositories.includes(a.q)) missing.push(`仓储 ${a.q}`)
  const extra = [...m.commands, ...m.queries].filter((n) => !d.ops.some((o) => o.q === n))
  console.log(`原型登记：命令 ${m.commands.length}，查询 ${m.queries.length}，仓储 ${m.repositories.length}`)
  if (missing.length) console.log('模型有、原型没登记：\n  ' + missing.join('\n  '))
  if (extra.length) console.log('原型登记了模型没有的：\n  ' + extra.join('\n  '))
  // 故事的走法能不能在原型上跑：有 walk.input 的步骤名字要能对上
  for (const st of d.stories) {
    const runnable = st.steps.filter((s) => s.walk && s.walk.kind !== 'none' && s.walk.input)
    const bad = runnable.filter((s) => !resolveName(m, s.walk).q)
    console.log(`故事 ${st.slice}「${st.title}」：${st.steps.length} 步，可在原型上走 ${runnable.length - bad.length} 步${bad.length ? `，对不上原型的 ${bad.length} 步（${bad.map((s) => `第 ${s.n} 步 ${s.walk.name}`).join('、')}）` : ''}`)
  }
  if (child) child.kill()
  process.exit(missing.length ? 1 : 0)
}
/** 故事 walk.name 可能不带模块前缀；对到原型登记名 */
function resolveName(m, w) {
  const kind = w.kind === 'query' ? 'query' : 'command'
  const list = kind === 'query' ? m.queries : m.commands
  if (list.includes(w.name)) return { kind, q: w.name }
  const hit = list.filter((n) => n.endsWith('.' + w.name))
  return { kind, q: hit.length === 1 ? hit[0] : null }
}

// ---------- serve ----------
const CSS = `
  :root { --line:#e1e4e8; --muted:#6b7280; --lo:#f6f8fa; --ok:#dcfce7; --bad:#fde2e2; --blue:#1f6feb; }
  * { box-sizing:border-box; } body { margin:0; font:14px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color:#111; background:#fafbfc; }
  header { display:flex; align-items:center; gap:14px; padding:8px 16px; border-bottom:1px solid var(--line); background:#fff; position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0; } header a { color:var(--blue); } header .sp { flex:1; } header .st { color:var(--muted); font-size:12px; }
  button { font:inherit; font-size:13px; padding:5px 12px; border:1px solid #d0d7de; background:#fff; border-radius:6px; cursor:pointer; } button.primary { background:var(--blue); color:#fff; border-color:var(--blue); } button:disabled { opacity:.5; cursor:default; }
  main { display:grid; grid-template-columns: 300px minmax(0,1fr) minmax(0,1.25fr); gap:12px; padding:12px 16px; align-items:start; }
  #state-box { position:sticky; top:52px; max-height:calc(100vh - 64px); overflow:auto; }
  @media (max-width: 1250px) { main { grid-template-columns: 280px minmax(0,1fr); } #state-box { grid-column: 1 / -1; position:static; max-height:none; } }
  .col { display:flex; flex-direction:column; gap:12px; }
  .box { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .box h2 { font-size:14px; margin:0 0 8px; } .box h3 { font-size:13px; margin:10px 0 4px; color:var(--muted); }
  .muted { color:var(--muted); font-size:12px; }
  .ops button { display:block; width:100%; text-align:left; margin:3px 0; padding:5px 8px; } .ops button.sel { border-color:var(--blue); background:#eef4ff; } .ops .m { font-weight:600; margin-top:6px; font-size:12px; color:var(--muted); }
  .ops button.none { color:#9ca3af; border-style:dashed; }
  form label { display:block; margin:6px 0; font-size:13px; } form input, form textarea, form select { width:100%; font:inherit; font-size:13px; padding:5px 8px; border:1px solid #d0d7de; border-radius:6px; }
  .steps { margin:8px 0 0; padding-left:18px; font-size:12px; color:var(--muted); }
  .res { margin-top:10px; border-radius:8px; padding:8px 10px; font-size:13px; } .res.ok { background:var(--ok); } .res.bad { background:var(--bad); }
  .res pre { margin:6px 0 0; font-size:12px; white-space:pre-wrap; }
  .rec { border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:6px 0; font-size:12px; background:#fff; }
  .rec .rh { display:flex; gap:8px; align-items:baseline; margin-bottom:4px; } .rec .rh b { font-size:13px; } .rec .rh .v { color:var(--muted); font-size:11px; }
  .rec .chg { border-color:#f2c57c; background:#fffbf0; }
  .kv { display:grid; grid-template-columns: minmax(110px, 38%) 1fr; column-gap:10px; row-gap:2px; }
  .kv .k { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .kv .k[title] { cursor:help; }
  .kv .n { font-variant-numeric: tabular-nums; } .kv .b { color:#166534; } .kv .b.no { color:#9ca3af; }
  .kv .sub { grid-column:1 / -1; margin:2px 0 4px 12px; padding-left:8px; border-left:2px solid var(--line); }
  .kv .list { grid-column:1 / -1; margin:2px 0 4px 12px; }
  .kv .list .item { padding-left:8px; border-left:2px solid var(--line); margin:3px 0; }
  .kv .list .item .kv { font-size:12px; }
  .agg-h { display:flex; align-items:baseline; gap:8px; margin:12px 0 2px; } .agg-h h3 { margin:0; }
  .tags { color:var(--muted); font-size:11px; }
  .ev { font-size:12px; padding:4px 0; border-bottom:1px solid var(--line); } .ev b { color:var(--blue); } .ev .d { color:var(--muted); }
  .story select { width:100%; font:inherit; font-size:13px; padding:5px; margin-bottom:6px; }
  .step { border:1px solid var(--line); border-radius:8px; padding:6px 8px; margin:5px 0; font-size:12px; }
  .step .hd { display:flex; gap:8px; align-items:center; } .step .n { font-weight:700; } .step .day { color:var(--muted); } .step .sp { flex:1; }
  .step.ok { border-color:#9ccc9c; background:#f4fbf4; } .step.bad { border-color:#e5a0a0; background:#fff5f5; } .step.skip { opacity:.7; }
  .step .txt { margin-top:3px; } .step .facts { margin-top:4px; color:var(--muted); } .step .facts b { color:#111; }
  .step .out { margin-top:4px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size:12px; background:var(--lo); padding:1px 4px; border-radius:4px; }
  .tabs { display:flex; gap:6px; margin-bottom:6px; } .tabs button.on { background:#eef4ff; border-color:var(--blue); }
`
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>原型</title><style>${CSS}</style></head><body>
<header><h1 id="title">原型</h1><a href="http://127.0.0.1:4871/" target="story">框架图 ↗</a><a href="http://127.0.0.1:4871/model" target="model">模型图 ↗</a><span class="sp"></span><span class="st" id="st"></span><button id="rebuild">重新编译</button><button id="reset">重置状态</button></header>
<main>
  <div class="col">
    <div class="box story"><h2>按故事走</h2><select id="story-sel"></select><div><button id="run-all" class="primary">从头走到底</button> <span class="muted">每步用模型师填的输入跑一次，和故事写的事实并排</span></div><div id="steps"></div></div>
    <div class="box"><h2>命令与查询</h2><div class="ops" id="ops"></div></div>
  </div>
  <div class="col">
    <div class="box" id="form-box"><h2 id="op-title">选一个命令</h2><div class="muted" id="op-meta"></div><form id="form"></form><div id="res"></div></div>
  </div>
  <div class="col">
    <div class="box" id="state-box"><div class="tabs"><button data-t="state" class="on">聚合状态</button><button data-t="events">事件流水</button></div><div id="state"></div><div id="events" hidden></div></div>
  </div>
</main>
<script>
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
let D = null, M = null, sel = null, storyId = null, stepState = {}
const api = (p, body) => fetch('/api' + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
async function load() { D = await (await fetch('/data')).json(); M = await api('/manifest'); document.title = '原型 · ' + D.system; $('#title').textContent = '原型 · ' + D.system; renderOps(); renderStories(); refresh() }
function registered(op) { return (op.kind === 'command' ? M.commands : M.queries).includes(op.q) }
function renderOps() {
  const mods = [...new Set(D.ops.map(o => o.module))]
  $('#ops').innerHTML = mods.map(m => '<div class="m">' + esc(m) + '</div>' + D.ops.filter(o => o.module === m).map(o => '<button data-op="' + esc(o.q) + '" class="' + (sel === o.q ? 'sel' : '') + (registered(o) ? '' : ' none') + '" title="' + (registered(o) ? '' : '原型还没登记') + '">' + (o.kind === 'query' ? '查 ' : '') + esc(o.name) + '<span class="muted"> · ' + esc(o.actor) + '</span></button>').join('')).join('')
  document.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', () => { sel = b.dataset.op; renderOps(); renderForm() }))
}
function fieldFor(p, v) {
  const t = String(p.type || 'string').toLowerCase(), val = v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))
  if (t === 'boolean') return '<select name="' + esc(p.name) + '" data-t="boolean"><option value="">（空）</option><option' + (val === 'true' ? ' selected' : '') + '>true</option><option' + (val === 'false' ? ' selected' : '') + '>false</option></select>'
  if (t === 'number' || t === 'integer') return '<input name="' + esc(p.name) + '" data-t="number" type="number" step="any" value="' + esc(val) + '">'
  if (t === 'date') return '<input name="' + esc(p.name) + '" data-t="string" type="date" value="' + esc(val) + '">'
  if (t === 'string') return '<input name="' + esc(p.name) + '" data-t="string" value="' + esc(val) + '">'
  return '<textarea name="' + esc(p.name) + '" data-t="json" rows="3" placeholder="JSON">' + esc(val) + '</textarea>'
}
function renderForm(prefill) {
  const op = D.ops.find(o => o.q === sel); if (!op) return
  $('#op-title').textContent = (op.kind === 'query' ? '查询 ' : '命令 ') + op.q
  $('#op-meta').innerHTML = '执行者 ' + esc(op.actor) + (op.traces.length ? ' · ' + op.traces.map(t => '<code title="' + esc(D.business[t]?.text || '') + '">' + t + '</code>').join(' ') : '') + (op.throws.length ? '<br>可能拒绝：' + op.throws.map(e => '<code title="' + esc(D.errors[e]?.condition || '') + '">' + esc(e) + '</code>').join(' ') : '') + (op.steps.length ? '<ol class="steps">' + op.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '')
  $('#form').innerHTML = op.input.map(p => '<label>' + esc(p.name) + ' <span class="muted">' + esc(p.type) + '</span>' + fieldFor(p, prefill?.[p.name]) + '</label>').join('') + '<button class="primary" type="submit"' + (registered(op) ? '' : ' disabled') + '>' + (registered(op) ? '执行' : '原型还没登记这个') + '</button>'
  $('#res').innerHTML = ''
}
function readForm() {
  const out = {}
  for (const el of $('#form').elements) { if (!el.name) continue; const v = el.value; if (v === '') continue; out[el.name] = el.dataset.t === 'number' ? Number(v) : el.dataset.t === 'boolean' ? v === 'true' : el.dataset.t === 'json' ? JSON.parse(v) : v }
  return out
}
function showResult(el, r) {
  if (r.ok) el.innerHTML = '<div class="res ok">成功' + (r.result !== undefined && r.result !== null ? '<div style="margin-top:6px">' + kv(unwrap(r.result)) + '</div>' : '') + (r.events.length ? '<div>发出：' + r.events.map(e => '<b>' + esc(e.name) + '</b>').join('、') + '</div>' : '') + '</div>'
  else { const known = D.errors[r.error.name]; el.innerHTML = '<div class="res bad">拒绝：<b>' + esc(r.error.name) + '</b>' + (known ? '<div>' + esc(known.condition) + (known.traces.length ? ' <span class="muted">' + known.traces.join(' ') + '</span>' : '') + '</div>' : '') + '<pre>' + esc(r.error.message) + '</pre></div>' }
}
$('#form').addEventListener('submit', async (ev) => { ev.preventDefault(); const op = D.ops.find(o => o.q === sel); let input; try { input = readForm() } catch (e) { $('#res').innerHTML = '<div class="res bad">输入不是合法 JSON</div>'; return } const r = await api('/run', { kind: op.kind, name: op.q, input }); showResult($('#res'), r); refresh() })
async function refresh() {
  const st = await api('/state'), ev = await api('/events')
  $('#state').innerHTML = Object.keys(st).length ? Object.entries(st).map(([name, rows]) => '<div class="agg-h"><h3>' + esc(name) + '</h3><span class="tags">' + rows.length + ' 条</span></div>' + (rows.length ? records(rows) : '<div class="muted">（空）</div>')).join('') : '<div class="muted">原型没登记仓储</div>'
  $('#events').innerHTML = ev.length ? ev.slice().reverse().map(e => '<div class="rec"><div class="rh"><b>' + esc(e.name) + '</b><span class="v">' + esc(e.at.slice(11, 19)) + (e.during ? ' · ' + esc(e.during) : '') + '</span></div>' + kv(unwrap(e.payload), ['eventId', 'occurredAt']) + '</div>').join('') : '<div class="muted">还没有事件</div>'
  $('#st').textContent = '状态已刷新 ' + new Date().toLocaleTimeString()
}
function unwrap(v) { if (Array.isArray(v)) return v.map(unwrap); if (v && typeof v === 'object') { if (v.props && typeof v.props === 'object' && Object.keys(v).every(k => ['props', 'id', 'version', '_version'].includes(k))) { const o = { ...(v.id !== undefined ? { id: v.id } : {}), ...(v.version !== undefined ? { version: v.version } : {}), ...unwrap(v.props) }; return Object.keys(o).length === 1 && 'value' in o ? o.value : o } const o = {}; for (const k in v) o[k] = unwrap(v[k]); return o } return v }
const ISO = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?$/
const MONEY = /(amount|price|budget|balance|total|allocation|gst|fee|cost)/i
function fmtv(k, v) {
  if (v === undefined || v === null || v === '') return '<span class="muted">—</span>'
  if (typeof v === 'boolean') return '<span class="b' + (v ? '' : ' no') + '">' + (v ? '是' : '否') + '</span>'
  if (typeof v === 'number') return '<span class="n">' + (MONEY.test(k) && Number.isFinite(v) ? v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v)) + '</span>'
  if (typeof v === 'string') { if (ISO.test(v)) return esc(v.slice(0, 10)) + (v.slice(11, 19) !== '00:00:00' ? ' <span class="muted">' + esc(v.slice(11, 19)) + '</span>' : ''); return esc(v) }
  return esc(String(v))
}
function kv(obj, skip = []) {
  if (!obj || typeof obj !== 'object') return fmtv('', obj)
  let h = '<div class="kv">'
  for (const [k, v] of Object.entries(obj)) {
    if (skip.includes(k)) continue
    if (Array.isArray(v)) {
      if (!v.length) { h += '<div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div><span class="muted">（空）</span></div>'; continue }
      if (v.every(x => x === null || typeof x !== 'object')) { h += '<div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div>' + v.map(x => fmtv(k, x)).join('、') + '</div>'; continue }
      h += '<div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div class="tags">' + v.length + ' 项</div><div class="list">' + v.map((x, i) => '<div class="item">' + kv(x) + '</div>').join('') + '</div>'
      continue
    }
    if (v && typeof v === 'object') { h += '<div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div></div><div class="sub">' + kv(v) + '</div>'; continue }
    h += '<div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div>' + fmtv(k, v) + '</div>'
  }
  return h + '</div>'
}
function records(rows) {
  rows = unwrap(rows)
  return rows.map(r => { const o = r && typeof r === 'object' ? r : { value: r }; return '<div class="rec"><div class="rh"><b>' + esc(o.id ?? '（无 id）') + '</b>' + (o.version !== undefined ? '<span class="v">v' + esc(o.version) + '</span>' : '') + '</div>' + kv(o, ['id', 'version']) + '</div>' }).join('')
}
function resolveName(w) { const kind = w.kind === 'query' ? 'query' : 'command'; const list = kind === 'query' ? M.queries : M.commands; if (list.includes(w.name)) return { kind, q: w.name }; const hit = list.filter(n => n.endsWith('.' + w.name)); return { kind, q: hit.length === 1 ? hit[0] : null } }
function renderStories() {
  $('#story-sel').innerHTML = '<option value="">（选一条故事）</option>' + D.stories.map(s => '<option value="' + esc(s.slice) + '"' + (s.slice === storyId ? ' selected' : '') + '>' + esc(s.slice) + ' ' + esc(s.title) + '</option>').join('')
  const st = D.stories.find(s => s.slice === storyId)
  $('#steps').innerHTML = st ? st.steps.map(s => {
    const w = s.walk, r = w && w.kind !== 'none' && w.input ? resolveName(w) : null
    const can = !!(r && r.q), state = stepState[s.n]
    const cls = 'step' + (state ? ' ' + state.cls : '') + (can ? '' : ' skip')
    return '<div class="' + cls + '" id="stp-' + s.n + '"><div class="hd"><span class="n">' + s.n + '</span><span class="day">' + esc(s.day) + '</span><span>' + esc(s.actor) + '</span><span class="sp"></span>' + (can ? '<button data-run="' + s.n + '">走这步</button>' : '<span class="muted" title="' + esc(w ? (w.kind === 'none' ? '模型里没有动作' : !w.input ? '模型师还没填 walk.input' : '原型没登记 ' + w.name) : '还没有走法') + '">' + (w && w.kind === 'none' ? '无动作' : '不可走') + '</span>') + '</div><div class="txt">' + esc(s.text) + '</div>' + (Object.keys(s.facts).length ? '<div class="facts">故事说：' + Object.entries(s.facts).map(([k, v]) => esc(k) + ' <b>' + esc(v) + '</b>').join('　') + '</div>' : '') + '<div class="out" id="out-' + s.n + '">' + (state ? state.html : '') + '</div></div>'
  }).join('') : ''
  document.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runStep(Number(b.dataset.run))))
}
async function runStep(n) {
  const st = D.stories.find(s => s.slice === storyId), s = st.steps.find(x => x.n === n), r = resolveName(s.walk)
  const res = await api('/run', { kind: r.kind, name: r.q, input: s.walk.input })
  const tmp = document.createElement('div'); showResult(tmp, res)
  stepState[n] = { cls: res.ok ? 'ok' : 'bad', html: tmp.innerHTML }
  sel = r.q; renderOps(); renderForm(s.walk.input); showResult($('#res'), res)
  renderStories(); await refresh()
  return res.ok
}
$('#run-all').addEventListener('click', async () => { if (!storyId) return; await api('/reset', {}); stepState = {}; const st = D.stories.find(s => s.slice === storyId); for (const s of st.steps) { if (!(s.walk && s.walk.kind !== 'none' && s.walk.input && resolveName(s.walk).q)) continue; const ok = await runStep(s.n); if (!ok) break } })
$('#story-sel').addEventListener('change', () => { storyId = $('#story-sel').value || null; stepState = {}; renderStories() })
$('#reset').addEventListener('click', async () => { await api('/reset', {}); stepState = {}; renderStories(); refresh() })
$('#rebuild').addEventListener('click', async () => { $('#st').textContent = '编译中…'; const r = await api('/rebuild', {}); $('#st').textContent = r.ok ? '编译完成，原型已重启' : '编译失败'; if (!r.ok) alert(r.output); M = await api('/manifest'); D = await (await fetch('/data')).json(); stepState = {}; renderOps(); renderStories(); refresh() })
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); $('#state').hidden = b.dataset.t !== 'state'; $('#events').hidden = b.dataset.t !== 'events' }))
load()
</script></body></html>`

async function serve() {
  const b = build()
  if (!b.ok) console.error('编译失败（页面仍会起，修完代码点「重新编译」）：\n' + b.output)
  const h = await startHost()
  if (!h.ok) console.error('原型宿主起不来（页面仍会起）：\n' + h.log)
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
    try {
      if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE) }
      if (req.method === 'GET' && url === '/data') return json(200, modelData())
      if (req.method === 'POST' && url === '/api/rebuild') {
        const r = build(); const s = r.ok ? await startHost() : { ok: false, log: '' }
        return json(200, { ok: r.ok && s.ok, output: r.output + (s.ok ? '' : '\n' + s.log) })
      }
      if (url.startsWith('/api/')) {
        if (!child) return json(200, url.endsWith('/manifest') ? { commands: [], queries: [], repositories: [] } : url.endsWith('/state') ? {} : url.endsWith('/events') ? [] : { ok: false, error: { name: 'NoHost', message: '原型宿主没在跑：先修代码再点重新编译' }, events: [] })
        if (req.method === 'GET') return json(200, await hostGet(url.slice(4)))
        let body = ''; req.on('data', (d) => (body += d))
        req.on('end', async () => { try { json(200, await hostReq('POST', url.slice(4), body ? JSON.parse(body) : {})) } catch (e) { json(500, { ok: false, error: { name: 'ProxyError', message: String(e.message) }, events: [] }) } })
        return
      }
      res.writeHead(404); res.end()
    } catch (e) { json(500, { error: String(e.message) }) }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log(`原型页面 ${url}（Ctrl+C 结束）`)
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
  })
  process.on('exit', () => { if (child) child.kill() })
  process.on('SIGINT', () => process.exit(0))
}

if (cmd === 'check') check()
else serve()
