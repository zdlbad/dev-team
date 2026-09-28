/**
 * 工作台「业务」页：业务分析写下的东西给人自己翻——business/ 下的全景与清单、导读/ 下的通读笔记、词汇表。
 * 左栏列文件和当前这一篇的目录，右边是正文；文件一变（角色正在写），页面自己刷新、停在原来的位置。
 * 每一段右边有 💬：人留言，业务分析用 tools/comments.js 作答，答复留在问题下面，人可以接着追问。
 * 每个模块另有一页「<模块>：三层」：一件事一行，从左到右是业务抽象 → 业务落地 → 应用行为，靠语句的「上一层」对齐；
 * 那一页的留言挂在一行打头的语句编号上，原文改了也跟得住。
 *
 *   const business = require('./business-page')
 *   business.page(root, doc)   → 整页 HTML（doc 是相对项目根的路径，或 'glossary'、'layers/<模块>'；不给就取第一篇）
 *   business.stamp(root)       → 所有文件最后改动的时间，页面拿它判断要不要刷新
 *   business.handle(root, req, res, url) → 留言的三个接口；认得就答、回 true
 */
const fs = require('node:fs')
const path = require('node:path')
const clock = require('./lib/time')
const { render, esc, inline } = require('./lib/markdown')
const { loadBusiness, LAYERS } = require('./lib/project')
const comments = require('./comments')

const LAYER_FILES = ['abstraction.md', 'practice.md', 'behavior.md']

const DIRS = [['business', '业务分析写的'], ['导读', '导读']]

function docs(root) {
  const groups = []
  for (const [dir, name] of DIRS) {
    let files = []
    try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md')).sort() } catch { /* 还没有这个目录 */ }
    if (files.length) groups.push({ name, items: files.map((f) => ({ key: dir + '/' + f, title: titleOf(path.join(root, dir, f)) || f })) })
    if (dir === 'business') {
      const mods = modules(root)
      if (mods.length) groups.push({ name: '按模块看三层', items: mods.map((m) => ({ key: 'layers/' + m, title: m + '：三层' })) })
    }
  }
  if (fs.existsSync(path.join(root, 'glossary.json'))) groups.push({ name: '词汇', items: [{ key: 'glossary', title: '词汇表' }] })
  return groups
}

/** business/<模块>/ 下有分层文件的模块；次序照 model/modules.json，没列在里面的按字母排在后面 */
function modules(root) {
  const dir = path.join(root, 'business')
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && LAYER_FILES.some((f) => fs.existsSync(path.join(dir, e.name, f)))).map((e) => e.name)
  } catch { /* 还没有 business/ */ }
  let order = []
  try { order = (JSON.parse(fs.readFileSync(path.join(root, 'model', 'modules.json'), 'utf8')).modules ?? []).map((m) => m.name) } catch { /* 还没有模块划分 */ }
  const at = (m) => (order.includes(m) ? order.indexOf(m) : order.length)
  return names.sort((a, b) => at(a) - at(b) || a.localeCompare(b))
}

