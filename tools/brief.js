#!/usr/bin/env node
/**
 * 派工书：把一个角色这一趟要的指令装成一份——角色文件头上 `reads:` 点名的规范，加上角色文件本身。
 *
 *   node tools/brief.js <角色> [--活 <这趟干什么>] [--写 <文件>] [--list]
 *
 *   角色用中文名（业务分析、模型师、编码、审查、文职、分身）或文件名（modeler）。
 *   --活   只带「常驻」那几份，加上这一样活点名的那几份；不给就按角色文件头上的「默认活」。
 *   --写   把派工书落到文件，屏幕上只回一行。派工时提示里只给这个路径，角色一次读完。
 *   --list 只列会拼进去的文件与字数。
 *
 * `reads:` 的写法：
 *   reads:
 *     常驻:
 *       - common/discipline.md
 *     建模:
 *       - model/shapes.md#步骤语法      ← 井号后面是小节标题的关键字，只带那一节（连它的子节）
 */
const fs = require('node:fs')
const path = require('node:path')

const AGENTS = path.join(__dirname, '..', 'agents')
const ROLES = {
  '业务分析': 'business/business-analyst.md', 'business-analyst': 'business/business-analyst.md',
  '模型师': 'model/modeler.md', 'modeler': 'model/modeler.md',
  '编码': 'code/coder.md', 'coder': 'code/coder.md',
  '审查': 'review/reviewer.md', 'reviewer': 'review/reviewer.md',
  '文职': 'common/editor.md', 'editor': 'common/editor.md',
  '分身': 'common/scout.md', 'scout': 'common/scout.md',
}
const die = (m) => { console.error('[brief] ' + m); process.exit(2) }

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  let key = null, sub = null
  for (const line of m[1].split('\n')) {
    const item = /^(\s+)-\s+(.*)$/.exec(line)
    if (item && key) {
      const v = item[2].replace(/\s+#.*$/, '').trim()
      if (sub) meta[key][sub].push(v)
      else (Array.isArray(meta[key]) ? meta[key] : (meta[key] = [])).push(v)
      continue
    }
    const nested = /^\s+([^\s:][^:]*):\s*(\[\])?\s*$/.exec(line)
    if (nested && key) {
      if (typeof meta[key] !== 'object' || Array.isArray(meta[key])) meta[key] = {}
      sub = nested[1].trim()
      meta[key][sub] = []
      continue
    }
    const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    key = kv[1].trim()
    sub = null
    const v = kv[2].trim()
    meta[key] = v === '' || v === '[]' ? [] : v
  }
  return { meta, body: text.slice(m[0].length) }
}

/** 取一份规范：没有井号整份；有井号只取标题含这个关键字的那一节（连子节） */
function pick(ref) {
  const [rel, anchor] = ref.split('#')
  const file = path.join(AGENTS, rel)
  if (!fs.existsSync(file)) die(`点名的规范不存在：${rel}`)
  const text = parseFrontmatter(fs.readFileSync(file, 'utf8')).body.trimEnd()
  if (!anchor) return { rel, text }
  const lines = text.split('\n')
  const i = lines.findIndex((l) => /^#{2,6}\s/.test(l) && l.includes(anchor))
  if (i < 0) die(`${rel} 里没有标题含「${anchor}」的小节`)
  const lv = /^(#+)/.exec(lines[i])[1].length
  let j = i + 1
  while (j < lines.length && !(/^(#+)\s/.test(lines[j]) && /^(#+)/.exec(lines[j])[1].length <= lv)) j++
  return { rel: `${rel}#${anchor}`, text: `> 摘自 ${rel}\n\n` + lines.slice(i, j).join('\n').trimEnd() }
}

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const who = argv[0]
if (!who || who.startsWith('--')) die('要一个角色名：' + Object.keys(ROLES).filter((k) => /[^\x00-\x7f]/.test(k)).join('、'))
const rel = ROLES[who] ?? (fs.existsSync(path.join(AGENTS, who)) ? who : null)
if (!rel) die(`不认识的角色：${who}。可用：${Object.keys(ROLES).filter((k) => /[^\x00-\x7f]/.test(k)).join('、')}`)
const own = parseFrontmatter(fs.readFileSync(path.join(AGENTS, rel), 'utf8'))
const reads = own.meta.reads ?? {}
const job = opt('--活') ?? own.meta['默认活'] ?? null
const jobs = Object.keys(reads).filter((k) => k !== '常驻')
if (job && jobs.length && !jobs.includes(job)) die(`${who} 没有「${job}」这样活。有：${jobs.join('、')}`)
const refs = [...new Set([...(Array.isArray(reads) ? reads : reads['常驻'] ?? []), ...(job && reads[job] ? reads[job] : [])])]
const parts = refs.map(pick)

if (argv.includes('--list')) {
  for (const p of parts) console.log(`${String([...p.text].length).padStart(6)} 字　${p.rel}`)
  console.log(`${String([...own.body].length).padStart(6)} 字　${rel}（角色本身）${job ? `　这一趟：${job}` : ''}`)
  process.exit(0)
}
const out = [
  `# 派工书：${who}${job ? ` · ${job}` : ''}`,
  '',
  own.body.trimEnd(),
  ...parts.map((p) => `\n\n---\n\n${p.text}`),
].join('\n') + '\n'
const to = opt('--写')
if (to) {
  fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true })
  fs.writeFileSync(to, out, 'utf8')
  console.log(`派工书写好了：${to}（${[...out].length} 字）`)
} else process.stdout.write(out)
