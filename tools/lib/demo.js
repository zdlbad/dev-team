/**
 * 「演示」页：把讲解写的演示文档（导读/演示-*.md）画成可切换的竖向时间轴。
 *
 * 为什么有这一页（2026-09-21，项目所有者）：他要一份给人现场演示用的文档——「多账户，主要以 happy path 为主，
 * 特例为辅；两个阶段，开 funding，录入服务」「从上到下的时间轴＋步骤的视图，战线不要拉得太长」「可以多场景 可切换」。
 * 讲解写内容（人物、金额、每步的出处），这一页只管把它摆成看的人一次只看一个场景、按一下换一个。
 *
 * 讲解那份文件的格式（机械地一致，不齐就切不出来）：
 *   # 标题
 *   ## 场景 1：<一句话>            ← 一个场景
 *   > 切换名：两本账主线            ← 给切换按钮用的短名（可省，省了用场景标题）
 *   > 模块：资金账户                 ← 这个场景属于哪个模块（可省；省了归「总览」）。页面顶部一排标签页按模块切、
 *                                       下面一排按场景切（2026-09-21 项目所有者：「演示的场景按模块分，顶部标签页切换」）
 *   > 模块顺序：资金账户、可申报账目  ← 写在第一个 ## 之前，定顶部标签页的先后（可省；省了按文中先出现的先排，「总览」最前）
 *   ### 一、开资金账户              ← 阶段标题（### 或 ####，或整行加粗）
 *   第 1 步 · 2026-03-03 · 案例经理 · 做了什么 → 账上发生了什么（金额）· R-101、R-102 · 走查 k-001 第 12～14 步
 *                                                          ↑依据            ↑这一步出自走查的哪一步（可省）
 *   ...
 * 对不上「第 n 步」格式的行，原样当成说明摆在那个位置，不丢。
 *
 * 「· 走查 k-001 第 12 步」这一栏（2026-09-21 项目所有者：「演示步骤连回走查」）：演示是从走查改写来的，
 * 一句话压掉走查的两三步、日子挪过、金额取整，看的人问「这一步原本是怎么走的」时得跳得回去。
 * 写一步或一段都行（第 12 步 / 第 12～14 步），链接指到那一段的头一步。
 *
 * 卡片下留言（2026-09-21 项目所有者：「卡片下给我一个留 note 的 feature」）：看的人在每一步卡片下写一句，
 * 存在 导读/<演示文件名>.notes.json，键是「切换名|第 n 步」（场景改号也不丢），值是 [{ at: 本地时间, text }]。
 * 讲解下一趟改文档前先读这份文件——留言就是他对那一步的话。
 */
const fs = require('node:fs')
const path = require('node:path')
const mel = require('./time')
const tl = require('./timeline')

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
/** 行内的 `代码`、**加粗** 两种最常见的标记转成 HTML，其余原样 */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  // 术语后面括号里的英文法定名（「持续服务资金账户（OngoingServicesAccount）」，2026-09-21 项目所有者要的）压成小字灰字，别抢中文
  .replace(/（([A-Z][A-Za-z0-9]*(?:\s[A-Z][A-Za-z0-9]*)*)）/g, '<span class="en">（$1）</span>')

const notesPath = (root, file) => path.join(root, '导读', file.replace(/\.md$/, '') + '.notes.json')
const readNotes = (root, file) => { try { return JSON.parse(fs.readFileSync(notesPath(root, file), 'utf8')) } catch { return {} } }
const writeNotes = (root, file, notes) => fs.writeFileSync(notesPath(root, file), JSON.stringify(notes, null, 2) + '\n')
const localNow = () => { const p = mel.parts(new Date()); return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : new Date().toISOString() }
/** 在某一步下留一句；返回这一步现在的全部留言 */
function addNote(root, file, key, text) {
  const notes = readNotes(root, file)
  ;(notes[key] ??= []).push({ at: localNow(), text })
  writeNotes(root, file, notes)
  return notes[key]
}
/** 删掉某一步的第 i 句 */
function deleteNote(root, file, key, i) {
  const notes = readNotes(root, file)
  if (!notes[key] || !notes[key][i]) return notes[key] ?? []
  notes[key].splice(i, 1)
  if (!notes[key].length) delete notes[key]
  writeNotes(root, file, notes)
  return notes[key] ?? []
}
const noteKey = (label, n) => `${label}|第 ${n} 步`

