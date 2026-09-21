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
 *   ### 一、开资金账户              ← 阶段标题（### 或 ####，或整行加粗）
 *   第 1 步 · 2026-03-03 · 案例经理 · 做了什么 → 账上发生了什么（金额）· R-101、R-102
 *   ...
 * 对不上「第 n 步」格式的行，原样当成说明摆在那个位置，不丢。
 */
const fs = require('node:fs')
const path = require('node:path')

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
/** 行内的 `代码`、**加粗** 两种最常见的标记转成 HTML，其余原样 */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

/** 一行「第 n 步 · 日期 · 谁 · 做了什么 → 结果 · 依据」拆成几栏；拆不出来返回 null */
function parseStep(line) {
  const m = /^(?:[-*]\s*)?第\s*(\d+)\s*步\s*[·・|]\s*(.*)$/.exec(line.trim())
  if (!m) return null
  const parts = m[2].split(/\s*[·・|]\s*/)
  if (parts.length < 3) return null
  const [date, who, ...rest] = parts
  // 「做了什么 → 结果」可能自己带着分隔符（金额里的顿号不算），所以从后往前认依据：形如 R-xxx、第几批、G-xxx 的那一段
  let basis = ''
  // 讲解写的是「· 依据 R-012、R-028」，带着「依据」两个字；只认编号开头会把整段依据落进结果那一栏（2026-09-21 第一份就这样）
  const last = rest.length > 1 ? rest[rest.length - 1].replace(/^依据[：:]?\s*/, '') : ''
  if (last && /^(?:[RGU]-\d+|第[一二三四五六七八九十百零〇\d]+批|走查)/.test(last)) { rest.pop(); basis = last }
  const body = rest.join(' · ')
  const arrow = body.split(/\s*(?:→|->|=>)\s*/)
  return { n: Number(m[1]), date, who, action: arrow[0] ?? '', result: arrow.slice(1).join(' → '), basis }
}