function titleOf(p) {
  try { const m = /^#\s+(.+)$/m.exec(fs.readFileSync(p, 'utf8')); return m ? m[1].trim() : '' } catch { return '' }
}

function stamp(root) {
  let t = 0
  const see = (p) => { try { t = Math.max(t, fs.statSync(p).mtimeMs) } catch { /* 没有就算了 */ } }
  for (const [dir] of DIRS) {
    see(path.join(root, dir))
    try { for (const f of fs.readdirSync(path.join(root, dir))) see(path.join(root, dir, f)) } catch { /* 没有这个目录 */ }
  }
  for (const m of modules(root)) {
    see(path.join(root, 'business', m))
    for (const f of LAYER_FILES) see(path.join(root, 'business', m, f))
  }
  see(path.join(root, 'glossary.json'))
  see(comments.fileOf(root))
  return Math.round(t)
}

function glossary(root) {
  let terms = []
  try { terms = JSON.parse(fs.readFileSync(path.join(root, 'glossary.json'), 'utf8')).terms ?? [] } catch { /* 读不了就空着 */ }
  const rows = terms.map((t) => {
    const zh = (t.aliases ?? []).filter((a) => /[\u4e00-\u9fff]/.test(a))
    const other = (t.aliases ?? []).filter((a) => !zh.includes(a))
    const hay = [t.name, ...(t.aliases ?? []), t.definition].join(' ').toLowerCase()
    return '<tr data-s="' + esc(hay) + '"><td><b>' + esc(zh[0] ?? t.name) + '</b>' + (zh.length > 1 ? '<div class="al">' + esc(zh.slice(1).join('、')) + '</div>' : '')
      + '</td><td><code>' + esc(t.name) + '</code>' + (other.length ? '<div class="al">' + esc(other.join('、')) + '</div>' : '') + '</td><td>' + esc(t.definition ?? '') + '</td></tr>'
  }).join('')
  return {
    html: '<h1>词汇表</h1><p class="meta">' + terms.length + ' 条 · <code>glossary.json</code> · 模型和代码里用英文名，给人看的用中文名</p>'
      + '<input id="gq" placeholder="找词：中文、英文、释义里的字都行" autocomplete="off">'
      + '<div class="tw"><table class="gl"><thead><tr><th style="width:18%">中文</th><th style="width:22%">英文名</th><th>是什么</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<p id="gnone" class="meta" hidden>没有对得上的词。</p>',
    outline: [],
  }
}

// ---------- 三层表 ----------
const KIND_CLASS = { 能力: 'k-g', 事实: 'k-fact', 约束: 'k-con', 公式: 'k-for', 触发: 'k-tri', 流程: 'k-flow', 情形: 'k-case' }
const COLS = [['业务抽象', '手册怎么规定', 'a'], ['业务落地', '我们怎么做', 'p'], ['应用行为', '系统怎么表现', 'b']]
const rankOf = (l) => LAYERS.indexOf(l)
const moduleOf = (st) => st.file.split('/')[1]

/** 一条语句下面缩进的依据子项原文（出处、上一层都在里面），给页面折起来看 */
function notesOf(root, st, cache) {
  if (!cache.has(st.file)) { try { cache.set(st.file, fs.readFileSync(path.join(root, st.file), 'utf8').split('\n')) } catch { cache.set(st.file, []) } }
  const lines = cache.get(st.file)
  const ind = (l) => l.length - l.trimStart().length
  const base = ind(lines[st.line - 1] ?? '')
  const out = []
  for (let i = st.line; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() && ind(l) <= base) break
    out.push(l.slice(Math.min(base + 2, ind(l) || 0)))
  }
  while (out.length && !out.at(-1).trim()) out.pop()
  return out.join('\n')
}

/**
 * 一个模块的三层表。一行一件事：
 *   照手册来的：一条业务抽象打头，挂在它下面的业务落地各占一小行，挂在那条落地下的应用行为排在它右边；直接挂抽象的应用行为中格空着。
 *   没有上一层的业务落地、应用行为各自起一行，左边空着。
 * 挂的编号不存在、挂到同层或下层的不算数（校验会报），这条就当没挂。跨模块挂的也排进来，格子里标上模块名。
 */
