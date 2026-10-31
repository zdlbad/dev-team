/**
 * 工作台「业务」页签：四个子页——全局图、主线故事、概念、词汇（项目所有者 2026-10-31 定的：
 * 业务分析原来写给人读的框架、聚焦、全景、答问、导读都不要了，留言也随它们去了；故事、概念不再是独立页签，并到这里）。
 * 这一页只是一层子页签条加一个内框：全局图、故事、概念是 ui/ 的页（/map、/stories、/concepts），词汇在这里画。
 *
 *   const business = require('./business-page')
 *   business.page(sub)         → 业务页签的壳（子页签条 + 内框），sub 是一开始开哪个子页
 *   business.glossary(root)    → 词汇表那一页
 *   business.stamp(root)       → 词汇表最后改动的时间，页面拿它判断要不要刷新
 */
const fs = require('node:fs')
const path = require('node:path')

const SUBS = [['map', '全局图', '/map'], ['stories', '主线故事', '/stories'], ['concepts', '概念', '/concepts'], ['glossary', '词汇', '/business/glossary']]

function stamp(root) {
  try { return Math.round(fs.statSync(path.join(root, 'glossary.json')).mtimeMs) } catch { return 0 }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const HEAD = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>业务</title><style>
:root{--line:#e6e8eb;--dim:#57606a;--faint:#8c959f;--blue:#0969da}
html,body{margin:0;height:100%;background:#fff;color:#1f2328;font:14px/1.7 system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
</style>`

/** 壳：顶上一条子页签，底下一个内框装子页 */
function page(sub) {
  const first = SUBS.some(([k]) => k === sub) ? sub : 'map'
  return `${HEAD}<style>
.subs{display:flex;gap:4px;padding:6px 14px;border-bottom:1px solid var(--line);background:#f6f8fa}
.subs button{background:none;border:1px solid transparent;color:var(--dim);padding:3px 12px;border-radius:6px;cursor:pointer;font:inherit}
.subs button.on{background:#fff;color:#1f2328;border-color:var(--line);font-weight:600}
iframe{border:0;width:100%;height:calc(100% - 42px);display:block}
</style></head><body><div class="subs">${SUBS.map(([k, n]) => `<button data-s="${k}">${n}</button>`).join('')}</div><iframe id="f"></iframe><script>
const S = ${JSON.stringify(Object.fromEntries(SUBS.map(([k, , u]) => [k, u])))}
const f = document.getElementById('f')
function show(s) { for (const b of document.querySelectorAll('.subs button')) b.classList.toggle('on', b.dataset.s === s); f.src = S[s]; try { localStorage.setItem('biz-sub', s) } catch (e) {} }
document.querySelectorAll('.subs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.s)))
// 子页自己跳到别的子页（全局图上点一样数据去概念页）时告诉这里一声，只换高亮不重载
window.addEventListener('message', (e) => { if (e.data && S[e.data.sub]) for (const b of document.querySelectorAll('.subs button')) b.classList.toggle('on', b.dataset.s === e.data.sub) })
let first = ${JSON.stringify(first)}; if (!${JSON.stringify(sub ? true : false)}) { try { first = localStorage.getItem('biz-sub') || first } catch (e) {} }
show(first)
</script></body></html>`
}

/** 词汇表 */
function glossary(root) {
  let terms = []
  try { terms = JSON.parse(fs.readFileSync(path.join(root, 'glossary.json'), 'utf8')).terms ?? [] } catch { /* 读不了就空着 */ }
  const rows = terms.map((t) => {
    const zh = (t.aliases ?? []).filter((a) => /[一-鿿]/.test(a))
    const other = (t.aliases ?? []).filter((a) => !zh.includes(a))
    const hay = [t.name, ...(t.aliases ?? []), t.definition].join(' ').toLowerCase()
    return '<tr data-s="' + esc(hay) + '"><td><b>' + esc(zh[0] ?? t.name) + '</b>' + (zh.length > 1 ? '<div class="al">' + esc(zh.slice(1).join('、')) + '</div>' : '')
      + '</td><td><code>' + esc(t.name) + '</code>' + (other.length ? '<div class="al">' + esc(other.join('、')) + '</div>' : '') + '</td><td>' + esc(t.definition ?? '') + '</td></tr>'
  }).join('')
  return `${HEAD}<style>
main{padding:18px 36px 80px;max-width:1100px}
h1{font-size:22px;margin:4px 0 6px}.meta{color:var(--faint);font-size:12.5px}
code{background:#f3f4f6;padding:0 4px;border-radius:3px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#gq{width:min(420px,100%);font:inherit;padding:6px 10px;border:1px solid #d0d7de;border-radius:6px;margin:6px 0 4px}
.tw{overflow-x:auto;margin:10px 0}
table{border-collapse:collapse;font-size:13px;line-height:1.55;min-width:60%}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:#f6f8fa;position:sticky;top:0}
tbody tr:hover td{background:#fbfcfd}.al{font-size:12px;color:var(--faint);font-weight:400}
</style></head><body><main><h1>词汇表</h1><p class="meta">${terms.length} 条 · <code>glossary.json</code> · 模型和代码里用英文名，给人看的用中文名</p>
<input id="gq" placeholder="找词：中文、英文、释义里的字都行" autocomplete="off">
<div class="tw"><table><thead><tr><th style="width:18%">中文</th><th style="width:22%">英文名</th><th>是什么</th></tr></thead><tbody>${rows}</tbody></table></div>
<p id="gnone" class="meta" hidden>没有对得上的词。</p></main>
<script>
(function () {
  window.T = ${JSON.stringify(stamp(root))}
  var q = document.getElementById('gq')
  q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase(), n = 0
    document.querySelectorAll('tbody tr').forEach(function (tr) { var hit = !v || tr.dataset.s.indexOf(v) >= 0; tr.hidden = !hit; if (hit) n++ })
    document.getElementById('gnone').hidden = n > 0
  })
  // 业务分析登了新词条，开着的页面自己跟上
  setInterval(function () { fetch('/business/stamp').then(function (r) { return r.json() }).then(function (d) { if (d.t !== window.T) location.reload() }).catch(function () {}) }, 4000)
})()
</script></body></html>`
}

module.exports = { page, glossary, stamp, SUBS }
