#!/usr/bin/env node
/**
 * 装配一个角色的完整指令：角色 frontmatter `reads:` 点名的规范（含它要的 agents/common/ 那几份）+ 角色文件本身。
 * common/ 是库，不是人人都带——谁要谁点名（2026-09-15 项目所有者：「common 并不是全员都用」）。
 * 开发指挥派角色时把这份输出（加上下文块与任务）当子 agent 的提示词；角色不再自己去读 seed。
 *
 * 用法：node tools/brief.js <角色名或文件名> [--活 <这趟干什么>] [--整份] [--list] [--size]
 *   角色名用中文（模型师、业务分析、讲解、文职、原型、接口、编码、模型校验、pre-pr 审查、解读）或文件名（modeler）。
 *   --活    按这趟的活装：只带常驻那几份，加上这一档点名的那几份／那几节。不给就按角色文件头上的「默认活」装；--整份 才把所有档并起来（第一百七十二批）
 *   --list  只打印会拼进去的文件与各自字节数，不打印正文（带 --活 时也列这一档没带的）
 *   --size  末尾多打一行合计字节数（到 stderr，不进提示词）
 *   --写 <文件>  把装好的派工书落到这个文件，屏幕上只回一行。开发指挥派工前跑它，提示里只给路径，
 *               角色一次 Read 读完——别在提示里写「先跑 brief.js」，那份输出超工具上限会被切碎，读它要八轮
 *
 * `reads:` 两种写法：
 *   一张平清单（老写法，整份带）：
 *     reads:
 *       - common/discipline.md
 *   按活分档（第一百七十一批）：
 *     reads:
 *       常驻:            # 每趟都带
 *         - common/discipline.md
 *       改现有模型:       # --活 改现有模型 时才带
 *         - model/shapes.md#领域对象      ← 井号后面是小节标题的关键字，只带那一节
 *         - common/wording.md#-规则句,-一事一处  ← 减号开头是排除：除这几节外都带（大半要、只有两三节不要时用）
 * 没带的部分自动附一张索引（一行一节，写清什么时候该看、怎么取回），角色用 `look doc` 现取。
 *
 * 由来：2026-09-14 项目所有者——「只有那些 agent 特异化的技能才应该进 agent，通用的规范进 common 文件夹，这样可以灵活地装配」
 *      「不用再看 seed 了，将 seed 的内容分发下去，平时使用时只传唤 agent 即可」。
 *      2026-09-20 第一百七十一批：派工书按活裁。他问「怎么决定需要加载什么」——拿转录里角色真正碰过的工件定第一版
 *      （模型师 28 趟：聚合根 89%、错误 82%、领域服务 71%，而仓储、端口各 14%、命令处理 29%，这几样不必每趟背着）。
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
  // 分身不是十个角色之一：只读的一次性探子，派工书极小（第一百八十批）
  '分身': 'common/scout.md', 'scout': 'common/scout.md',
}

function die(msg) { console.error('[brief] ' + msg); process.exit(2) }

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  let key = null, sub = null
  for (const line of m[1].split('\n')) {
    const item = /^(\s+)-\s+(.*)$/.exec(line)
    if (item && key) {
      const v = item[2].replace(/\s+#.*$/, '').trim() // 行尾注释不算内容
      if (sub) meta[key][sub].push(v)
      else (Array.isArray(meta[key]) ? meta[key] : (meta[key] = [])).push(v)
      continue
    }
    const nested = /^\s+([^\s:][^:]*):\s*$/.exec(line) // 缩进一层、以冒号结尾：按活分档的那一档
    if (nested && key) {
      if (Array.isArray(meta[key]) && !meta[key].length) meta[key] = {}
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
    if (v === '' || v === '[]') meta[key] = []
    else meta[key] = v
  }
  return { meta, body: text.slice(m[0].length) }
}

/** 一份 Markdown 的小节目录：[{标题, 级别, 起行, 止行, 字数}] */
function sections(text) {
  const lines = text.split('\n')
  const heads = []
  lines.forEach((l, i) => { const m = /^(#{2,6})\s+(.*)$/.exec(l); if (m) heads.push({ lv: m[1].length, title: m[2].trim(), i }) })
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.lv <= h.lv)
    const end = next ? next.i : lines.length
    return { ...h, end, text: lines.slice(h.i, end).join('\n').trimEnd() }
  })
}

