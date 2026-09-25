#!/usr/bin/env node
/**
 * 模型图：每次打开都用 render.js 重画，每个模型元素底下能留意见。
 *
 *   node tools/model-page.js <项目> [--port 4871]
 *
 * 意见存在 reports/_model-notes.json，按模型文件路径分组：{ "<文件>": [{ text, at, handled }] }。
 * 模型师处理完一条把 handled 置真；slice next 数的是 handled 为假的那几条，还有就派模型师去处理。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
if (!root || !fs.existsSync(path.join(root, 'project.json'))) {
  console.error('用法：node tools/model-page.js <项目> [--port 4871]')
  process.exit(2)
}
const pi = args.indexOf('--port')
const port = Number(pi > 0 ? args[pi + 1] : 4871)
const notesP = path.join(root, 'reports', '_model-notes.json')
const readNotes = () => (fs.existsSync(notesP) ? JSON.parse(fs.readFileSync(notesP, 'utf8')) : {})

const MODEL_INJECT = "\n<style>\n  .mnote { margin-top:8px; border-top:1px dashed #d0d7de; padding-top:6px; font-size:12px; }\n  .mnote textarea { width:100%; min-height:38px; box-sizing:border-box; font:inherit; font-size:12px; border:1px solid #d0d7de; border-radius:6px; padding:4px 6px; }\n  .mnote .row { display:flex; gap:6px; align-items:center; margin-top:4px; }\n  .mnote button { font-size:12px; padding:3px 10px; border:1px solid #1f6feb; background:#1f6feb; color:#fff; border-radius:6px; cursor:pointer; }\n  .mnote .old { background:#fff7e6; border:1px solid #f2c57c; border-radius:6px; padding:4px 8px; margin:3px 0; }\n  .mnote .old.done { background:#f3f4f6; border-color:#d0d7de; color:#6b7280; }\n  .mnote .old small { color:#6b7280; margin-left:6px; }\n  .mnote-top { position:fixed; right:16px; top:52px; z-index:9; }\n  .mnote-top button.dd { font-size:12px; padding:4px 10px; border:1px solid #d0d7de; background:#fff; border-radius:6px; cursor:pointer; }\n  .mnote-top .menu { display:none; position:absolute; right:0; top:30px; width:360px; max-height:60vh; overflow:auto; background:#fff; border:1px solid #d0d7de; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,.1); padding:6px; }\n  .mnote-top.open .menu { display:block; }\n  .mnote-top .menu a { display:block; padding:5px 6px; border-bottom:1px solid #f0f0f0; color:#111; text-decoration:none; font-size:12px; }\n  .mnote-top .menu a b { color:#1f6feb; }\n  .mnote-top .menu a.done { color:#9ca3af; }\n</style>\n<div class=\"mnote-top\" id=\"mnote-top\"><button class=\"dd\" id=\"mnote-dd\">对模型的意见（0）▾</button><div class=\"menu\" id=\"mnote-menu\"></div></div>\n<script>\n(function () {\n  const esc = (s) => String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c])\n  let notes = {}\n  function box(file) {\n    const old = (notes[file] || []).map((n) => '<div class=\"old' + (n.handled ? ' done' : '') + '\">' + esc(n.text) + '<small>' + n.at.slice(0, 16).replace('T', ' ') + (n.handled ? ' · 已处理' : ' · 待模型师') + '</small></div>').join('')\n    return '<div class=\"mnote\" data-mfile=\"' + esc(file) + '\">' + old + '<textarea placeholder=\"对这个模型元素的意见：名字不对、放错地方、多了少了、和业务不符……\"></textarea><div class=\"row\"><button data-msave=\"' + esc(file) + '\">保存意见</button><span class=\"st\"></span></div></div>'\n  }\n  function paint() {\n    document.querySelectorAll('.card[id]').forEach((c) => { const f = c.id; let m = c.querySelector(':scope > .mnote'); if (m) m.outerHTML = box(f); else c.insertAdjacentHTML('beforeend', box(f)) })\n    const all = []; for (const f in notes) for (const n of notes[f]) all.push({ f, ...n })\n    all.sort((a, b) => b.at.localeCompare(a.at))\n    const open = all.filter((n) => !n.handled).length\n    document.getElementById('mnote-dd').textContent = '对模型的意见（' + open + (all.length !== open ? '/' + all.length : '') + '）▾'\n    document.getElementById('mnote-menu').innerHTML = all.length ? all.map((n) => '<a href=\"#\" data-jump=\"' + esc(n.f) + '\" class=\"' + (n.handled ? 'done' : '') + '\"><b>' + esc(n.f.split('/').pop().replace(/\\.json$/, '')) + '</b> ' + esc(n.text.slice(0, 60)) + '</a>').join('') : '<a>还没有意见。在「模块图」或「卡片」视图每张卡下面写。</a>'\n  }\n  async function load() { try { notes = await (await fetch('/model-notes')).json() } catch (e) { notes = {} } paint() }\n  document.addEventListener('click', async (ev) => {\n    const b = ev.target.closest('[data-msave]')\n    if (b) {\n      const wrap = b.closest('.mnote'); const ta = wrap.querySelector('textarea'); const text = ta.value.trim(); if (!text) return\n      b.disabled = true\n      const r = await fetch('/model-notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: b.dataset.msave, text }) })\n      b.disabled = false; ta.value = ''\n      if (r.ok) { notes = await r.json(); paint() } else wrap.querySelector('.st').textContent = '保存失败'\n      return\n    }\n    if (ev.target.id === 'mnote-dd') { document.getElementById('mnote-top').classList.toggle('open'); return }\n    const j = ev.target.closest('[data-jump]')\n    if (j) { ev.preventDefault(); document.getElementById('mnote-top').classList.remove('open'); const el = document.getElementById(j.dataset.jump); const sec = el && el.closest('section.view'); if (sec) document.querySelector('nav [data-v=\"' + sec.id.replace('view-', '') + '\"]')?.click(); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid #f59e0b'; setTimeout(() => (el.style.outline = ''), 2000) } return }\n    if (!ev.target.closest('#mnote-top')) document.getElementById('mnote-top').classList.remove('open')\n  })\n  load()\n})()\n</script>"

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8' })
  res.end(body)
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (req.method === 'GET' && (url === '/' || url === '/model')) {
    if (!fs.existsSync(path.join(root, 'model', 'modules.json'))) return send(res, 200, 'text/html', '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px">还没有模型。模型师划好模块、建了第一个场景之后，这里就有图了。</body>')
    const out = path.join(root, 'reports', 'model.html')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const r = spawnSync(process.execPath, [path.join(__dirname, 'render.js'), root, '--out', out], { encoding: 'utf8' })
    if (r.status !== 0 || !fs.existsSync(out)) return send(res, 500, 'text/plain', '画不出模型图：' + (r.stderr || r.stdout))
    const html = fs.readFileSync(out, 'utf8')
    return send(res, 200, 'text/html', html.includes('</body>') ? html.replace('</body>', MODEL_INJECT + '</body>') : html + MODEL_INJECT)
  }
  if (req.method === 'GET' && url === '/model-notes') return send(res, 200, 'application/json', JSON.stringify(readNotes()))
  if (req.method === 'POST' && url === '/model-notes') {
    const chunks = [] // 攒齐再解码：一个汉字的几个字节可能分在两块里
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const { file, text } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!file || !text) throw new Error('缺 file 或 text')
        const notes = readNotes()
        ;(notes[file] = notes[file] ?? []).push({ text, at: new Date().toISOString(), handled: false })
        fs.mkdirSync(path.dirname(notesP), { recursive: true })
        fs.writeFileSync(notesP, JSON.stringify(notes, null, 2) + '\n', 'utf8')
        send(res, 200, 'application/json', JSON.stringify(notes))
      } catch (e) { send(res, 400, 'text/plain', String(e.message)) }
    })
    return
  }
  send(res, 404, 'text/plain', '没有这一页')
}).listen(port, '127.0.0.1', () => console.log('模型图：http://127.0.0.1:' + port + '/'))