/** 一份演示文档 → { title, scenarios: [{ title, label, blocks: [{ heading, items: [{ step } | { note }] }] }] } */
function parseDemo(text) {
  const lines = text.split('\n')
  const doc = { title: '', preface: [], scenarios: [] }
  let sc = null, block = null
  const ensureBlock = () => { if (!sc) return null; if (!block) { block = { heading: null, items: [] }; sc.blocks.push(block) } return block }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    let m
    if ((m = /^#\s+(.*)$/.exec(line))) { doc.title = m[1].trim(); continue }
    if ((m = /^##\s+(.*)$/.exec(line))) { sc = { title: m[1].trim(), label: null, blocks: [] }; block = null; doc.scenarios.push(sc); continue }
    if ((m = /^>\s*切换名[：:]\s*(.*)$/.exec(line)) && sc) { sc.label = m[1].trim(); continue }
    if ((m = /^#{3,4}\s+(.*)$/.exec(line)) || (m = /^\*\*([^*]+)\*\*\s*$/.exec(line))) {
      if (!sc) { doc.preface.push(line); continue }
      block = { heading: m[1].trim(), items: [] }; sc.blocks.push(block); continue
    }
    const step = parseStep(line)
    if (!sc) { doc.preface.push(line); continue }
    const b = ensureBlock()
    if (step) b.items.push({ step })
    else b.items.push({ note: line.replace(/^[-*>]\s*/, '') })
  }
  // 没写切换名的：场景标题去掉「场景 n：」当按钮名；不是场景的节（开场、编号怎么查）用整个标题
  for (const s of doc.scenarios) if (!s.label) s.label = /^场景\s*\d+/.test(s.title) ? s.title.replace(/^场景\s*\d+\s*[：:]\s*/, '').slice(0, 10) : s.title.slice(0, 14)
  return doc
}

const CSS = `<style>
.demo h1{font-size:20px;margin:0 0 6px}.demo .pre{color:#57606a;font-size:13px;margin:0 0 14px}
.demo .tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;position:sticky;top:0;background:#fff;padding:6px 0;z-index:2}
.demo .tabs button{font:inherit;padding:6px 14px;border-radius:999px;border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;cursor:pointer}
.demo .tabs button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
.demo .sc{display:none}.demo .sc.on{display:block}
.demo .sc>h2{font-size:17px;margin:0 0 14px}
.demo h3{font-size:14px;color:#57606a;margin:22px 0 8px;letter-spacing:.02em}
.demo .tl{position:relative;margin:0 0 6px 0;padding-left:0}
.demo .tl::before{content:"";position:absolute;left:150px;top:6px;bottom:6px;border-left:2px solid #e6e8eb}
.demo .st{display:grid;grid-template-columns:136px 28px 1fr;gap:0 10px;margin:0 0 14px;align-items:start}
.demo .st .when{text-align:right;color:#57606a;font-size:12.5px;line-height:1.35;padding-top:3px}.demo .st .when b{display:block;color:#1f2328;font-size:13px}
.demo .st .dot{width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #1f6feb;margin:5px 0 0 1px;position:relative;z-index:1}
.demo .st .what{padding:6px 12px 8px;border:1px solid #e6e8eb;border-radius:8px;background:#fff}
.demo .st .n{font-size:11.5px;color:#8c959f;margin-right:6px}
.demo .st .act{font-weight:600}
.demo .st .res{margin-top:4px;color:#1f2328}.demo .st .res::before{content:"→ ";color:#1f6feb;font-weight:700}
.demo .st .basis{margin-top:6px;font-size:12px;color:#57606a}.demo .st .basis code{background:#f6f8fa;padding:1px 6px;border-radius:4px}
.demo .note{margin:0 0 12px 174px;padding:8px 12px;color:#57606a;font-size:13px;background:#f6f8fa;border-radius:6px;border:1px dashed #d0d7de}
.demo .empty{padding:24px;color:#57606a;background:#f6f8fa;border-radius:8px}
.demo .files{margin:0 0 12px;font-size:13px;color:#57606a}.demo .files a{color:#1f6feb;margin-right:12px}
@media (max-width:720px){.demo .st{grid-template-columns:1fr}.demo .tl::before{display:none}.demo .st .dot{display:none}.demo .st .when{text-align:left}.demo .note{margin-left:0}}
</style>`

function stepHtml(s) {
  return `<div class="st"><div class="when"><b>${esc(s.date)}</b>${esc(s.who)}</div><div class="dot"></div><div class="what">` +
    `<div><span class="n">第 ${s.n} 步</span><span class="act">${inline(s.action)}</span></div>` +
    (s.result ? `<div class="res">${inline(s.result)}</div>` : '') +
    (s.basis ? `<div class="basis">依据 <code>${esc(s.basis)}</code></div>` : '') + `</div></div>`
}

/** 整页的 HTML 正文（不含 <html> 外壳，工作台用 wrap 包） */
function demoPage(root, which = null) {
  const dir = path.join(root, '导读')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^演示.*\.md$/.test(f)).sort() : []
  if (!files.length) {
    return CSS + `<div class="demo"><h1>演示</h1><div class="empty">还没有演示文档。讲解写到 <code>导读/演示-&lt;题&gt;.md</code>：一个 <code>## 场景</code> 一条时间轴，每步一行「第 n 步 · 日期 · 谁 · 做了什么 → 账上发生了什么 · 依据编号」，这一页就把它摆成可切换的视图。</div></div>`
  }
  const file = which && files.includes(which) ? which : files[0]
  const doc = parseDemo(fs.readFileSync(path.join(dir, file), 'utf8'))
  const picker = files.length > 1 ? `<div class="files">几份演示文档：${files.map((f) => f === file ? `<b>${esc(f)}</b>　` : `<a href="/demo?file=${encodeURIComponent(f)}">${esc(f)}</a>`).join('')}</div>` : ''
  const tabs = doc.scenarios.map((s, i) => `<button data-sc="${i}"${i === 0 ? ' class="on"' : ''}>${esc(s.label)}</button>`).join('')
  const body = doc.scenarios.map((s, i) => {
    const blocks = s.blocks.map((b) => (b.heading ? `<h3>${inline(b.heading)}</h3>` : '') + `<div class="tl">` +
      b.items.map((it) => it.step ? stepHtml(it.step) : `<div class="note">${inline(it.note)}</div>`).join('') + `</div>`).join('')
    return `<section class="sc${i === 0 ? ' on' : ''}" data-sc="${i}"><h2>${inline(s.title)}</h2>${blocks}</section>`
  }).join('')
  const preface = doc.preface.length ? `<div class="pre">${doc.preface.map(inline).join('<br>')}</div>` : ''
  return CSS + `<div class="demo">${picker}<h1>${inline(doc.title || file.replace(/\.md$/, ''))}</h1>${preface}<div class="tabs">${tabs}</div>${body}</div>
<script>
(function(){
  var btns=document.querySelectorAll('.demo .tabs button'),secs=document.querySelectorAll('.demo .sc')
  var key='demo-sc:'+${JSON.stringify(file)}
  function show(i){btns.forEach(function(b){b.classList.toggle('on',b.dataset.sc===String(i))});secs.forEach(function(s){s.classList.toggle('on',s.dataset.sc===String(i))});try{localStorage.setItem(key,String(i))}catch(e){}}
  btns.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.sc)})})
  var saved=null;try{saved=localStorage.getItem(key)}catch(e){}
  if(saved!==null&&document.querySelector('.demo .sc[data-sc="'+saved+'"]'))show(saved)
  // 左右方向键切场景：演示时手不用离开键盘
  document.addEventListener('keydown',function(e){if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;var cur=[].findIndex.call(secs,function(s){return s.classList.contains('on')});var next=cur+(e.key==='ArrowRight'?1:-1);if(next>=0&&next<secs.length)show(next)})
})()
</script>`
}

module.exports = { demoPage, parseDemo, parseStep }