/** 一行「第 n 步 · 日期 · 谁 · 做了什么 → 结果 · 依据」拆成几栏；拆不出来返回 null */
function parseStep(line) {
  const m = /^(?:[-*]\s*)?第\s*(\d+)\s*步\s*[·・|]\s*(.*)$/.exec(line.trim())
  if (!m) return null
  const parts = m[2].split(/\s*[·・|]\s*/)
  if (parts.length < 3) return null
  // 「· 走查 k-001 第 12～14 步」：这一步出自走查的哪一步，摘出来单摆，剩下的照旧认依据
  let from = null
  for (let i = parts.length - 1; i >= 2; i--) {
    const f = /^走查\s*(k-\d{3})\s*第\s*(\d+)(?:\s*[～~-]\s*(\d+))?\s*步$/.exec(parts[i].trim())
    if (!f) continue
    from = { slice: f[1], n: Number(f[2]), to: f[3] ? Number(f[3]) : null }
    from.text = `${from.slice} 第 ${from.n}${from.to ? '～' + from.to : ''} 步`
    parts.splice(i, 1)
    break
  }
  const [date, who, ...rest] = parts
  // 「做了什么 → 结果」可能自己带着分隔符（金额里的顿号不算），所以从后往前认依据：形如 R-xxx、第几批、G-xxx 的那一段
  let basis = ''
  // 讲解写的是「· 依据 R-012、R-028」，带着「依据」两个字；只认编号开头会把整段依据落进结果那一栏（2026-09-21 第一份就这样）
  const last = rest.length > 1 ? rest[rest.length - 1].replace(/^依据[：:]?\s*/, '') : ''
  if (last && /^(?:[RGU]-\d+|第[一二三四五六七八九十百零〇\d]+批|走查)/.test(last)) { rest.pop(); basis = last }
  const body = rest.join(' · ')
  const arrow = body.split(/\s*(?:→|->|=>)\s*/)
  return { n: Number(m[1]), date, who, action: arrow[0] ?? '', result: arrow.slice(1).join(' → '), basis, from }
}

