#!/usr/bin/env node
/**
 * 三色来源：核预演页面上每样东西的出处。
 *
 * 用法：node tools/demo-sources.js <项目> [--清单]
 *   --清单  连「页面上编的」那张单子一起打印（给开发指挥分流用）
 *
 * 预演写 `demo/sources.json`，一条一样东西：
 *   {
 *     "where": "老人页 · 消费 · 录一笔消费",     哪一页哪一块哪个操作/字段
 *     "what":  "共付额按当时的比例算出来",        这一样东西是什么
 *     "color": "绿" | "蓝" | "黄",
 *     "ref":   "R-102"          绿：业务语句编号（可以几条，逗号隔开）
 *              "第一百九十三批"  蓝：裁定批次
 *              null             黄：页面上编的
 *     "why":   "……"            黄必填：为什么非有不可、我选了哪个
 *   }
 *
 * 这支工具核三件：
 *   ① 绿的那个编号在 business/ 里真有——**嘴上标的不算**。没有编号或编号不存在，按假的报。
 *   ② 蓝的那个批次在 raw/rulings.md 里真有。
 *   ③ 黄的都写了 why——那张单子就是靠这一栏立起来的。
 * 再报三色各占多少：**黄的比例就是「业务还有多少没定」**，那是给业务分析的输入，不是预演的错。
 *
 * 它核不了「这条语句到底说没说这件事」——那要人读。工具只保证编号真实存在、没人拿不存在的编号充绿。
 *
 * 由来：2026-09-22 第一百九十七批。项目所有者定下「这个预演不是 source of truth，是用来收集和验证业务的」，
 * 并要三色标记做进页面。开发指挥当时提的担心正是这一条：绿色可以伪造，而且多半是无意的——
 * 角色读了一堆语句，印象里觉得有。机器核不了的标记等于没有。
 */
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
const 要清单 = process.argv.includes('--清单')
if (!root) { console.error('用法：node tools/demo-sources.js <项目> [--清单]'); process.exit(2) }

const p = path.join(root, 'demo', 'sources.json')
if (!fs.existsSync(p)) {
  console.log('demo/sources.json 还没有——预演这一趟还没标来源，或者这个项目还没演过。')
  process.exit(0)
}

let rows
try { rows = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { console.error('demo/sources.json 读不动：' + e.message); process.exit(1) }
if (!Array.isArray(rows)) rows = rows.items ?? []

// 业务语句里真有的编号
const ids = new Set()
const bdir = path.join(root, 'business')
const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
  const fp = path.join(d, f.name)
  if (f.isDirectory()) walk(fp)
  else if (f.name.endsWith('.md')) for (const m of fs.readFileSync(fp, 'utf8').matchAll(/^\s*-\s*\[([A-Z]-\d{3})\]/gm)) ids.add(m[1])
} }
walk(bdir)

const rulings = fs.existsSync(path.join(root, 'raw', 'rulings.md')) ? fs.readFileSync(path.join(root, 'raw', 'rulings.md'), 'utf8') : ''

const 假绿 = [], 假蓝 = [], 没说清 = [], 色不对 = []
const 计 = { 绿: 0, 蓝: 0, 黄: 0 }
for (const r of rows) {
  const 色 = String(r.color ?? '').trim()
  if (!['绿', '蓝', '黄'].includes(色)) { 色不对.push(r); continue }
  计[色]++
  if (色 === '绿') {
    const refs = String(r.ref ?? '').split(/[,，、\s]+/).filter(Boolean)
    const bad = refs.filter((x) => !ids.has(x))
    if (!refs.length || bad.length) 假绿.push({ ...r, bad: refs.length ? bad : ['（没写编号）'] })
  } else if (色 === '蓝') {
    if (!r.ref || !rulings.includes(String(r.ref))) 假蓝.push(r)
  } else if (!String(r.why ?? '').trim()) 没说清.push(r)
}

const 共 = rows.length
const pct = (n) => 共 ? Math.round((n / 共) * 100) : 0
console.log(`三色来源：共 ${共} 样　绿 ${计.绿}（${pct(计.绿)}%，语句说的）　蓝 ${计.蓝}（${pct(计.蓝)}%，他裁的）　黄 ${计.黄}（${pct(计.黄)}%，页面上编的）`)
console.log('黄的比例就是「业务还有多少没定」——那是给业务分析的输入，不是预演的错。\n')

const 报 = (名, 单, 画) => { if (!单.length) return 0; console.log(`## ${名}（${单.length}）`); for (const x of 单) console.log('  ' + 画(x)); console.log(''); return 单.length }
let 错 = 0
错 += 报('标了绿、编号却查无此条——按假的算', 假绿, (x) => `${x.where}　${x.what}　→ ${x.bad.join('、')}`)
错 += 报('标了蓝、裁定里找不到这一批', 假蓝, (x) => `${x.where}　${x.what}　→ ${x.ref}`)
错 += 报('标了黄却没说为什么非有不可', 没说清, (x) => `${x.where}　${x.what}`)
错 += 报('色标得不对（只许绿 / 蓝 / 黄）', 色不对, (x) => `${x.where}　${x.what}　→ ${x.color}`)

if (要清单) {
  const 黄 = rows.filter((r) => r.color === '黄')
  console.log(`## 页面上编的（${黄.length} 件，交给开发指挥分流）`)
  for (const x of 黄) console.log(`  · ${x.where}　${x.what}\n      ${x.why ?? '（没说）'}`)
  console.log('')
}

console.log(错 ? `→ ${错} 处站不住，预演要改` : '→ 来源都站得住')
process.exit(错 ? 1 : 0)