function layersView(root, mod) {
  const all = loadBusiness(root).filter((st) => st.fileLayer)
  const byId = new Map(all.map((st) => [st.id, st]))
  const valid = (st) => st.parents.filter((id) => byId.has(id) && rankOf(byId.get(id).layer) < rankOf(st.layer) && id !== st.id)
  const kids = new Map()
  for (const st of all) for (const id of valid(st)) { if (!kids.has(id)) kids.set(id, []); kids.get(id).push(st) }
  const under = (id, layer) => (kids.get(id) ?? []).filter((k) => k.layer === layer)
  const cache = new Map()
  const mine = all.filter((st) => moduleOf(st) === mod)

  const cell = (st, here) => {
    if (!st) return ''
    const other = moduleOf(st) !== mod ? '<span class="mod" title="这条在别的模块">' + esc(moduleOf(st)) + '</span>' : ''
    const kind = st.ruleKind ? '<span class="k ' + (KIND_CLASS[st.ruleKind] ?? '') + '">' + esc(st.ruleKind) + '</span>' : ''
    const bad = st.parents.filter((id) => !valid(st).includes(id))
    const also = st.parents.length > 1 ? '<div class="up">挂在 ' + st.parents.map(esc).join('、') + '</div>' : ''
    const warn = bad.length || st.badParents.length ? '<div class="up bad">上一层挂不上：' + [...bad, ...st.badParents].map(esc).join('、') + '（看校验）</div>' : ''
    const n = notesOf(root, st, cache)
    const notes = n.trim() ? '<details><summary>依据</summary>' + render(n, { mark: false }).html + '</details>' : ''
    return '<div class="st' + (here ? ' here' : '') + '"><div class="hd"><span class="sid">' + esc(st.id) + '</span>' + kind + other + '</div><div class="tx">' + inline(st.text) + '</div>' + also + warn + notes + '</div>'
  }
  const hay = (sts) => sts.map((st) => st.id + ' ' + st.text).join(' ').toLowerCase()
  const clip = (t) => (t.length > 40 ? t.slice(0, 40) + '…' : t)

  function row(lead, left, subs) {
    const sts = [left, ...subs.flatMap((x) => [x.mid, ...x.right])].filter(Boolean)
    if (!sts.some((st) => moduleOf(st) === mod)) return null
    const ids = [...new Set(sts.map((st) => st.id))]
    const snip = ids.map((id) => { const st = byId.get(id); return id + ' ' + clip(st.text) }).join(' → ')
    const leftHtml = '<div class="c a' + (left ? '' : ' empty') + '" data-l="业务抽象">' + cell(left, left && moduleOf(left) === mod) + '</div>'
    const subHtml = (subs.length ? subs : [{ mid: null, right: [] }]).map((x) => '<div class="sub"><div class="c p' + (x.mid ? '' : ' empty') + '" data-l="业务落地">' + cell(x.mid, x.mid && moduleOf(x.mid) === mod)
      + '</div><div class="c b' + (x.right.length ? '' : ' empty') + '" data-l="应用行为">' + x.right.map((b) => cell(b, moduleOf(b) === mod)).join('') + '</div></div>').join('')
    return '<div class="r3" data-b="' + esc(lead.id) + '" data-ids="' + esc(ids.join(' ')) + '" data-s="' + esc(hay(sts)) + '" data-snip="' + esc(snip) + '">' + leftHtml + '<div class="subs">' + subHtml + '</div></div>'
  }

  const order = (a, b) => (moduleOf(a) === mod ? 0 : 1) - (moduleOf(b) === mod ? 0 : 1) || a.file.localeCompare(b.file) || a.line - b.line
  const abs = all.filter((st) => st.layer === '业务抽象').sort(order)
  const fromBook = abs.map((a) => {
    const subs = under(a.id, '业务落地').map((p) => ({ mid: p, right: under(p.id, '应用行为') }))
    // 同时挂了这条抽象和它下面某条落地的应用行为，已经排在那条落地右边，不再在「直接挂抽象」那一小行重出
    const direct = under(a.id, '应用行为').filter((b) => !subs.some((x) => x.right.includes(b)))
    if (direct.length) subs.push({ mid: null, right: direct })
    return row(a, a, subs)
  }).filter(Boolean)
  const loose = (layer) => all.filter((st) => st.layer === layer && !valid(st).length).sort(order)
  const ownPractice = loose('业务落地').map((p) => row(p, null, [{ mid: p, right: under(p.id, '应用行为') }])).filter(Boolean)
  const ownBehavior = loose('应用行为').map((b) => row(b, null, [{ mid: null, right: [b] }])).filter(Boolean)

  const count = (layer) => mine.filter((st) => st.layer === layer)
  const hung = (layer) => count(layer).filter((st) => valid(st).length).length
  let mt = 0
  for (const f of LAYER_FILES) { try { mt = Math.max(mt, fs.statSync(path.join(root, 'business', mod, f)).mtimeMs) } catch { /* 这一层还没写 */ } }
  const outline = []
  const section = (title, hint, rows) => {
    if (!rows.length) return ''
    const id = 'h-' + outline.length
    outline.push({ level: 2, id, text: title })
    return '<h2 id="' + id + '">' + esc(title) + ' <small>' + rows.length + ' 行</small></h2><p class="meta">' + esc(hint) + '</p>' + rows.join('\n')
  }
  const files = LAYER_FILES.filter((f) => fs.existsSync(path.join(root, 'business', mod, f)))
  const html = '<h1>' + esc(mod) + '：三层</h1>'
    + '<p class="meta">业务抽象 ' + count('业务抽象').length + ' 条 · 业务落地 ' + count('业务落地').length + ' 条（挂了上一层的 ' + hung('业务落地') + ' 条）· 应用行为 ' + count('应用行为').length + ' 条（挂了上一层的 ' + hung('应用行为') + ' 条）'
    + ' · <code>business/' + esc(mod) + '/</code> ' + files.map((f) => '<code>' + f + '</code>').join(' ')
    + (mt ? ' · 最后改动 ' + esc(clock.date(new Date(mt)) + ' ' + clock.hm(new Date(mt))) : '') + '</p>'
    + '<div class="lg">种类：' + Object.keys(KIND_CLASS).map((k) => '<span class="k ' + KIND_CLASS[k] + '">' + k + '</span>').join('') + ' · 灰底模块名是挂在别的模块的那一条 · 点「依据」看出处</div>'
    + '<input id="lq" placeholder="找：编号或正文里的字" autocomplete="off"> <span id="lqn" class="meta"></span>'
    + '<div class="l3h">' + COLS.map(([l, h, c]) => '<div class="' + c + '">' + l + '<small>' + h + '</small></div>').join('') + '</div>'
    + section('照手册来的', '左边一条业务抽象；中间是我们照它怎么做；右边是系统在那件事上怎么表现。', fromBook)
    + section('我们自己的做法', '这几条业务落地没有挂手册上的哪一条：这家公司自己才有的做法，或者还没挂上。', ownPractice)
    + section('没挂上一层的系统行为', '这几条应用行为没挂在哪条业务落地或业务抽象下。', ownBehavior)
    + (fromBook.length + ownPractice.length + ownBehavior.length ? '' : '<p class="meta">这个模块还没有语句。</p>')
  return { html, outline, wide: true }
}