/** 一份演示文档 → { title, scenarios: [{ title, label, blocks: [{ heading, items: [{ step } | { note }] }] }] } */
function parseDemo(text) {
  const lines = text.split('\n')
  const doc = { title: '', preface: [], scenarios: [], moduleOrder: [], groups: [] }
  let sc = null, block = null
  const ensureBlock = () => { if (!sc) return null; if (!block) { block = { heading: null, items: [] }; sc.blocks.push(block) } return block }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    let m
    if ((m = /^#\s+(.*)$/.exec(line))) { doc.title = m[1].trim(); continue }
    if ((m = /^##\s+(.*)$/.exec(line))) { sc = { title: m[1].trim(), label: null, blocks: [] }; block = null; doc.scenarios.push(sc); continue }
    if ((m = /^>\s*切换名[：:]\s*(.*)$/.exec(line)) && sc) { sc.label = m[1].trim(); continue }
    if ((m = /^>\s*模块顺序[：:]\s*(.*)$/.exec(line))) { doc.moduleOrder = m[1].split(/[、,，]\s*/).map((x) => x.trim()).filter(Boolean); continue }
    if ((m = /^>\s*模块[：:]\s*(.*)$/.exec(line)) && sc) { sc.module = m[1].trim(); continue }
    if ((m = /^#{3,4}\s+(.*)$/.exec(line)) || (m = /^\*\*([^*]+)\*\*\s*$/.exec(line))) {
      if (!sc) { doc.preface.push(line); continue }
      block = { heading: m[1].trim(), items: [] }; sc.blocks.push(block); continue
    }
    const step = parseStep(line)
    if (!sc) { doc.preface.push(line); continue }
    const b = ensureBlock()
    if (step) b.items.push({ step })
    // 列表符号要带空格才算：不然「**人物**（…）」开头的星号会被当成列表符号啃掉一个，页面上显示成「*人物**」
    else b.items.push({ note: line.replace(/^(?:[-*]\s+|>\s*)/, '') })
  }
  // 没写切换名的：场景标题去掉「场景 n：」当按钮名；不是场景的节（开场、编号怎么查）用整个标题
  for (const s of doc.scenarios) if (!s.label) s.label = /^场景\s*\d+/.test(s.title) ? s.title.replace(/^场景\s*\d+\s*[：:]\s*/, '').slice(0, 10) : s.title.slice(0, 14)
  // 按模块分组：没标模块的节归「总览」（开场、编号怎么查、总表都是）；顺序照「模块顺序」，没写的按先出现排，「总览」最前
  const OVERVIEW = '总览'
  const names = []
  for (const s of doc.scenarios) { const g = s.module || OVERVIEW; if (!names.includes(g)) names.push(g) }
  const order = [...doc.moduleOrder.filter((n) => names.includes(n))]
  if (names.includes(OVERVIEW) && !order.includes(OVERVIEW)) order.unshift(OVERVIEW)
  for (const n of names) if (!order.includes(n)) order.push(n)
  doc.groups = order.map((name) => ({ name, scenarios: doc.scenarios.map((s, i) => ((s.module || OVERVIEW) === name ? i : -1)).filter((i) => i >= 0) }))
  return doc
}

const CSS = `<style>
/* 字号与版面（2026-09-21 项目所有者两次要求：字体大一些；时间轴放在中间偏左、两侧留白；右侧描述再放大、卡片方式显示） */
.demo{font-size:16px;line-height:1.55;max-width:1120px;margin-left:max(0px,calc((100% - 1120px)*.4))}
.demo h1{font-size:24px;margin:0 0 8px}.demo .pre{color:#57606a;font-size:15px;margin:0 0 16px}
.demo .bar{position:sticky;top:0;background:#fff;z-index:2;margin:0 0 20px}
.demo .mods{display:flex;flex-wrap:wrap;gap:0 4px;border-bottom:2px solid #e6e8eb;margin:0 0 10px}
.demo .mods button{font:inherit;font-size:17px;font-weight:600;padding:10px 18px 8px;border:0;border-bottom:3px solid transparent;margin-bottom:-2px;background:none;color:#57606a;cursor:pointer}
.demo .mods button.on{color:#1f2328;border-bottom-color:#1f6feb}
.demo .mods button .cnt{font-size:13px;font-weight:400;color:#8c959f;margin-left:6px}
.demo .tabs{display:none;flex-wrap:wrap;gap:8px;padding:4px 0}.demo .tabs.on{display:flex}
.demo .tabs button{font:inherit;font-size:15px;padding:7px 16px;border-radius:999px;border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;cursor:pointer}
.demo .tabs button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
.demo .sc{display:none}.demo .sc.on{display:block}
.demo .sc>h2{font-size:20px;margin:0 0 16px}
.demo h3{font-size:16px;color:#57606a;margin:26px 0 10px;letter-spacing:.02em}
.demo .tl{position:relative;margin:0 0 6px 0;padding-left:0}
${tl.css({ sel: '.demo .st', when: 136, gap: 14, top: 26, narrow: 720, padY: 14 })}
.demo .st{margin:0 0 18px;align-items:start}
.demo .st>.when{font-size:14px}.demo .st>.when b{font-size:15px}
.demo .st>.dot{border-color:#1f6feb}
.demo .st>.card{font-size:17.5px;line-height:1.65}
.demo .st+.st>.card{border-top:1px solid #f2f4f6}
.demo .st .n{font-size:13.5px;color:#8c959f;margin-right:8px}
.demo .st .act{font-weight:600}
.demo .st .res{margin-top:8px;color:#1f2328}.demo .st .res::before{content:"→ ";color:#1f6feb;font-weight:700}
.demo .st .basis{margin-top:10px;font-size:14px;color:#57606a;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}.demo .st .basis code{background:#f6f8fa;padding:1px 6px;border-radius:4px}
.demo .st .basis .from{color:#1f6feb;text-decoration:none;border:1px solid #d6e4fb;background:#f4f8ff;border-radius:999px;padding:1px 10px;white-space:nowrap}
.demo .st .basis .from:hover{border-color:#1f6feb;background:#eaf2ff}
.demo .en{font-size:.85em;color:#6e7781;font-weight:400;letter-spacing:0}
.demo .note{margin:0 0 10px 178px;padding:2px 0 2px 12px;color:#57606a;font-size:16px;border-left:2px solid #e6e8eb}
.demo .notes{grid-column:3;margin:-10px 0 0;padding:0 0 4px 2px}
.demo .notes .nt{display:flex;gap:10px;align-items:baseline;font-size:15px;color:#57606a;padding:4px 0}.demo .notes .nt .at{font-size:12.5px;color:#8c959f;white-space:nowrap}.demo .notes .nt .tx{flex:1;color:#1f2328}
.demo .notes .nt .del{border:0;background:none;color:#8c959f;cursor:pointer;font-size:14px;padding:0 4px}.demo .notes .nt .del:hover{color:#cf222e}
.demo .notes .add{font-size:13.5px;color:#8c959f;cursor:pointer;background:none;border:0;padding:2px 0}.demo .notes .add:hover{color:#1f6feb}
.demo .notes textarea{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:8px 10px;border:1px solid #d0d7de;border-radius:8px;margin:4px 0 6px;min-height:60px}
.demo .notes .save{font:inherit;font-size:14px;padding:5px 14px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer}.demo .notes .cancel{font:inherit;font-size:14px;margin-left:8px;border:0;background:none;color:#57606a;cursor:pointer}
.demo .notes.has .add{color:#57606a}
.demo .empty{padding:16px 0 16px 14px;color:#57606a;border-left:3px solid #e6e8eb}
.demo .files{margin:0 0 12px;font-size:14px;color:#57606a}.demo .files a{color:#1f6feb;margin-right:12px}
@media (max-width:720px){.demo .notes{grid-column:1}.demo .note{margin-left:0}.demo{margin-left:0}}
</style>`

function noteItemsHtml(list) {
  return (list ?? []).map((n, i) => `<div class="nt"><span class="at">${esc(n.at)}</span><span class="tx">${esc(n.text)}</span><button class="del" data-i="${i}" title="删掉这一句">×</button></div>`).join('')
}
function stepHtml(s, key, notes, pos = '') {
  const list = notes?.[key] ?? []
  const card = `<div><span class="n">第 ${s.n} 步</span><span class="act">${inline(s.action)}</span></div>` +
    (s.result ? `<div class="res">${inline(s.result)}</div>` : '') +
    (s.basis || s.from ? `<div class="basis">` +
      (s.basis ? `依据 <code>${esc(s.basis)}</code>` : '') +
      (s.from ? `<a class="from" href="/p/story/story?slice=${encodeURIComponent(s.from.slice)}#step-${s.from.n}" target="story" title="到走查里看这一步">走查 ${esc(s.from.text)} ↗</a>` : '') +
      `</div>` : '')
  const extra = `<div class="notes${list.length ? ' has' : ''}" data-key="${esc(key)}"><div class="list">${noteItemsHtml(list)}</div><button class="add">＋ 留一句</button></div>`
  return tl.row({ cls: ['st', pos].filter(Boolean).join(' '), date: s.date, who: s.who, card, extra })
}

/** 整页的 HTML 正文（不含 <html> 外壳，工作台用 wrap 包） */
function demoPage(root, which = null) {
  const dir = path.join(root, '导读')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^演示.*\.md$/.test(f)).sort() : []
  // 静态演示（第一百九十四批）：原型照走查出的一叠页面，demo/<切片>/index.html，开新窗口按着走
  const sdir = path.join(root, 'demo')
  const statics = fs.existsSync(sdir) ? fs.readdirSync(sdir).filter((d) => fs.existsSync(path.join(sdir, d, 'index.html'))).sort() : []
  const staticBar = statics.length ? `<div class="files">静态演示（一步一屏，按着走）：${statics.map((d) => `<a href="/demo-static/${encodeURIComponent(d)}/index.html" target="_blank">${esc(d)}</a>　`).join('')}</div>` : ''
  if (!files.length) {
    return CSS + `<div class="demo">${staticBar}<h1>演示</h1><div class="empty">还没有演示文档。讲解写到 <code>导读/演示-&lt;题&gt;.md</code>：一个 <code>## 场景</code> 一条时间轴，每步一行「第 n 步 · 日期 · 谁 · 做了什么 → 账上发生了什么 · 依据编号」，这一页就把它摆成可切换的视图。</div></div>`
  }
  const file = which && files.includes(which) ? which : files[0]
  const doc = parseDemo(fs.readFileSync(path.join(dir, file), 'utf8'))
  const notes = readNotes(root, file)
  const picker = files.length > 1 ? `<div class="files">几份演示文档：${files.map((f) => f === file ? `<b>${esc(f)}</b>　` : `<a href="/demo?file=${encodeURIComponent(f)}">${esc(f)}</a>`).join('')}</div>` : ''
  const mods = doc.groups.map((g, gi) => `<button data-g="${gi}"${gi === 0 ? ' class="on"' : ''}>${esc(g.name)}<span class="cnt">${g.scenarios.length}</span></button>`).join('')
  const tabs = doc.groups.map((g, gi) => `<div class="tabs${gi === 0 ? ' on' : ''}" data-g="${gi}">` +
    g.scenarios.map((i) => `<button data-sc="${i}"${i === g.scenarios[0] ? ' class="on"' : ''}>${esc(doc.scenarios[i].label)}</button>`).join('') + `</div>`).join('')
  const first = doc.groups[0]?.scenarios[0] ?? 0
  const body = doc.scenarios.map((s, i) => {
    const blocks = s.blocks.map((b) => (b.heading ? `<h3>${inline(b.heading)}</h3>` : '') + `<div class="tl">` +
      (() => { const steps = b.items.filter((x) => x.step); const first = steps[0]?.step, last = steps[steps.length - 1]?.step
        return b.items.map((it) => it.step
          ? stepHtml(it.step, noteKey(s.label, it.step.n), notes, [it.step === first ? 'tl-first' : '', it.step === last ? 'tl-last' : ''].filter(Boolean).join(' '))
          : `<div class="note">${inline(it.note)}</div>`).join('') })() + `</div>`).join('')
    return `<section class="sc${i === first ? ' on' : ''}" data-sc="${i}"><h2>${inline(s.title)}</h2>${blocks}</section>`
  }).join('')
  const preface = doc.preface.length ? `<div class="pre">${doc.preface.map(inline).join('<br>')}</div>` : ''
  return CSS + `<div class="demo">${staticBar}${picker}<h1>${inline(doc.title || file.replace(/\.md$/, ''))}</h1>${preface}<div class="bar">${doc.groups.length > 1 ? `<div class="mods">${mods}</div>` : ''}${tabs}</div>${body}</div>
<script>
(function(){
  var groups=${JSON.stringify(doc.groups.map((g) => g.scenarios))}
  var mods=document.querySelectorAll('.demo .mods button'),rows=document.querySelectorAll('.demo .tabs'),btns=document.querySelectorAll('.demo .tabs button'),secs=document.querySelectorAll('.demo .sc')
  var key='demo-sc:'+${JSON.stringify(file)}
  function groupOf(i){for(var g=0;g<groups.length;g++)if(groups[g].indexOf(Number(i))>=0)return g;return 0}
  function show(i){i=String(i);var g=String(groupOf(i))
    mods.forEach(function(b){b.classList.toggle('on',b.dataset.g===g)});rows.forEach(function(r){r.classList.toggle('on',r.dataset.g===g)})
    btns.forEach(function(b){b.classList.toggle('on',b.dataset.sc===i)});secs.forEach(function(s){s.classList.toggle('on',s.dataset.sc===i)})
    try{localStorage.setItem(key,i)}catch(e){}}
  // 顶部按模块切：进这个模块时回到它上次看的那个场景，没看过就第一个
  var last={}
  mods.forEach(function(b){b.addEventListener('click',function(){var g=Number(b.dataset.g);show(last[g]!=null?last[g]:groups[g][0])})})
  btns.forEach(function(b){b.addEventListener('click',function(){last[groupOf(b.dataset.sc)]=b.dataset.sc;show(b.dataset.sc)})})
  var saved=null;try{saved=localStorage.getItem(key)}catch(e){}
  if(saved!==null&&document.querySelector('.demo .sc[data-sc="'+saved+'"]')){last[groupOf(saved)]=saved;show(saved)}
  // 卡片下留一句：POST /demo/note?file=&key= 正文是那一句；删：POST /demo/note/delete?file=&key=&i=
  var file=${JSON.stringify(file)}
  function q(k){return '?file='+encodeURIComponent(file)+'&key='+encodeURIComponent(k)}
  function render(box,list){box.classList.toggle('has',list.length>0);box.querySelector('.list').innerHTML=list.map(function(n,i){return '<div class="nt"><span class="at">'+n.at+'</span><span class="tx">'+n.text.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})+'</span><button class="del" data-i="'+i+'" title="删掉这一句">×</button></div>'}).join('')}
  document.querySelectorAll('.demo .notes').forEach(function(box){
    var key=box.dataset.key,add=box.querySelector('.add')
    add.addEventListener('click',function(){
      if(box.querySelector('textarea'))return
      var ta=document.createElement('textarea');ta.placeholder='对这一步说一句，讲解下一趟照它改'
      var save=document.createElement('button');save.className='save';save.textContent='存'
      var cancel=document.createElement('button');cancel.className='cancel';cancel.textContent='算了'
      var wrap=document.createElement('div');wrap.appendChild(ta);wrap.appendChild(save);wrap.appendChild(cancel);box.insertBefore(wrap,add);ta.focus()
      cancel.onclick=function(){wrap.remove()}
      save.onclick=function(){var t=ta.value.trim();if(!t)return;save.disabled=true
        fetch('/demo/note'+q(key),{method:'POST',body:t}).then(function(r){return r.ok?r.json():r.text().then(function(m){throw new Error(m)})}).then(function(list){render(box,list);wrap.remove()}).catch(function(e){alert(e.message);save.disabled=false})}
    })
    box.addEventListener('click',function(e){var b=e.target.closest('.del');if(!b)return
      fetch('/demo/note/delete'+q(key)+'&i='+b.dataset.i,{method:'POST'}).then(function(r){return r.json()}).then(function(list){render(box,list)})})
  })
  // 左右方向键在本模块内切场景：演示时手不用离开键盘
  document.addEventListener('keydown',function(e){if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;if(e.target&&/^(TEXTAREA|INPUT)$/.test(e.target.tagName))return;var cur=[].find.call(secs,function(s){return s.classList.contains('on')});if(!cur)return
    var list=groups[groupOf(cur.dataset.sc)],at=list.indexOf(Number(cur.dataset.sc)),next=at+(e.key==='ArrowRight'?1:-1);if(next>=0&&next<list.length){last[groupOf(list[next])]=String(list[next]);show(list[next])}})
})()
</script>`
}

module.exports = { demoPage, parseDemo, parseStep, addNote, deleteNote, readNotes }
