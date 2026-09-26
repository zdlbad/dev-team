/**
 * 工作台「业务」页：业务分析写下的东西给人自己翻——business/ 下的全景与清单、导读/ 下的通读笔记、词汇表。
 * 左栏列文件和当前这一篇的目录，右边是正文；文件一变（角色正在写），页面自己刷新、停在原来的位置。
 * 每一段右边有 💬：人留言，业务分析用 tools/comments.js 作答，答复留在问题下面，人可以接着追问。
 *
 *   const business = require('./business-page')
 *   business.page(root, doc)   → 整页 HTML（doc 是相对项目根的路径，或 'glossary'；不给就取第一篇）
 *   business.stamp(root)       → 所有文件最后改动的时间，页面拿它判断要不要刷新
 *   business.handle(root, req, res, url) → 留言的三个接口；认得就答、回 true
 */
const fs = require('node:fs')
const path = require('node:path')
const clock = require('./lib/time')
const { render, esc } = require('./lib/markdown')
const comments = require('./comments')

const DIRS = [['business', '业务分析写的'], ['导读', '导读']]

function docs(root) {
  const groups = []
  for (const [dir, name] of DIRS) {
    let files = []
    try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md')).sort() } catch { /* 还没有这个目录 */ }
    if (files.length) groups.push({ name, items: files.map((f) => ({ key: dir + '/' + f, title: titleOf(path.join(root, dir, f)) || f })) })
  }
  if (fs.existsSync(path.join(root, 'glossary.json'))) groups.push({ name: '词汇', items: [{ key: 'glossary', title: '词汇表' }] })
  return groups
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

function page(root, doc) {
  const groups = docs(root)
  const all = groups.flatMap((g) => g.items)
  const cur = all.find((d) => d.key === doc) ?? all[0]
  if (!cur) return shell('', '<p class="meta">业务分析还没写东西。它读完原料会在 <code>business/</code> 下写全景，这一页就有了。</p>', [], 0)
  let body
  if (cur.key === 'glossary') body = glossary(root)
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
  return shell(nav, body.html, cur.key, stamp(root))
}

// 留言的页面脚本单放一个文件，浏览器里跑
const COMMENTS_JS = fs.readFileSync(path.join(__dirname, 'business-page.client.js'), 'utf8')

// 流程图用 mermaid 画；取不到脚本（没网）就照原文显示，不影响别的
const MERMAID = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>'
  + '<script>if (window.mermaid) { mermaid.initialize({ startOnLoad: false, theme: "neutral", flowchart: { htmlLabels: true } }); mermaid.run({ querySelector: "pre.mermaid" }) }</script>'

const shell = (nav, main, key, t) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>业务</title><style>
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
@media (max-width:760px){.wrap{display:block}nav{width:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:14px 16px 60px}}
</style></head><body><div class="wrap"><nav>${nav}</nav><main><div class="md">${main}</div></main></div><div class="flash" id="flash">有改动，已刷新</div>
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