/**
 * "common/wording.md#规则句"    → 只取那一节
 * "common/wording.md#-规则句,-一事一处" → 除掉这几节，其余都带（整份里大半要、只有两三节不要时用这个，
 *                                 免得把十来节一节一节列出来，每节还各顶一行「摘自」）
 * 没有井号就整份。
 */
function pickPart(ref) {
  const [rel, anchor] = ref.split('#')
  const file = path.normalize(path.join(AGENTS, rel))
  if (!fs.existsSync(file)) die(`点名的规范不存在：${rel}`)
  const text = fs.readFileSync(file, 'utf8')
  if (!anchor) return { rel, file, anchor: null, text: text.trimEnd() }
  const all = sections(text)
  if (anchor.startsWith('-')) {
    const drop = anchor.split(',').map((x) => x.trim().replace(/^-/, '')).filter(Boolean)
    for (const d of drop) if (!all.some((s) => s.title.includes(d))) die(`${rel} 里没有标题含「${d}」的小节（写在 # 后面的排除清单里）`)
    const kept = all.filter((s) => !drop.some((d) => s.title.includes(d)))
    const lines = text.split('\n')
    const preface = lines.slice(0, all[0].i).join('\n').trimEnd() // 第一个 ## 之前的开场白照带
    const body = [preface, ...kept.map((s) => s.text)].filter(Boolean).join('\n\n')
    return { rel, file, anchor, text: `> 摘自 ${rel}（这一趟用不上的 ${drop.length} 节没带：${drop.join('、')}；见末尾索引）\n\n${body}` }
  }
  const hit = all.find((s) => s.title.includes(anchor))
  if (!hit) die(`${rel} 里没有标题含「${anchor}」的小节`)
  return { rel, file, anchor, text: `> 摘自 ${rel}（整份还有别的小节，见末尾索引）\n\n${hit.text}` }
}

