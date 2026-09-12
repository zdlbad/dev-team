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
 * 顺序：故事切片按故事步骤分组（每步的标题就是故事那句话，步内命令步骤 → 记什么 → 守什么，信心低的在前）；
 *       没有故事时按重要度降序 → 信心升序 → 业务 / 模块 / 聚合分组。
 * 页首说清这页在问什么、谁答的（校验器逐条生成、校验角色先答、人只看理由站不站得住）；「其余高信心的一并同意」一键处理。
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
  .step { margin:22px 0 6px; padding:8px 12px; border-left:4px solid #1f6feb; background:#f0f6ff; border-radius:0 8px 8px 0; }
  .step .n { font-weight:700; margin-right:8px; } .step .who { color:var(--muted); margin-right:8px; } .step .cnt { color:var(--muted); font-size:12px; margin-left:8px; }
  .kind { font-size:12px; color:var(--muted); margin:10px 0 2px; }
  #status { color:var(--muted); font-size:12px; }
</style></head>
<body>
<header><h1 id="title">审阅</h1><span id="status"></span><button id="agree-high">其余高信心的一并同意</button><button id="save" class="primary">保存</button></header>
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
  if (s.reordered) return '<div class="agent none">这个命令的步骤重排过：这个位置上有一条旧裁决（' + esc(s.at) + '），讲的多半是别的一步，不作参考，请按现在这一步重新判断。</div>'
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
  const js = data.judgments || []
  const nHigh = js.filter(j => j.verdict === 'pass' && j.confidence === 'high').length, nLow = js.filter(j => j.verdict && !(j.verdict === 'pass' && j.confidence === 'high')).length, nFail = js.filter(j => j.verdict === 'fail').length
  intro.innerHTML = '<b>这一页在问什么：</b>校验器给你在故事里确认过的每一条业务语句生成一问「模型有没有把它表达出来」，给每个命令的每一步生成一问「这一步是不是只做编排」。'
    + '<b>谁答的：</b>校验角色先答（通过 / 不通过 + 理由）。<b>你只做一件事：</b>看他的理由站不站得住，同意或不同意。这些都是确认，不是新的业务问题——要你拍板的业务分岔在故事页的裁定卡上。<br>'
    + '共 ' + js.length + ' 条：校验角色高信心通过 ' + nHigh + ' 条（可以点右上角「其余高信心的一并同意」一次处理），' + '值得你看的 ' + nLow + ' 条（信心中 / 低' + (nFail ? '、不通过 ' + nFail + ' 条' : '') + '），在每一步里排在前面。'
    + (data.story ? '顺序按故事走：每一步的标题就是故事那句话，下面是这一步用到的业务在模型里对得上对不上。' : '顺序按重要度从高到低、信心从低到高。')
    + '每次改动自动保存。'
  main.appendChild(intro)
  section(main, '需人确认', data.confirms, (it, i) => {
    const opts = (it.options||[]).map((o, k) => '<option value="'+(k+1)+'">'+ (k+1) + '. ' + esc(o) + '</option>').join('')
    return '<div class="row"><select data-k="confirms" data-i="'+i+'" data-f="verdict"><option value="">— 裁决 —</option>'+opts+'<option value="accepted">接受现状</option><option value="dismissed">驳回</option></select>'
      + '<input type="text" placeholder="备注（承认例外时必填理由）" data-k="confirms" data-i="'+i+'" data-f="note"></div>'
  }, true)
  const judgmentControls = (it, i) => {
    const opts = it.verdict
      ? '<option value="agree">同意</option><option value="disagree">不同意</option>'
      : '<option value="pass">通过</option><option value="fail">不通过</option>'
    return agentBlock(it) + '<div class="row"><select data-k="judgments" data-i="'+i+'" data-f="verdict"><option value="">— 你的意见 —</option>'+opts+'</select>'
      + '<input type="text" placeholder="备注（不同意时写为什么）" data-k="judgments" data-i="'+i+'" data-f="note"></div>'
  }
  if (data.story) storySection(main, data.judgments, judgmentControls)
  else section(main, '待判断', data.judgments, judgmentControls, true)
  section(main, '警告', data.warnings, (it, i) =>
    '<div class="row"><select data-k="warnings" data-i="'+i+'" data-f="verdict"><option value="">— 处理 —</option><option value="fixed">已修</option><option value="dismissed">驳回</option></select>'
    + '<input type="text" placeholder="驳回理由" data-k="warnings" data-i="'+i+'" data-f="note"></div>', true)
  section(main, '错误（只读，必须修）', data.errors, () => '', false)
  for (const el of main.querySelectorAll('[data-k]')) {
    const it = data[el.dataset.k][el.dataset.i]
    const v = it.human?.[el.dataset.f]
    if (v !== undefined && v !== null) el.value = v
    el.addEventListener('input', () => { it.human = it.human || {}; it.human[el.dataset.f] = el.value; it.human.at = new Date().toISOString().slice(0,10); el.closest('.item').classList.toggle('done', !!it.human.verdict); scheduleSave() })
    if (it.human?.verdict) el.closest('.item').classList.add('done')
  }
}
function itemNode(it, i, controls, withGuide) {
  const d = document.createElement('div'); d.className = 'item ' + (it.importance||'')
  const sides = it.sides ? '<div class="sides">' + Object.entries(it.sides).filter(([,v]) => v !== undefined).map(([k,v]) => '<b>'+({business:'业务',model:'模型',code:'代码'}[k]||k)+'</b><span>'+esc(typeof v==='string'?v:JSON.stringify(v))+'</span>').join('') + '</div>' : ''
  const mc = it.model !== undefined || it.code !== undefined ? '<div class="sides"><b>模型</b><span>'+esc(typeof it.model==='string'?it.model:JSON.stringify(it.model))+'</span><b>代码</b><span>'+esc(typeof it.code==='string'?it.code:JSON.stringify(it.code))+'</span></div>' : ''
  d.innerHTML = '<div class="target">' + esc(it.target) + '</div>' + (it.context ? '<div class="target" style="color:#555;font-family:inherit">' + esc(it.context) + '</div>' : '') + '<div class="check">' + esc(it.ask || it.check) + '</div>' + (it.ask ? '<div class="target" style="font-family:inherit">类别：' + esc(it.check) + '</div>' : '')
    + (it.text ? '<div>' + esc(it.text) + '</div>' : '') + sides + mc + (withGuide ? guideOf(it.check) : '') + controls(it, i)
  return d
}
// 一条判断牵涉哪些业务编号：目标本身是编号，或目标是模型文件（命令的某一步）→ 服务端附的该文件 traces
function idsOf(it) {
  const t = it.target || ''
  if (/^[GRU]-\d+/.test(t)) return [t.split('#')[0]]
  return (data.targetTraces || {})[t.split('#')[0]] || []
}
// 步内顺序：命令的步骤 → 能力 → 规则；同类里信心低的在前
function kindOf(it) { return /#steps\./.test(it.target||'') ? 0 : /^G-/.test(it.target||'') ? 1 : 2 }
const KIND = ['这一步在模型里怎么走（命令的步骤）', '能力', '记什么、守什么（字段、规则、错误）']
function storySection(main, items, controls) {
  const h = document.createElement('h2'); h.textContent = '待判断（' + (items||[]).length + '）· 按故事走'; main.appendChild(h)
  if (!items || !items.length) { const p = document.createElement('p'); p.className='empty'; p.textContent='（无）'; main.appendChild(p); return }
  const steps = data.story.steps || []
  const placed = new Set()
  const buckets = steps.map(() => [])
  const rest = []
  items.forEach((it, i) => {
    const ids = idsOf(it)
    const k = steps.findIndex(st => (st.traces||[]).some(id => ids.includes(id)))
    if (k >= 0) buckets[k].push({ it, i }); else rest.push({ it, i })
  })
  const order = (a, b) => kindOf(a.it) - kindOf(b.it) || (rank(a.it.confidence)||9) - (rank(b.it.confidence)||9) || (a.it.target||'').localeCompare(b.it.target||'')
  steps.forEach((st, k) => {
    const list = buckets[k]
    const hd = document.createElement('div'); hd.className = 'step'
    hd.innerHTML = '<span class="n">第 ' + esc(st.n ?? k+1) + ' 步</span><span class="who">' + esc(st.day||'') + ' · ' + esc(st.actor||'') + '</span>' + esc(st.text||'') + '<span class="cnt">' + (list.length ? list.length + ' 条' : '这一步没有要你看的') + '</span>'
    main.appendChild(hd)
    list.sort(order)
    let g = -1
    for (const { it, i } of list) {
      const kk = kindOf(it)
      if (kk !== g) { g = kk; const kh = document.createElement('div'); kh.className = 'kind'; kh.textContent = KIND[kk]; main.appendChild(kh) }
      main.appendChild(itemNode(it, i, controls, true))
    }
  })
  if (rest.length) {
    const hd = document.createElement('div'); hd.className = 'step'; hd.innerHTML = '<span class="n">不在故事步骤里的</span><span class="cnt">' + rest.length + ' 条</span>'; main.appendChild(hd)
    rest.sort(order)
    for (const { it, i } of rest) main.appendChild(itemNode(it, i, controls, true))
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
    main.appendChild(itemNode(it, i, controls, withGuide))
  }
}
async function load() { data = await (await fetch('/data')).json(); render() }
async function save(auto) {
  $('#status').textContent = '保存中…'
  try {
    const r = await fetch('/save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) })
    $('#status').textContent = r.ok ? (auto ? '已自动保存 ' : '已保存 ') + new Date().toLocaleTimeString() : '保存失败——再点一次保存'
  } catch { $('#status').textContent = '保存失败——服务没在跑？' }
}
// 每次改动 800ms 后自动写盘；保存按钮留着，随时可以手动按
let saveTimer = null
function scheduleSave() { clearTimeout(saveTimer); $('#status').textContent = '有改动，稍后自动保存'; saveTimer = setTimeout(() => save(true), 800) }
$('#save').addEventListener('click', () => { clearTimeout(saveTimer); save(false) })
$('#agree-high').addEventListener('click', () => {
  let n = 0
  for (const it of data.judgments || []) if (it.verdict === 'pass' && it.confidence === 'high' && !it.human?.verdict) { it.human = { ...(it.human||{}), verdict: 'agree', at: new Date().toISOString().slice(0,10) }; n++ }
  render(); scheduleSave(); $('#status').textContent = '已同意 ' + n + ' 条高信心的，稍后自动保存'
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
    let obj
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return res.end(fs.readFileSync(file, 'utf8')) }
    // 故事切片：附上故事步骤（页面按步骤分组），以及每个模型文件目标的 traces（命令的步骤靠它对到故事的哪一步）
    try {
      if (obj.project && obj.slice) {
        const sp = path.join(obj.project, 'slices', obj.slice + '.story.json')
        if (fs.existsSync(sp)) { const st = JSON.parse(fs.readFileSync(sp, 'utf8')); obj.story = { title: st.title, steps: (st.steps || []).map((x) => ({ n: x.n, day: x.day, actor: x.actor, text: x.text, traces: x.traces || [] })) } }
        obj.targetTraces = {}
        for (const it of obj.judgments || []) {
          const f = String(it.target || '').split('#')[0]
          if (!f.startsWith('model/') || obj.targetTraces[f]) continue
          try { obj.targetTraces[f] = JSON.parse(fs.readFileSync(path.join(obj.project, f), 'utf8')).traces || [] } catch { obj.targetTraces[f] = [] }
        }
      }
    } catch { /* 附不上就按原样给 */ }
    return res.end(JSON.stringify(obj))
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const posted = JSON.parse(body)
        // 不整份覆盖：页面加载之后，校验角色可能又补了判断、校验器可能重跑过。
        // 先读盘上现在这份，只把人填的 human 按条合进去（同一条 = 目标、检查、两侧文字都一样）。
        const key = (x) => [x.target, x.check, x.sides?.business ?? '', x.sides?.model ?? '', x.sides?.code ?? ''].join('\u0000')
        let obj = posted
        try {
          const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
          for (const arr of ['judgments', 'confirms']) {
            const mine = new Map((posted[arr] ?? []).map((x) => [key(x), x]))
            for (const it of disk[arr] ?? []) {
              const p = mine.get(key(it))
              if (p && p.human) it.human = p.human
            }
          }
          obj = disk
        } catch { /* 盘上那份读不了就按页面的存 */ }
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
