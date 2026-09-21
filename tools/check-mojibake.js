/**
 * 乱码体检：项目里有没有 U+FFFD。
 * 由来（2026-09-21）：页面保存收正文时逐块拼字符串，一个汉字的三个字节劈在两块里就各解成 U+FFFD，
 * 页面保存一次正文里少一个字，不报错、schema 也过，隔几天才被人看见。收正文那头已经改成攒 Buffer 再解码，
 * 这一支是兜底：每次收工前跑一下，有就当场补回来（老的字从 git 历史里捞）。
 * 用法：node tools/check-mojibake.js <项目目录> [--history] [--raw]
 * 默认只看我们自己写的那几处，跳过 slices/.history 的快照与 raw/。raw/ 里的 U+FFFD 是从 PDF 抽文字时就有的
 * （抽不出来的符号），原料只读不改，不算这一支要抓的毛病。
 */
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
if (!root) { console.error('用法：node tools/check-mojibake.js <项目目录> [--history]'); process.exit(2) }
const withHistory = process.argv.includes('--history')
const withRaw = process.argv.includes('--raw')
const hits = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules' && (withHistory || e.name !== '.history') && (withRaw || e.name !== 'raw')) walk(p); continue }
    if (!/\.(json|md|jsonl|txt)$/.test(e.name)) continue
    const t = fs.readFileSync(p, 'utf8')
    let i = -1
    while ((i = t.indexOf('�', i + 1)) >= 0) {
      const line = t.slice(0, i).split('\n').length
      hits.push(`${path.relative(root, p)}:${line}　…${t.slice(Math.max(0, i - 16), i)}▮${t.slice(i + 1, i + 12).replace(/�/g, '')}…`)
      while (t[i + 1] === '�') i++ // 一个汉字劈开是连着几个，算一处
    }
  }
})(root)
if (!hits.length) { console.log('没有乱码。'); process.exit(0) }
console.log(`${hits.length} 处乱码（▮ 就是丢掉的那个字，从 git 历史里捞回来）：`)
for (const h of hits) console.log('  ' + h)
process.exit(1)
