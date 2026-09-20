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
 *         - model/shapes.md#领域对象      ← 井号后面是小节标题的关键字，只带那一节（连它的子节）
 *         - common/wording.md#-规则句,-一事一处  ← 减号开头是排除：除这几节（连子节）外都带
 *         - 正文#-方法怎么写,-追溯        ← 「正文」指角色自己那一份，也按档裁（第一百八十二批）
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
  const { body, carried } = cutText(text, anchor, rel)
  return { rel, file, anchor, carried, text: `> 摘自 ${rel}${anchor.startsWith('-') ? `（这一趟用不上的 ${anchor.split(',').length} 节没带；见末尾索引）` : '（整份还有别的小节，见末尾索引）'}\n\n${body}` }
}

/**
 * 按小节剪一份 Markdown：`甲` 只取那一节（连它的子节），`-甲,-乙` 是除这几节（连子节）以外的全部。
 * 剪裁按**行**来。一节的 text 里本来就含着它的子节（sections 取到下一个同级或更高级标题为止），
 * 排除式从前是「按标题挑出留下的小节、再把它们的正文接起来」，两头都错——被排除那一节的子节标题
 * 对不上排除词，于是又单独印了一遍；留下那一节的子节则跟着母节印一遍、自己再印一遍，整整两份
 * （第一百八十二批量出来：validation.md 的「覆盖」「命名」「模型内部一致性」三节都是两份）。
 */
function cutText(text, anchor, rel) {
  const all = sections(text)
  const covered = (from, to) => new Set(all.filter((s) => s.i >= from && s.i < to).map((s) => s.title))
  if (anchor.startsWith('-')) {
    const drop = anchor.split(',').map((x) => x.trim().replace(/^-/, '')).filter(Boolean)
    for (const d of drop) if (!all.some((s) => s.title.includes(d))) die(`${rel} 里没有标题含「${d}」的小节（写在 # 后面的排除清单里）`)
    const lines = text.split('\n')
    const cut = new Set()
    for (const s of all) if (drop.some((d) => s.title.includes(d))) for (let i = s.i; i < s.end; i++) cut.add(i)
    return {
      body: lines.filter((_, i) => !cut.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(),
      carried: new Set(all.filter((s) => !cut.has(s.i)).map((s) => s.title)),
    }
  }
  const hit = all.find((s) => s.title.includes(anchor))
  if (!hit) die(`${rel} 里没有标题含「${anchor}」的小节`)
  return { body: hit.text, carried: covered(hit.i, hit.end) }
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

  // 角色自己那份正文也按档裁（第一百八十二批）：`正文#-方法` 这样写在某一档里，那一趟就不带「方法」那一节。
  // 量出来的：小活里正文是最大的一块（模型师 19.8K、讲解 12.5K），比几张卡片加起来还大。
  const 自己 = refs.filter((r) => r.startsWith('正文#'))
  refs = refs.filter((r) => !r.startsWith('正文#'))
  let bodyText = body.trimEnd(), bodyCarried = null
  if (自己.length) {
    const cut = cutText(body, 自己[0].slice('正文#'.length), rel)
    bodyText = `> ${rel} 的正文，这一趟只带用得上的几节（其余见末尾索引）\n\n${cut.body}`
    bodyCarried = cut.carried
  }

  const parts = refs.map(pickPart)
  // 没带的：这个角色别的档点过、这一趟一页没带的文件，以及带了某几节的文件里剩下的那些节。
  // 一份文件带了哪几节，由 pickPart 的 carried 说了算（排除式带的是「除这几节以外的全部」，
  // 从前拿排除串当小节名去比，一节也对不上，已经带在手上的那些反倒全被列成「没带」）。
  const indexLines = []
  if (byJob) {
    const took = new Map() // 文件 → 带到的小节标题；整份带的记 'whole'
    for (const p of parts) {
      if (!p.anchor) { took.set(p.rel, 'whole'); continue }
      if (took.get(p.rel) === 'whole') continue
      took.set(p.rel, new Set([...(took.get(p.rel) ?? []), ...p.carried]))
    }
    const add = (line) => { if (!indexLines.includes(line)) indexLines.push(line) }
    for (const ref of [...new Set(Object.values(reads).flat())]) {
      const r = ref.split('#')[0]
      if (!took.has(r)) add(`  ${r}（整份）`)
    }
    if (bodyCarried) for (const sec of sections(body)) if (!bodyCarried.has(sec.title)) add(`  ${rel}#${sec.title}　（你自己那份里的）`)
    for (const [r, t] of took) {
      if (t === 'whole') continue
      for (const s of sections(fs.readFileSync(path.join(AGENTS, r), 'utf8'))) if (!t.has(s.title)) add(`  ${r}#${s.title}`)
    }
  }
  const indexBlock = indexLines.length
    ? `## 这趟没带的（用到再取，别猜）\n\n一条命令可以连着取几节，中间用 \`+\` 隔开：\n\n\`\`\`\nnode $DEV_TEAM/tools/look.js <项目> doc <文件> <标题关键字> + doc <文件> <标题关键字>\n\`\`\`\n\n没带的是这些：\n\n\`\`\`\n${[...new Set(indexLines)].join('\n')}\n\`\`\`\n`
    : ''

  const out = [...parts.map((p) => p.text), bodyText, indexBlock].filter(Boolean).join('\n\n---\n\n') + '\n'
  const rows = [...parts.map((p) => [p.rel + (p.anchor ? '#' + p.anchor : ''), Buffer.byteLength(p.text)]), [rel + (bodyCarried ? '（正文，按档裁过）' : '（正文）'), Buffer.byteLength(bodyText)]]
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
