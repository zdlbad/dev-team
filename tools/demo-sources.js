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
 * 这支工具核四件：
 *   ① 绿的那个编号在 business/ 里真有——**嘴上标的不算**。没有编号或编号不存在，按假的报。
 *   ② 蓝的那个批次在 raw/rulings.md 里真有。
 *   ③ 黄的都写了 why——那张单子就是靠这一栏立起来的。
 *   ④ 黄的落实了没有（settled）——立成了哪条语句、记成了哪件候选、他哪一批裁了，还是明说不做。
 *      slice advance <切片> demo done 拿这一条上锁（第一百九十九批）：没落实就不许收口。
 * 再报三色各占多少：**黄的比例就是「业务还有多少没定」**，那是给业务分析的输入，不是预演的错。
 *
 * 它核不了「这条语句到底说没说这件事」——那要人读。工具只保证编号真实存在、没人拿不存在的编号充绿。
 *
 * 由来：2026-09-22 第一百九十七批。项目所有者定下「这个预演不是 source of truth，是用来收集和验证业务的」，
 * 第二百零一批补上时间限定：定下来之前不作准，定下来之后要反映业务——所以多核一样「落实了、页面还标着黄」。
 * 并要三色标记做进页面。开发指挥当时提的担心正是这一条：绿色可以伪造，而且多半是无意的——
 * 角色读了一堆语句，印象里觉得有。机器核不了的标记等于没有。
 */
const { demoSources } = require('./lib/project')

const root = process.argv[2]
const 要清单 = process.argv.includes('--清单')
if (!root) { console.error('用法：node tools/demo-sources.js <项目> [--清单]'); process.exit(2) }

const r = demoSources(root)
if (!r.has) { console.log('demo/sources.json 还没有——预演这一趟还没标来源，或者这个项目还没演过。'); process.exit(0) }
if (r.broken) { console.error('demo/sources.json 读不动：' + r.broken); process.exit(1) }

const 共 = r.rows.length
const pct = (n) => (共 ? Math.round((n / 共) * 100) : 0)
console.log(`三色来源：共 ${共} 样　绿 ${r.计.绿}（${pct(r.计.绿)}%，语句说的）　蓝 ${r.计.蓝}（${pct(r.计.蓝)}%，他裁的）　黄 ${r.计.黄}（${pct(r.计.黄)}%，页面上编的）`)
console.log('黄的比例就是「业务还有多少没定」——那是给业务分析的输入，不是预演的错。\n')

const 报 = (名, 单, 画) => { if (!单.length) return 0; console.log(`## ${名}（${单.length}）`); for (const x of 单) console.log('  ' + 画(x)); console.log(''); return 单.length }
let 错 = 0
错 += 报('标了绿、编号却查无此条——按假的算', r.假绿, (x) => `${x.where}　${x.what}　→ ${x.bad.join('、')}`)
错 += 报('标了蓝、裁定里找不到这一批', r.假蓝, (x) => `${x.where}　${x.what}　→ ${x.ref}`)
错 += 报('标了黄却没说为什么非有不可', r.没说清, (x) => `${x.where}　${x.what}`)
错 += 报('色标得不对（只许绿 / 蓝 / 黄）', r.色不对, (x) => `${x.where}　${x.what}　→ ${x.color}`)
报('黄的还没落实（门会拦在这儿）', r.没落实, (x) => `${x.where}　${x.what}`)
报('落实了、页面却还标着黄（门会拦在这儿）', r.没跟上, (x) => `${x.where}　${x.what}　→ 已落实成 ${x.settled.as} ${x.settled.ref}`)

if (要清单) {
  const 黄 = r.rows.filter((x) => x.color === '黄')
  console.log(`## 页面上编的（${黄.length} 件，交给开发指挥分流）`)
  for (const x of 黄) console.log(`  · ${x.where}　${x.what}\n      ${x.why ?? '（没说）'}${x.settled ? `\n      落实：${x.settled.as} ${x.settled.ref ?? x.settled.why ?? ''}` : '\n      落实：还没有'}`)
  console.log('')
}

console.log(错 ? `→ ${错} 处站不住，预演要改` : '→ 来源都站得住')
if (r.没落实.length) console.log(`→ 还有 ${r.没落实.length} 件黄的没落实，这道门收不了口`)
if (r.没跟上.length) console.log(`→ 还有 ${r.没跟上.length} 件落实了、页面没跟上，这道门收不了口`)
process.exit(错 ? 1 : 0)
