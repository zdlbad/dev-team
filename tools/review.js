#!/usr/bin/env node
/**
 * 审阅工具：本地页面渲染校验报告 JSON，人逐条审阅，保存回同一文件。
 * 用法：node tools/review.js <报告 json> [--port 4870]
 *
 * 人看到的是：每类判断的指南（问什么、什么算通过）+ 校验角色的判断（结论 / 信心 / 理由）。
 * 人只做同意 / 不同意；校验角色尚未判断的条目，人可直接给通过 / 不通过。
 * 写回的形状：条目增加 human: { verdict, note, at }
 *   - 待判断（judgments）：verdict = agree | disagree | pass | fail
 *   - 需人确认（confirms）：verdict = 选项序号 | accepted | dismissed
 *   - 警告（warnings）：verdict = fixed | dismissed
 * 顺序：重要度降序 → 校验角色的信心升序 → 业务 / 模块 / 聚合分组。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const file = process.argv[2] && path.resolve(process.argv[2])
const portIdx = process.argv.indexOf('--port')
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 4870
if (!file || !fs.existsSync(file)) {
  console.error('用法：node tools/review.js <报告 json> [--port 4870]')
  process.exit(2)
}

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>审阅</title>
<style>
  :root { --fg:#1f2328; --muted:#57606a; --line:#e6e8eb; --bg:#fff; --hi:#fff1f0; --mid:#fff8e1; --lo:#f6f8fa; --ok:#1a7f37; --bad:#cf222e; --agent:#eef4ff; }
  body { margin:0; font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color:var(--fg); background:var(--bg); }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid var(--line); padding:10px 20px; display:flex; gap:16px; align-items:center; z-index:2; }
  header h1 { font-size:16px; margin:0; flex:1; }
  button { font:inherit; padding:6px 14px; border:1px solid #d0d7de; border-radius:6px; background:#f6f8fa; cursor:pointer; }
  button.primary { background:#1f6feb; color:#fff; border-color:#1f6feb; }
  main { padding: 16px 20px 80px; max-width: 1100px; }
  .intro { background:var(--lo); border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin-bottom:8px; }
  h2 { font-size:15px; margin:24px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  h3 { font-size:13px; color:var(--muted); margin:16px 0 6px; font-weight:600; }
  .item { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; background:var(--lo); }
  .item.high { background:var(--hi); } .item.medium { background:var(--mid); }
  .item.done { opacity:.55; }
  .target { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:var(--muted); word-break:break-all; }
  .check { font-weight:600; margin:2px 0 6px; }
  .sides { display:grid; grid-template-columns: 4em 1fr; gap:2px 8px; margin:6px 0; }
  .sides b { color:var(--muted); font-weight:500; }
  .sides span { white-space:pre-wrap; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  select, input[type=text] { font:inherit; padding:4px 6px; border:1px solid #d0d7de; border-radius:4px; }
  input[type=text] { flex:1; min-width: 240px; }
  .tag { display:inline-block; font-size:11px; padding:0 6px; border-radius:10px; border:1px solid #d0d7de; color:var(--muted); margin-left:6px; }
  .agent { background:var(--agent); border-radius:6px; padding:6px 10px; margin-top:6px; }
  .agent .v { font-weight:600; } .agent .v.pass { color:var(--ok); } .agent .v.fail { color:var(--bad); }
  .agent.none { color:var(--muted); font-style:italic; }
  details { margin-top:6px; } summary { cursor:pointer; color:#0969da; font-size:13px; }
  .guide { font-size:13px; color:var(--fg); padding:6px 0 0 4px; }
  .guide dt { color:var(--muted); font-weight:500; margin-top:4px; } .guide dd { margin:0 0 0 1em; }
  .empty { color:var(--muted); }
  #status { color:var(--muted); font-size:12px; }
</style></head>
<body>
<header><h1 id="title">审阅</h1><span id="status"></span><button id="save" class="primary">保存</button></header>
<main id="main"></main>
<script>
const $ = (s, p=document) => p.querySelector(s)
let data = null
const IMP = { high:'高', medium:'中', low:'低' }
const CONF = { high:'高', medium:'中', low:'低' }
function groupKey(t) {
  const m = (t||'').match(/^model\\/([^/#]+)(?:\\/domain\\/([^/#]+))?/)
  if (!m) return /^[GRU]-/.test(t||'') ? '业务描述' : /^(src|tests)[\\/]/.test(t||'') ? (t||'').split(/[\\/]/).slice(0, 3).join('/') : '其它'
  return m[1] + (m[2] ? ' / ' + m[2] : '')
}
function rank(x) { return { high:3, medium:2, low:1 }[x] || 0 }
function esc(s) { return String(s ?? '—').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) }
function guideOf(check) {
  const g = (data.guides||{})[check]
  if (!g) return ''
  const opts = g.options ? '<dt>选项</dt><dd>' + g.options.map((o,i)=> (i+1)+'. '+esc(o)).join('<br>') + '</dd>' : ''
  return '<details><summary>怎么判断</summary><dl class="guide"><dt>问</dt><dd>'+esc(g.question)+'</dd>'
    + (g.pass ? '<dt>通过</dt><dd>'+esc(g.pass)+'</dd>' : '') + (g.fail ? '<dt>不通过</dt><dd>'+esc(g.fail)+'</dd>' : '')
    + (g.how ? '<dt>方法</dt><dd>'+esc(g.how)+'</dd>' : '') + opts + '</dl></details>'
}
function staleBlock(it) {
  const s = it.staleDecision
  if (!s) return ''
  return '<div class="agent none">上次裁决（' + esc(s.at) + '）：' + (s.verdict==='dismissed'?'无需改':'接受现状') + ' — ' + esc(s.note||'') + '。此后模型文字已变，请重新判断。</div>'
}
function agentBlock(it) {
  if (!it.verdict) return staleBlock(it) + '<div class="agent none">校验角色尚未判断——请直接给出通过 / 不通过。</div>'
  return staleBlock(it) + '<div class="agent">校验角色：<span class="v '+it.verdict+'">'+(it.verdict==='pass'?'通过':'不通过')+'</span>'
    + '<span class="tag">信心 '+(CONF[it.confidence]||'—')+'</span> ' + esc(it.reason||'') + '</div>'
}
function render() {
  $('#title').textContent = '审阅 · 方向 ' + data.direction + ' · ' + (data.project||'').split(/[\\\\/]/).pop()
  const main = $('#main'); main.innerHTML = ''
  const intro = document.createElement('div'); intro.className='intro'
  intro.innerHTML = '<b>怎么用：</b>每条都先显示校验角色的判断和理由，你只需要<b>同意</b>或<b>不同意</b>；不确定时展开「怎么判断」。'
    + '顺序是重要度从高到低、校验角色信心从低到高——最值得你看的排在最前。做完点右上角保存。'
  main.appendChild(intro)
  section(main, '需人确认', data.confirms, (it, i) => {
    const opts = (it.options||[]).map((o, k) => '<option value="'+(k+1)+'">'+ (k+1) + '. ' + esc(o) + '</option>').join('')
    return '<div class="row"><select data-k="confirms" data-i="'+i+'" data-f="verdict"><option value="">— 裁决 —</option>'+opts+'<option value="accepted">接受现状</option><option value="dismissed">驳回</option></select>'
      + '<input type="text" placeholder="备注（承认例外时必填理由）" data-k="confirms" data-i="'+i+'" data-f="note"></div>'
  }, true)
  section(main, '待判断', data.judgments, (it, i) => {
    const opts = it.verdict
      ? '<option value="agree">同意</option><option value="disagree">不同意</option>'
      : '<option value="pass">通过</option><option value="fail">不通过</option>'
    return agentBlock(it) + '<div class="row"><select data-k="judgments" data-i="'+i+'" data-f="verdict"><option value="">— 你的意见 —</option>'+opts+'</select>'
      + '<input type="text" placeholder="备注（不同意时写为什么）" data-k="judgments" data-i="'+i+'" data-f="note"></div>'
  }, true)
  section(main, '警告', data.warnings, (it, i) =>
    '<div class="row"><select data-k="warnings" data-i="'+i+'" data-f="verdict"><option value="">— 处理 —</option><option value="fixed">已修</option><option value="dismissed">驳回</option></select>'
    + '<input type="text" placeholder="驳回理由" data-k="warnings" data-i="'+i+'" data-f="note"></div>', true)
  section(main, '错误（只读，必须修）', data.errors, () => '', false)
  for (const el of main.querySelectorAll('[data-k]')) {
    const it = data[el.dataset.k][el.dataset.i]
    const v = it.human?.[el.dataset.f]
    if (v !== undefined && v !== null) el.value = v
    el.addEventListener('input', () => { it.human = it.human || {}; it.human[el.dataset.f] = el.value; it.human.at = new Date().toISOString().slice(0,10); el.closest('.item').classList.toggle('done', !!it.human.verdict) })
    if (it.human?.verdict) el.closest('.item').classList.add('done')
  }
}
function section(main, title, items, controls, withGuide) {
  const h = document.createElement('h2'); h.textContent = title + '（' + (items||[]).length + '）'; main.appendChild(h)
  if (!items || !items.length) { const p = document.createElement('p'); p.className='empty'; p.textContent='（无）'; main.appendChild(p); return }
  const idx = items.map((it, i) => ({ it, i }))
  idx.sort((a, b) => rank(b.it.importance) - rank(a.it.importance) || (rank(a.it.confidence)||9) - (rank(b.it.confidence)||9) || groupKey(a.it.target).localeCompare(groupKey(b.it.target)))
  let g = null
  for (const { it, i } of idx) {
    const k = (it.importance ? '重要度 ' + IMP[it.importance] + ' · ' : '') + groupKey(it.target)
    if (k !== g) { g = k; const h3 = document.createElement('h3'); h3.textContent = k; main.appendChild(h3) }
    const d = document.createElement('div'); d.className = 'item ' + (it.importance||'')
    const sides = it.sides ? '<div class="sides">' + Object.entries(it.sides).filter(([,v]) => v !== undefined).map(([k,v]) => '<b>'+({business:'业务',model:'模型',code:'代码'}[k]||k)+'</b><span>'+esc(typeof v==='string'?v:JSON.stringify(v))+'</span>').join('') + '</div>' : ''
    const mc = it.model !== undefined || it.code !== undefined ? '<div class="sides"><b>模型</b><span>'+esc(typeof it.model==='string'?it.model:JSON.stringify(it.model))+'</span><b>代码</b><span>'+esc(typeof it.code==='string'?it.code:JSON.stringify(it.code))+'</span></div>' : ''
    d.innerHTML = '<div class="target">' + esc(it.target) + '</div><div class="check">' + esc(it.check) + '</div>'
      + (it.text ? '<div>' + esc(it.text) + '</div>' : '') + sides + mc + (withGuide ? guideOf(it.check) : '') + controls(it, i)
    main.appendChild(d)
  }
}
async function load() { data = await (await fetch('/data')).json(); render() }
$('#save').addEventListener('click', async () => {
  const r = await fetch('/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) })
  $('#status').textContent = r.ok ? '已保存 ' + new Date().toLocaleTimeString() : '保存失败'
})
load()
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }
  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(fs.readFileSync(file, 'utf8'))
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const obj = JSON.parse(body)
        fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
        res.writeHead(200)
        res.end('ok')
        console.log(`已保存 ${new Date().toLocaleTimeString()}`)
      } catch (e) {
        res.writeHead(400)
        res.end(String(e.message))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.log(`审阅：${file}\n打开 ${url}（Ctrl+C 结束）`)
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
})
