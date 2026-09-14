#!/usr/bin/env node
/**
 * 装配一个角色的完整指令：角色 frontmatter `reads:` 点名的规范（含它要的 agents/common/ 那几份）+ 角色文件本身。
 * common/ 是库，不是人人都带——谁要谁点名（2026-09-15 项目所有者：「common 并不是全员都用」）。
 * 开发指挥派角色时把这份输出（加上下文块与任务）当子 agent 的提示词；角色不再自己去读 seed。
 *
 * 用法：node tools/brief.js <角色名或文件名> [--list] [--size]
 *   角色名用中文（模型师、业务分析、讲解、文职、原型、接口、编码、模型校验、pre-pr 审查、解读）或文件名（modeler）。
 *   --list  只打印会拼进去的文件与各自字节数，不打印正文
 *   --size  末尾多打一行合计字节数（到 stderr，不进提示词）
 *
 * 由来：2026-09-14 项目所有者——「只有那些 agent 特异化的技能才应该进 agent，通用的规范进 common 文件夹，这样可以灵活地装配」
 *      「不用再看 seed 了，将 seed 的内容分发下去，平时使用时只传唤 agent 即可」。
 */
const fs = require('node:fs')
const path = require('node:path')

const AGENTS = path.join(__dirname, '..', 'agents')
const ROLES = {
  '业务分析': 'business/business-analyst.md', 'business-analyst': 'business/business-analyst.md',
  '讲解': 'business/guide.md', 'guide': 'business/guide.md',
  '文职': 'common/editor.md', 'editor': 'common/editor.md',
  '模型师': 'model/modeler.md', 'modeler': 'model/modeler.md',
  '模型校验': 'model/validator.md', 'validator': 'model/validator.md',
  '原型': 'code/prototyper.md', 'prototyper': 'code/prototyper.md',
  '接口': 'code/interface.md', 'interface': 'code/interface.md',
  '编码': 'code/coder.md', 'coder': 'code/coder.md',
  'pre-pr 审查': 'code/pre-pr-reviewer.md', 'pre-pr-reviewer': 'code/pre-pr-reviewer.md', 'pre-pr': 'code/pre-pr-reviewer.md',
  '解读': 'casual/reader.md', 'reader': 'casual/reader.md',
}

function die(msg) { console.error('[brief] ' + msg); process.exit(2) }

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  let key = null
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && key) { (meta[key] = meta[key] || []).push(item[1].trim()); continue }
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    key = kv[1]
    const v = kv[2].trim()
    if (v === '' ) meta[key] = []
    else if (v === '[]') meta[key] = []
    else meta[key] = v
  }
  return { meta, body: text.slice(m[0].length) }
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'))
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const who = args[0]
  if (!who) die('要一个角色名：' + Object.keys(ROLES).filter((k) => /[^\x00-\x7f]/.test(k)).join('、'))
  const rel = ROLES[who] || (fs.existsSync(path.join(AGENTS, who)) ? who : null)
  if (!rel) die('不认识的角色：' + who)
  const roleText = fs.readFileSync(path.join(AGENTS, rel), 'utf8')
  const { meta, body } = parseFrontmatter(roleText)
  const reads = Array.isArray(meta.reads) ? meta.reads : []
  // 相对 agents/ 解析；写成 ../seed/… 的也认
  const files = reads.map((r) => path.normalize(path.join(AGENTS, r)))
  for (const f of files) if (!fs.existsSync(f)) die(`${rel} 点名的规范不存在：${path.relative(AGENTS, f)}`)

  const parts = []
  for (const f of files) parts.push(fs.readFileSync(f, 'utf8').trimEnd())
  parts.push(body.trimEnd())
  const out = parts.join('\n\n---\n\n') + '\n'

  const rows = [...files.map((f) => [path.relative(AGENTS, f), fs.statSync(f).size]), [rel + '（正文）', Buffer.byteLength(body)]]
  const total = Buffer.byteLength(out)
  if (flags.has('--list')) {
    for (const [name, size] of rows) console.log(`${String(size).padStart(7)}  ${name}`)
    console.log(`${String(total).padStart(7)}  合计`)
    return
  }
  process.stdout.write(out)
  if (flags.has('--size')) console.error(`[brief] ${who} 合计 ${total} 字节（${rows.length} 份）`)
}

main(process.argv.slice(2))
