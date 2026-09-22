#!/usr/bin/env node
/**
 * 外来词：一个模块的模型正文里，用了别的模块的词多少、在哪几句。
 *
 * 用法：node tools/foreign-words.js <项目> [模块名]      不给模块名就每个模块都出一张
 *
 * 只是一面镜子，不报错不报警——机器分不出「指着它」（记它的 id）、「划给它」（这事归 Contributions）、
 * 「收它给的」（递进来的合计）与「替它说它怎么行为」（它哪一成钱按时长支取、它拦不拦）。
 * 前三种可以，第四种不行；判据在 agents/common/wording.md「只说自己的事」：**把那个模块整个拿掉，这句话还成立吗？**
 * 看的人拿这张表过一遍，成立的放过，不成立的改。
 *
 * 词从词汇表来：词条名对得上某模块里一个类名的，这个词条（连它的别名）就算那个模块的词。
 * 模块名本身（Funding、Contributions）不算外来词——点名归谁是划界，不是越界。
 * 跳过 decisions[] 与 log[]（人写的话与历史）。
 *
 * 由来：2026-09-22 第一百九十二批，项目所有者：「一个模块的逻辑应该内聚……在处理 expense 的时候，我们考虑了非常多的
 * funding 是如何行为的……哪怕没有外部的模块，行为应该也独自成立站得住。」当时按类名扫是零命中——泄漏全在中文里
 * （消费那边的正文提「资金账户」92 次、「余额」34 次），所以这里按词汇表的别名抓。
 */
const path = require('node:path')
const { loadModel, loadGlossary } = require('./lib/project')

const root = process.argv[2]
const only = process.argv[3] ?? null
if (!root) { console.error('用法：node tools/foreign-words.js <项目> [模块名]'); process.exit(2) }

const model = loadModel(path.resolve(root))
const glossary = loadGlossary(path.resolve(root))
const terms = Array.isArray(glossary) ? glossary : (glossary.terms ?? glossary.entries ?? [])
const els = model.elements.filter((e) => e.kind !== 'invalid')

// 名字 → 模块。两个来处：module.json 里聚合清单的聚合名与成员名（最准），
// 加上文件名里的类名去掉种类后缀（aggregate-root.FooAggregateRoot → Foo）兜底
const SUFFIX = /(AggregateRoot|ValueObject|Entity|Service|Error|Event|Command|Query|Handler|Repository|Interface|Data)$/
const moduleOfClass = new Map()
for (const e of els) { moduleOfClass.set(e.className, e.module); moduleOfClass.set(e.className.replace(SUFFIX, ''), e.module) }
for (const mf of model.moduleFiles) for (const a of mf.data?.aggregates ?? []) { moduleOfClass.set(a.name, mf.module); for (const m of a.members ?? []) moduleOfClass.set(m, mf.module) }
// 每个模块的词（词条名 + 别名），只收对得上类名的词条
const isLatin = (s) => /^[A-Za-z0-9 _-]+$/.test(s)
const wordsOf = new Map()
for (const t of terms) {
  const mod = moduleOfClass.get(t.name)
  if (!mod) continue
  if (!wordsOf.has(mod)) wordsOf.set(mod, [])
  // 两个字的别名只认排在第一位的那个（正式中文名）：「一段」「口袋」「批准」这类排在后面的短别名满篮子都是，
  // 当词条名匹配时一半是误报（Episode 的「一段」会咬住「哪一段期间」）
  const aliases = t.aliases ?? []
  for (const w of [t.name, ...aliases]) {
    const s = String(w ?? '')
    if (!s || s.length < 2) continue
    if (!isLatin(s) && s.length === 2 && s !== aliases[0]) continue
    wordsOf.get(mod).push({ word: s, term: t.name })
  }
}
const modules = [...new Set(els.map((e) => e.module))]

const hit =(text, w) => isLatin(w) ? new RegExp('(?<![A-Za-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(text) : text.includes(w)

function sentences(node, out = []) {
  if (node == null) return out
  if (typeof node === 'string') { for (const s of node.split(/(?<=[。；\n])/)) if (s.trim()) out.push(s.trim()); return out }
  if (Array.isArray(node)) { for (const x of node) sentences(x, out); return out }
  for (const [k, v] of Object.entries(node)) { if (k === 'decisions' || k === 'log') continue; sentences(v, out) }
  return out
}

console.log('外来词——判据：把那个模块整个拿掉，这句话还成立吗？成立的（指着它 / 划给它 / 收它给的）放过，不成立的（替它说它怎么行为）改。\n')
for (const mod of modules) {
  if (only && mod !== only) continue
  const mine = els.filter((e) => e.module === mod)
  const rows = [] // { other, word, term, file, sentence }
  for (const e of mine) {
    const ss = sentences(e.data)
    for (const [other, words] of wordsOf) {
      if (other === mod) continue
      for (const s of ss) for (const { word, term } of words) if (hit(s, word)) { rows.push({ other, word, term, file: e.file.replace(/^model\//, ''), sentence: s }); break }
    }
  }
  const byOther = new Map()
  for (const r of rows) byOther.set(r.other, (byOther.get(r.other) ?? 0) + 1)
  console.log(`## ${mod}　${rows.length ? [...byOther].map(([o, n]) => `用了 ${o} 的词 ${n} 句`).join('，') : '没有外来词'}`)
  if (!rows.length) { console.log(''); continue }
  // 每个文件最多印 4 句，免得一屏刷满
  const byFile = new Map()
  for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r) }
  for (const [file, rs] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${file}　${rs.length} 句`)
    for (const r of rs.slice(0, 4)) console.log(`    · [${r.other}.${r.term}「${r.word}」] ${r.sentence.length > 110 ? r.sentence.slice(0, 110) + '…' : r.sentence}`)
    if (rs.length > 4) console.log(`    …还有 ${rs.length - 4} 句`)
  }
  console.log('')
}