function page(root, doc) {
  const groups = docs(root)
  const all = groups.flatMap((g) => g.items)
  const cur = all.find((d) => d.key === doc) ?? all[0]
  if (!cur) return shell('', '<p class="meta">业务分析还没写东西。它读完原料会在 <code>business/</code> 下写全景，这一页就有了。</p>', [], 0)
  let body
  if (cur.key === 'glossary') body = glossary(root)
  else if (cur.key.startsWith('layers/')) body = layersView(root, cur.key.slice('layers/'.length))
  else {
    const p = path.join(root, cur.key)
    const r = render(fs.readFileSync(p, 'utf8'))
    const mt = fs.statSync(p).mtime
    body = { html: '<p class="meta"><code>' + esc(cur.key) + '</code> · 最后改动 ' + esc(clock.date(mt) + ' ' + clock.hm(mt)) + '</p>' + r.html, outline: r.outline }
  }
  const nav = groups.map((g) => '<div class="gn">' + esc(g.name) + '</div>' + g.items.map((d) => {
    const on = d.key === cur.key
    const toc = on ? body.outline.filter((o) => o.level === 2 || o.level === 3)
      .map((o) => '<a class="toc l' + o.level + '" href="#' + o.id + '">' + esc(o.text) + '</a>').join('') : ''
    return '<a class="doc' + (on ? ' on' : '') + '" href="?doc=' + encodeURIComponent(d.key) + '">' + esc(d.title) + '</a>' + toc
  }).join('')).join('')
  return shell(nav, body.html, cur.key, stamp(root), body.wide)
}

// 留言的页面脚本单放一个文件，浏览器里跑
const COMMENTS_JS = fs.readFileSync(path.join(__dirname, 'business-page.client.js'), 'utf8')

// 流程图用 mermaid 画；取不到脚本（没网）就照原文显示，不影响别的
const MERMAID = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>'
  + '<script>if (window.mermaid) { mermaid.initialize({ startOnLoad: false, theme: "neutral", flowchart: { htmlLabels: true } }); mermaid.run({ querySelector: "pre.mermaid" }) }</script>'