function main(argv) {
  const args = []
  const flags = new Set()
  let job = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--活' || a === '--for') { job = argv[++i]; continue }
    if (a === '--写') { flags.add('--写'); i++; continue }
    if (a.startsWith('--')) { flags.add(a); continue }
    args.push(a)
  }
  const who = args[0]
  if (!who) die('要一个角色名：' + Object.keys(ROLES).filter((k) => /[^\x00-\x7f]/.test(k)).join('、'))
  const rel = ROLES[who] || (fs.existsSync(path.join(AGENTS, who)) ? who : null)
  if (!rel) die('不认识的角色：' + who)
  const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(AGENTS, rel), 'utf8'))
  const reads = meta.reads
  const byJob = reads && !Array.isArray(reads) && typeof reads === 'object'
  const jobs = byJob ? Object.keys(reads).filter((k) => k !== '常驻') : []
  if (job && !byJob) die(`${rel} 的 reads 还是一张平清单，没有分档，用不了 --活`)
  if (job && !jobs.includes(job)) die(`${rel} 没有「${job}」这一档；有：${jobs.join('、')}`)

  // 不写 --活 就按角色文件头上的「默认活」装（第一百七十二批：从前这里把所有档并起来，比不分档还大，是个陷阱）
  if (byJob && !job) {
    job = typeof meta['默认活'] === 'string' ? meta['默认活'] : jobs[0]
    if (!jobs.includes(job)) die(`${rel} 的默认活「${job}」不在分档里；有：${jobs.join('、')}`)
    console.error(`[brief] 没给 --活，按默认活「${job}」装；要别的档：--活 ${jobs.filter((j) => j !== job).join(' / --活 ')}；整份装：--整份`)
  }
  let refs
  if (!byJob) refs = Array.isArray(reads) ? reads : []
  else if (flags.has('--整份')) { refs = [...new Set(Object.values(reads).flat())]; job = null }
  else refs = [...(reads['常驻'] ?? []), ...reads[job]]

  const parts = refs.map(pickPart)
  const chosen = new Set(parts.map((p) => p.rel + (p.anchor ? '#' + p.anchor : '')))
  // 没带的：这个角色别的档点过、这一趟没带的文件，以及带了某几节的文件里剩下的那些节
  const indexLines = []
  if (byJob) {
    const all = [...new Set(Object.values(reads).flat())]
    const tookWhole = new Set(parts.filter((p) => !p.anchor).map((p) => p.rel))
    for (const ref of all) {
      const [r, anchor] = ref.split('#')
      if (tookWhole.has(r)) continue
      if (chosen.has(ref)) continue
      indexLines.push(anchor ? `  ${r}#${anchor}` : `  ${r}（整份）`)
    }
    // 带了某几节的文件：剩下的那些节才进索引（同一份文件带了好几节，逐节都要排除）
    const anchorsOf = new Map()
    for (const p of parts.filter((x) => x.anchor)) anchorsOf.set(p.rel, [...(anchorsOf.get(p.rel) ?? []), p.anchor])
    for (const [r, anchors] of anchorsOf) {
      for (const s of sections(fs.readFileSync(path.join(AGENTS, r), 'utf8'))) {
        if (anchors.some((a) => s.title.includes(a))) continue
        const line = `  ${r}#${s.title}`
        if (!indexLines.includes(line)) indexLines.push(line)
      }
    }
  }
  const indexBlock = indexLines.length
    ? `## 这趟没带的（用到再取，别猜）\n\n一条命令可以连着取几节，中间用 \`+\` 隔开：\n\n\`\`\`\nnode $DEV_TEAM/tools/look.js <项目> doc <文件> <标题关键字> + doc <文件> <标题关键字>\n\`\`\`\n\n没带的是这些：\n\n\`\`\`\n${[...new Set(indexLines)].join('\n')}\n\`\`\`\n`
    : ''

  const out = [...parts.map((p) => p.text), body.trimEnd(), indexBlock].filter(Boolean).join('\n\n---\n\n') + '\n'
  const rows = [...parts.map((p) => [p.rel + (p.anchor ? '#' + p.anchor : ''), Buffer.byteLength(p.text)]), [rel + '（正文）', Buffer.byteLength(body)]]
  if (indexBlock) rows.push(['（没带的索引）', Buffer.byteLength(indexBlock)])
  const total = Buffer.byteLength(out)
  if (flags.has('--list')) {
    for (const [name, size] of rows) console.log(`${String(size).padStart(7)}  ${name}`)
    console.log(`${String(total).padStart(7)}  合计${job ? `（--活 ${job}）` : byJob ? '（整份装；这个角色分了档：' + jobs.join('、') + '）' : ''}`)
    return
  }
  const outIdx = argv.indexOf('--写')
  if (outIdx >= 0) {
    const dest = argv[outIdx + 1]
    if (!dest || dest.startsWith('--')) die('--写 后面要一个文件路径')
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true })
    fs.writeFileSync(path.resolve(dest), out, 'utf8')
    console.log(`${who}${job ? ' · ' + job : ''} 的派工书写到 ${dest}：${out.length} 字、${total} 字节、${rows.length} 份。派工提示里给这个路径，让角色一次 Read 读完，别让它自己跑 brief.js。`)
    return
  }
  process.stdout.write(out)
  if (flags.has('--size')) console.error(`[brief] ${who}${job ? ' · ' + job : ''} 合计 ${total} 字节（${rows.length} 份）`)
}

main(process.argv.slice(2))
