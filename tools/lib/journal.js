/**
 * 日志：只追加不裁剪的 journal/<UTC 日期>.jsonl（scene.js 每写一笔看板就记一行；plan.js、review.js 把人在页面上的动作也记进来）。
 * 2026-09-14 项目所有者：「我没有 log 可以看到 agent 们是怎样配合的……小步骤也记」「log 记了吧」——人自己点的确认、同意也要在。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
function journal(root, entry) {
  const ts = entry.ts ?? new Date().toISOString()
  const dir = path.join(root, 'journal')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, machine: os.hostname(), ...entry }) + '\n')
}
module.exports = { journal }