const shell = (nav, main, key, t, wide) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>业务</title><style>
:root{--line:#e6e8eb;--dim:#57606a;--faint:#8c959f;--blue:#0969da}
html,body{margin:0;height:100%;background:#fff;color:#1f2328;font:14px/1.7 system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{display:flex;height:100%}
nav{width:280px;flex:none;overflow:auto;border-right:1px solid var(--line);background:#f6f8fa;padding:12px 0 24px}
nav .gn{font-size:12px;color:var(--faint);padding:10px 16px 4px}
nav a{display:block;text-decoration:none;color:#1f2328;padding:4px 16px;line-height:1.45}
nav a.doc{font-weight:600;font-size:13.5px}nav a.doc:hover{background:#eaeef2}nav a.doc.on{background:#fff;border-left:3px solid #1f6feb;padding-left:13px}
nav a.toc{font-size:12.5px;color:var(--dim);padding:2px 16px 2px 28px}nav a.toc.l3{padding-left:42px;color:var(--faint)}nav a.toc:hover{color:var(--blue)}
main{flex:1;min-width:0;overflow:auto;padding:18px 36px 80px}
.md{max-width:1100px}
.md h1{font-size:22px;margin:4px 0 6px}.md h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}.md h3{font-size:15px;margin:20px 0 6px}.md h4{font-size:14px;color:var(--dim)}
.md h1,.md h2,.md h3,.md h4{scroll-margin-top:12px}
.md p{margin:8px 0}.md ul,.md ol{padding-left:24px;margin:6px 0}.md li{margin:3px 0}
.md hr{border:0;border-top:1px solid var(--line);margin:18px 0}
.md .tw{overflow-x:auto;margin:10px 0}
.md table{border-collapse:collapse;font-size:13px;line-height:1.55;min-width:60%}.md th,.md td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}.md th{background:#f6f8fa;position:sticky;top:0}
.md tbody tr:hover td{background:#fbfcfd}.md td.nw{white-space:nowrap}
.md code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.md pre{background:#f6f8fa;border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5}.md pre code{background:none;padding:0}
.md blockquote{margin:10px 0;padding:4px 14px;border-left:3px solid #d0d7de;color:var(--dim)}
.md a{color:var(--blue)}
.md pre.mermaid{background:#fff;border:1px solid var(--line);text-align:center;overflow:auto}
.meta{color:var(--faint);font-size:12.5px}
.tag{display:inline-block;font-size:11px;line-height:1.5;padding:0 6px;border-radius:4px;margin:0 2px;vertical-align:1px;white-space:nowrap}
.tag.l-abs{background:#ddf4ff;color:#0550ae}.tag.l-land{background:#fbefff;color:#6639ba}.tag.l-app{background:#dafbe1;color:#116329}
#gq{width:min(420px,100%);font:inherit;padding:6px 10px;border:1px solid #d0d7de;border-radius:6px;margin:6px 0 4px}
.gl .al{font-size:12px;color:var(--faint);font-weight:400}
.md{position:relative}
#cbtn{position:absolute;right:-34px;width:26px;height:26px;border-radius:50%;border:1px solid #d0d7de;background:#fff;cursor:pointer;font-size:13px;line-height:24px;text-align:center;padding:0;display:none;box-shadow:0 1px 3px rgba(0,0,0,.08)}
#cbtn:hover{border-color:#bf8700;background:#fff8e1}
.md .has-c{box-shadow:-10px 0 0 -7px #e3b341}
.thread{margin:2px 0 14px;padding:8px 12px;border-left:3px solid #e3b341;background:#fffdf5;border-radius:0 6px 6px 0;font-size:13px;line-height:1.6}
.thread .cm+.cm{border-top:1px dashed #eadfb8;margin-top:8px;padding-top:8px}
.thread .moved{font-size:12px;color:var(--faint);margin-bottom:4px}
.thread .msg{margin:2px 0}.thread .msg.r{margin-left:18px;padding-left:10px;border-left:2px solid #a7d9b3}
.thread .who{font-weight:600;margin-right:6px}.thread time{font-size:11.5px;color:var(--faint)}
.thread .tx{white-space:pre-wrap}
.thread .ft{margin-top:4px;font-size:12px;display:flex;gap:12px;align-items:center}
.thread .ft a{color:var(--blue);cursor:pointer}.thread .wait{color:#b45309}.thread .done{color:#1a7f37}
.thread textarea{width:100%;box-sizing:border-box;min-height:58px;font:inherit;font-size:13px;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;margin-top:6px}
.thread .bt{margin-top:4px;display:flex;gap:8px;align-items:center}
.thread button{font:inherit;font-size:12.5px;padding:3px 12px;border-radius:6px;border:1px solid #bf8700;background:#ffd76a;cursor:pointer}.thread button.x{background:#fff;border-color:#d0d7de}
.csum{font-size:12.5px;color:var(--dim);background:#fff8e1;border:1px solid #f3d27a;border-radius:6px;padding:4px 10px;display:inline-block;margin:0 0 6px}.csum a{color:var(--blue);cursor:pointer}
nav .nb{display:inline-block;min-width:16px;padding:0 5px;margin-left:6px;border-radius:999px;background:#bf8700;color:#fff;font-size:11px;font-weight:600;text-align:center;line-height:16px}
.flash{position:fixed;right:16px;bottom:14px;background:#1f2328;color:#fff;font-size:12.5px;padding:5px 12px;border-radius:6px;opacity:0;transition:opacity .3s}.flash.on{opacity:.85}
.md.wide{max-width:none}
.md h2 small{font-size:12px;color:var(--faint);font-weight:400;margin-left:6px}
.lg{font-size:12.5px;color:var(--dim);margin:4px 0 8px}
#lq{width:min(360px,100%);font:inherit;padding:5px 10px;border:1px solid #d0d7de;border-radius:6px;margin:2px 0 10px}
.k{display:inline-block;font-size:11px;line-height:1.5;padding:0 6px;border-radius:4px;margin:0 3px;white-space:nowrap}
.k-g{background:#fff1e5;color:#953800}.k-fact{background:#eaeef2;color:#424a53}.k-con{background:#ffebe9;color:#a40e26}.k-for{background:#ddf4ff;color:#0550ae}
.k-tri{background:#fbefff;color:#8250df}.k-flow{background:#dafbe1;color:#116329}.k-case{background:#fff8c5;color:#7d4e00}
.l3h,.r3{display:grid;grid-template-columns:1fr 2fr}
.l3h{position:sticky;top:0;z-index:2;grid-template-columns:1fr 1fr 1fr;font-weight:600;font-size:13px;border:1px solid var(--line);border-radius:6px 6px 0 0;overflow:hidden;margin-top:6px}
.l3h>div{padding:6px 10px}.l3h small{font-weight:400;color:var(--dim);margin-left:6px}
.l3h .a{background:#ddf4ff;color:#0550ae}.l3h .p{background:#fbefff;color:#6639ba}.l3h .b{background:#dafbe1;color:#116329}
.r3{border:1px solid var(--line);border-top:0}
.md h2+p.meta+.r3{border-top:1px solid var(--line)}
.r3 .subs{display:flex;flex-direction:column}
.r3 .sub{display:grid;grid-template-columns:1fr 1fr;flex:1}.r3 .sub+.sub{border-top:1px dashed var(--line)}
.r3 .c{padding:6px 10px;min-width:0;font-size:13px;line-height:1.6}
.r3 .c.a{background:#fbfdff}.r3 .c.p{border-left:1px solid var(--line)}.r3 .c.b{border-left:1px solid var(--line);background:#f6fcf7}
.r3 .st+.st{border-top:1px dotted #d0d7de;margin-top:6px;padding-top:6px}
.r3 .hd{margin-bottom:1px}.r3 .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:600;color:#1f2328}
.r3 .st:not(.here) .tx{color:var(--dim)}
.r3 .mod{display:inline-block;font-size:11px;line-height:1.5;padding:0 6px;border-radius:4px;background:#eaeef2;color:#57606a;border:1px solid #d0d7de}
.r3 .up{font-size:11.5px;color:var(--faint)}.r3 .up.bad{color:#cf222e}
.r3 details{font-size:12px;color:var(--dim);margin-top:2px}.r3 summary{cursor:pointer;color:var(--blue);width:max-content}
.r3 details ul{padding-left:18px;margin:2px 0}.r3 details p{margin:2px 0}
.r3:hover .c{background-image:linear-gradient(rgba(9,105,218,.03),rgba(9,105,218,.03))}
.md .r3.has-c{box-shadow:-10px 0 0 -7px #e3b341}
@media (max-width:760px){.wrap{display:block}nav{width:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:14px 16px 60px}
.l3h{display:none}.r3,.r3 .sub{display:block}.r3{border-top:1px solid var(--line);margin-bottom:10px;border-radius:6px}.r3 .c.empty{display:none}
.r3 .c.p,.r3 .c.b{border-left:0;border-top:1px solid var(--line)}.r3 .c::before{content:attr(data-l);display:block;font-size:11px;font-weight:600;color:var(--faint)}
#cbtn{right:-12px}}
</style></head><body><div class="wrap"><nav>${nav}</nav><main><div class="md${wide ? ' wide' : ''}">${main}</div></main></div><div class="flash" id="flash">有改动，已刷新</div>
${main.includes('class="mermaid"') ? MERMAID : ''}
<script>
(function () {
  var KEY = ${JSON.stringify(key)}
  window.T = ${JSON.stringify(t)}
  var main = document.querySelector('main')
  // 刷新后回到原来读到的地方
  try {
    var s = JSON.parse(sessionStorage.getItem('biz-pos') || 'null')
    if (s && s.key === KEY) { main.scrollTop = s.top; if (s.fresh) { var f = document.getElementById('flash'); f.classList.add('on'); setTimeout(function () { f.classList.remove('on') }, 1800) } }
  } catch (e) {}
  function keep(fresh) { try { sessionStorage.setItem('biz-pos', JSON.stringify({ key: KEY, top: main.scrollTop, fresh: !!fresh })) } catch (e) {} }
  main.addEventListener('scroll', function () { keep(false) })
  document.querySelectorAll('nav a.toc').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); var el = document.getElementById(a.getAttribute('href').slice(1)); if (el) main.scrollTop = el.offsetTop - 8 })
  })
  setInterval(function () {
    if (window.Comments && Comments.busy()) return
    fetch('business/stamp').then(function (r) { return r.json() }).then(function (d) { if (d.t !== window.T) { keep(true); location.reload() } }).catch(function () {})
  }, 4000)
  var q = document.getElementById('gq')
  if (q) q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase(), n = 0
    document.querySelectorAll('.gl tbody tr').forEach(function (tr) { var hit = !v || tr.dataset.s.indexOf(v) >= 0; tr.hidden = !hit; if (hit) n++ })
    document.getElementById('gnone').hidden = n > 0
  })
  var lq = document.getElementById('lq')
  if (lq) lq.addEventListener('input', function () {
    var v = lq.value.trim().toLowerCase(), n = 0, rows = document.querySelectorAll('.md > .r3')
    rows.forEach(function (r) {
      var hit = !v || r.dataset.s.indexOf(v) >= 0; r.hidden = !hit; if (hit) n++
      var t = r.nextElementSibling; if (t && t.classList.contains('thread')) t.hidden = !hit
    })
    document.getElementById('lqn').textContent = v ? n + ' / ' + rows.length + ' 行' : ''
  })
})()
</script>
<script>${COMMENTS_JS.replace('__KEY__', JSON.stringify(key))}</script></body></html>`

function handle(root, req, res, url) {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const all = () => ({ comments: comments.load(root).comments, t: stamp(root) })
  if (req.method === 'GET' && url === '/business/comments') { json(200, all()); return true }
  if (req.method !== 'POST' || !['/business/comments', '/business/comments/reply'].includes(url)) return false
  let body = ''
  req.on('data', (c) => (body += c)).on('end', () => {
    try {
      const b = JSON.parse(body || '{}')
      if (url === '/business/comments') comments.add(root, b)
      else comments.reply(root, b.id, b.text, '人')
      json(200, all())
    } catch (e) { json(400, { error: e.message }) }
  })
  return true
}

module.exports = { page, stamp, handle }
