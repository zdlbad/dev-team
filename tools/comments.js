#!/usr/bin/env node
/**
 * 业务页上的留言：人在「业务」页签给某一段留言，业务分析查原料作答，答复留在问题下面，人可以接着追问。
 *
 *   node tools/comments.js list <项目> [--all]              列等答的留言（最后一句是人说的）；--all 连答过的
 *   node tools/comments.js reply <项目> <c-xxx> "<答复>" [--who 业务分析]
 *
 * 存在 <项目>/reports/_business-comments.json：
 *   { "comments": [{ id, doc, block, heading, snippet, thread: [{ who, text, at }] }] }
 * doc 是相对项目根的文件；block 是那一段原文的指纹（lib/markdown.js 的 data-b）；heading、snippet 在原文改掉、
 * 指纹对不上时帮人认出原来是哪一段。
 */
const fs = require('node:fs')
const path = require('node:path')
const clock = require('./lib/time')

const fileOf = (root) => path.join(root, 'reports', '_business-comments.json')
function load(root) {
  try { return JSON.parse(fs.readFileSync(fileOf(root), 'utf8')) } catch { return { comments: [] } }
}
function save(root, data) {
  fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true })
  fs.writeFileSync(fileOf(root), JSON.stringify(data, null, 2) + '\n', 'utf8')
}
const waiting = (c) => c.thread.at(-1)?.who === '人'
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

function add(root, { doc, block, heading, snippet, text }) {
  if (!doc || !text?.trim()) throw new Error('要有文件和留言')
  const data = load(root)
  const n = data.comments.reduce((m, c) => Math.max(m, Number(c.id.slice(2)) || 0), 0) + 1
  const c = { id: 'c-' + String(n).padStart(3, '0'), doc, block: block ?? null, heading: clip(heading, 80), snippet: clip(snippet, 120), thread: [{ who: '人', text: text.trim(), at: new Date().toISOString() }] }
  data.comments.push(c)
  save(root, data)
  return c
}

function reply(root, id, text, who) {
  if (!text?.trim()) throw new Error('答复是空的')
  const data = load(root)
  const c = data.comments.find((x) => x.id === id)
  if (!c) throw new Error('没有这条留言：' + id)
  c.thread.push({ who, text: text.trim(), at: new Date().toISOString() })
  save(root, data)
  return c
}

module.exports = { load, add, reply, waiting, fileOf }

if (require.main === module) {
  const [cmd, rootArg, ...rest] = process.argv.slice(2)
  const die = (m) => { console.error('[comments] ' + m); process.exit(2) }
  if (!cmd || !rootArg) die('用法：node tools/comments.js <list|reply> <项目> …（详见文件头）')
  const root = path.resolve(rootArg)
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined }
  if (cmd === 'list') {
    const all = load(root).comments.filter((c) => rest.includes('--all') || waiting(c))
    if (!all.length) { console.log(rest.includes('--all') ? '还没有留言。' : '没有等答的留言。'); process.exit(0) }
    for (const c of all) {
      console.log(`${c.id} · ${c.doc} · ${c.heading ? '「' + c.heading + '」' : '（开头）'}${waiting(c) ? ' · 等答' : ' · 答过'}`)
      if (c.snippet) console.log('  原文：' + c.snippet)
      for (const m of c.thread) console.log(`  ${m.who}（${clock.mdhm(m.at)}）：${m.text}`)
    }
    console.log(`\n答：node tools/comments.js reply ${rootArg} <c-xxx> "<答复>"`)
  } else if (cmd === 'reply') {
    const [id, text] = rest.filter((x, i) => !x.startsWith('--') && rest[i - 1] !== '--who')
    try { const c = reply(root, id, text, opt('--who') ?? '业务分析'); console.log(`${c.id} 答好了（${c.thread.length} 句）`) } catch (e) { die(e.message) }
  } else die('不认识的子命令：' + cmd)
}
