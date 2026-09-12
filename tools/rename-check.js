#!/usr/bin/env node
/**
 * rename-check —— 改说法切片的门禁：证明这一趟只改了名字，业务行为一个字没变。
 *
 * 用法：node tools/rename-check.js <改前解码目录> <改后解码目录> <rename-map.json> [--json]
 *
 * 对照文件与 validate.js --改名 用同一份：{ "新说法": "旧说法", … }。这里反着用——
 * 把「旧 → 新」套在改前的解码结果上（文件名与内容一起换），再与改后的解码结果逐字节比。
 * 一字不差 → 退出码 0；多了、少了、变了 → 列出来，退出码 1。
 *
 * 为什么不写成「代码跟模型 0 差异」：模型常跑在代码前面，那时 0 差异达不到，而达不到的原因与改名无关。
 * 改前那份解码结果是上一次 validate --code 留在 model-decoded/<版本>/ 的；没有就先 git 切回改前跑一次。
 */
const fs = require('node:fs')
const path = require('node:path')
const { walk, applyWordMap } = require('./lib/project')

const args = process.argv.slice(2)
const [beforeDir, afterDir, mapFile] = args.filter((a) => !a.startsWith('--')).map((p) => path.resolve(p))
if (!beforeDir || !afterDir || !mapFile || !fs.existsSync(beforeDir) || !fs.existsSync(afterDir) || !fs.existsSync(mapFile)) {
  console.error('用法：node tools/rename-check.js <改前解码目录> <改后解码目录> <rename-map.json> [--json]')
  process.exit(2)
}

let pairs
try { pairs = JSON.parse(fs.readFileSync(mapFile, 'utf8')) } catch (e) { console.error('读不了新旧对照：' + e.message); process.exit(2) }
// 对照写的是 新 → 旧；这里要把改前的旧说法换成新说法，反过来建表
const forward = {}
const clash = []
for (const [nu, old] of Object.entries(pairs)) {
  if (!old || old === nu) continue
  if (forward[old] && forward[old] !== nu) clash.push(`「${old}」既对到「${forward[old]}」又对到「${nu}」`)
  forward[old] = nu
}
if (clash.length) { console.error('对照表有歧义，反着换不唯一：\n  ' + clash.join('\n  ')); process.exit(2) }
const keys = Object.keys(forward).sort((a, b) => b.length - a.length)
const rename = (t) => applyWordMap(t, forward, keys)

/** 解码目录里每个 json：规范化成同一种缩进，路径统一斜杠 */
function load(dir) {
  const out = new Map()
  for (const f of walk(dir).filter((x) => x.endsWith('.json'))) {
    const rel = path.relative(dir, f).split(path.sep).join('/')
    let text
    try { text = JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')), null, 2) } catch { text = fs.readFileSync(f, 'utf8') }
    out.set(rel, text)
  }
  return out
}
const before = load(beforeDir)
const after = load(afterDir)
const mapped = new Map()
for (const [rel, text] of before) mapped.set(rename(rel), rename(text))

const onlyBefore = [...mapped.keys()].filter((k) => !after.has(k)).sort()
const onlyAfter = [...after.keys()].filter((k) => !mapped.has(k)).sort()
const changed = []
for (const [rel, text] of mapped) {
  if (!after.has(rel)) continue
  const b = after.get(rel)
  if (text === b) continue
  const A = text.split('\n'), B = b.split('\n')
  let i = 0
  while (i < A.length && i < B.length && A[i] === B[i]) i++
  changed.push({ file: rel, line: i + 1, before: (A[i] ?? '').trim(), after: (B[i] ?? '').trim() })
}
const ok = !onlyBefore.length && !onlyAfter.length && !changed.length
const result = { ok, files: after.size, renames: keys.length, onlyBefore, onlyAfter, changed }
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`改名核对：对照 ${keys.length} 条，改后 ${after.size} 个文件${ok ? '，套上改名后与改前一字不差：只有说法变了' : ''}`)
  for (const f of onlyBefore) console.log(`  ✗ 改前有、改后没有：${f}`)
  for (const f of onlyAfter) console.log(`  ✗ 改后多出来：${f}`)
  for (const c of changed) console.log(`  ✗ ${c.file} 第 ${c.line} 行不同\n      改前（套上改名）：${c.before}\n      改后：${c.after}`)
  if (!ok) console.log('有实质变化，或对照表漏了词：不是纯改名，按普通切片走')
}
process.exit(ok ? 0 : 1)
