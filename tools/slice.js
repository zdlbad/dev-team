#!/usr/bin/env node
/**
 * 切片驱动。依据 seed/slices.md 的四种切片与 SKILL.md「段落切片」的周期。
 *
 * 用法：
 *   node tools/slice.js new <项目目录> <切片id> <标题> [--kind initial|increment] [--codebase <相对路径>] [--story] [--implements s-002,s-003]
 *                       --意图 "<一句话>"：这一段的单一业务意图（故事段落只许一个意图）
 *                       --业务故事 "<名字>"：它属于哪条完整故事链（链允许多意图，段落不允许）
 *                       --重构：只改说法或结构、业务行为一个字不变（改名、挪位置）。不走故事、不走裁定卡、不算编码计划；门禁＝测试照旧全绿＋改名套在改前解码结果上与改后逐字节一致（tools/rename-check.js）
 *                       --implements：实现切片——把这几条已确认模型的故事（建模切片）实现成代码；范围从它们的 walk 推出
 *                       [--modules A,B] [--aggregates A.X,B.Y] [--use-cases X,Y] [--traces G-001,R-001]
 *                       --story：同时建故事骨架 slices/<id>.story.json（故事切片：范围由故事定，见 tools/story.js）
 *                       --based-on <id>：这条故事从上一版滚出来（骨架带上一版的人物与步骤，讲解在其上加）
 *                       --改 --来源 "<谁在哪儿点出的>" --动到 s-001,s-002：修改切片（id 用 m-xxx）——已走通的段落上被点出的一件事；正路是先记候选再 candidate open
 *   node tools/slice.js candidate <项目目录> add "<改什么，一句话>" --来源 "<试原型页 / 审阅页 / 裁定第几批>" [--动到 s-001,s-002] [--备注 "<一句>"]
 *   node tools/slice.js candidate <项目目录> list                列候选：审阅点出的事先记在这里，不当场改（第八十六批）
 *   node tools/slice.js candidate <项目目录> done <序号> "<在哪一批、怎么做掉的>"   做掉了（第一百八十批：从前只记得下「不做」，账本因此长期失真）
 *   node tools/slice.js candidate <项目目录> drop <序号> "<为什么不做>"
 *   node tools/slice.js background <项目目录> <切片id> add <R-xxx> "<为什么本段落不了>" | remove <R-xxx> | list
 *                                                          只作背景只改这一栏（候选 #9：角色整份写回切片会互相冲掉）
 *   node tools/slice.js scene <项目目录> <模块切片id> [--title "…"]   建下一场走查（第一百五十批；上一场没锁死不让建）
 *   node tools/slice.js candidate <项目目录> open <序号> <m-xxx> [--modules …] [--aggregates …] [--use-cases …] [--traces …] [--动到 …]
 *   node tools/slice.js candidate <项目目录> drop <序号> "<为什么不做>"
 *   node tools/slice.js next <项目目录> <切片id>            算出下一步：谁上场、跑什么
 *                       修改切片：（业务语句要改的先改）→ 模型师改 → 文职 → 校验 ① → 人审 → 计划 → 关键逻辑 → 人确认 → 原型改 → 校验 ② → pre-pr（A/B/D/S）→ 人重走动到的段落 → 收口
 *                       段落切片：… → 理解一致 → 业务分析按五问补语句 → 人确认 → 模型 → … → 模型确认 → 编码计划（plan.js）→ 人确认计划
 *                       → 原型按计划写 → plan check → 校验 ② → pre-pr 审查（A/B/D）→ 人看报告 → 人在原型上走故事
 *                       实现切片：接口角色定契约（contract.js）→ 人确认 → 编码计划 → 人确认 → 编码 → plan check → 校验 ② → pre-pr（C/E/F）→ 合并
 *   node tools/slice.js proofread <项目目录> <切片id>          文职总校完了记一笔（stages.model.proofreadAt）；段落切片里文职只跑这一趟（第八十九批）
 *   node tools/slice.js advance <项目目录> <切片id> <business|model|code|validate> <pending|in-progress|done> [说明]
 *                                                            business done 带着没答的问题会被拒；末尾的说明是绕过用的，记进切片日志
 *   node tools/slice.js apply <项目目录> <报告 json> [--slice <切片id>]   把人的裁决写回 decisions[] 与切片 log
 *   node tools/slice.js log <项目目录> <切片id> <model|code|validate|slice> <文字>
 *
 * 退出码：0 正常；2 用法或前置错误。`next` 带 --json 时输出 JSON。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadProject, walkNames } = require('./lib/project')
const { storyState } = require('./story')
const { densityIssues } = require('./lib/wording')
/** 校验报告里给人读的字（判断的 reason、需确认项的文字）编号太密就提醒填的角色重写——不拦、不派文职（agents/common/wording.md「编号是佐证，不是主语」，2026-09-15 项目所有者） */
function wordingReminders(report, who) {
  const out = []
  for (const [i, j] of (report?.judgments ?? []).entries()) for (const w of densityIssues(j.reason)) out.push(`judgments[${i}] reason：${w}`)
  for (const [i, c] of (report?.confirms ?? []).entries()) for (const w of densityIssues(c.text ?? c.ask)) out.push(`confirms[${i}]：${w}`)
  if (out.length) { console.error(`措辞提醒 ${out.length} 条（${who}自己改，不拦）：`); for (const w of out) console.error('  · ' + w) }
}

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const today = new Date().toISOString().slice(0, 10)
/** 一个模块分三遍建（第九十五批）：段落切片的 pass 只许这三个值，按这个先后走；不写＝应用遍（老切片一遍建全） */
// 模块切片的两步（第九十七批）：骨架初稿 → 业务走查长行为。应用是段落切片的事，不算一遍
const PASSES = ['骨架', '行为']

function die(msg) {
  console.error(msg)
  process.exit(2)
}
function opt(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
function list(name) {
  const v = opt(name)
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}
function readJson(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'))
  readAt.set(path.resolve(p), fs.statSync(p).mtimeMs) // 记下读的是哪一版（候选 #9）
  return data
}
// 读过哪几份、读的时候是什么时间戳：整份写回去之前拿它对一次（候选 #9）
const readAt = new Map()
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // 别人在这中间改过就停手：几个角色轮流整份写同一份切片文件，后写的会把先写的整段冲掉，
  // 而两边都以为自己写成功了。停下来让人重跑一次，比悄悄丢掉一段强。
  const seen = readAt.get(path.resolve(p))
  if (seen != null && fs.existsSync(p) && fs.statSync(p).mtimeMs > seen + 1) {
    console.error(`[slice] 停下，没有写：${path.relative(root, p)} 在你读它之后被别人改过（你读的是 ${new Date(seen).toISOString()}，磁盘上是 ${new Date(fs.statSync(p).mtimeMs).toISOString()}）。`)
    console.error('重跑一遍这条命令：它会读到最新那一版，再把你这一步做上去。')
    process.exit(1)
  }
  keepSliceHistory(p)
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
  readAt.set(path.resolve(p), fs.statSync(p).mtimeMs)
}
/** 写之前留一版，最近 30 份滚着放在 slices/.history/（走查文件早就这么做了，切片文件一直没有） */
function keepSliceHistory(p) {
  try {
    if (!fs.existsSync(p) || !/[\\/]slices[\\/]/.test(p)) return
    const dir = path.join(root, 'slices', '.history')
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(p, '.json')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    fs.copyFileSync(p, path.join(dir, `${base}.${stamp}.json`))
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.')).sort()
    for (const f of mine.slice(0, Math.max(0, mine.length - 30))) fs.unlinkSync(path.join(dir, f))
  } catch { /* 留不下备份不拦写入 */ }
}
/** 同项目已有切片里最后记下的代码库；一条都没有就返回 null */
function lastCodebase() {
  const dir = path.join(root, 'slices')
  if (!fs.existsSync(dir)) return null
  const ids = fs.readdirSync(dir).filter((f) => /^[sm]-/.test(f) && f.endsWith('.json') && !f.endsWith('.story.json')).sort()
  for (let i = ids.length - 1; i >= 0; i--) {
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, ids[i]), 'utf8')).codebase; if (c) return c } catch { /* 读不动就往前找 */ }
  }
  return null
}
function slicePath(id) {
  return path.join(root, 'slices', `${id}.json`)
}
function loadSlice(id) {
  const p = slicePath(id)
  if (!fs.existsSync(p)) die(`切片不存在：${path.relative(process.cwd(), p)}`)
  return readJson(p)
}
function appendLog(slice, stage, text) {
  slice.log.push({ ts: today, stage, text })
}
if (!cmd || !root || !fs.existsSync(path.join(root, 'project.json'))) {
  // 用法行漏一个，那个命令对读的人就等于不存在：2026-09-18 开发指挥照这一行断定「没有 slice lit」，
  // 还拿这句话去纠正业务分析两趟，而业务分析两趟都是对的。十个子命令一个不落地列全。
  die('用法：node tools/slice.js <new|candidate|lit|pass|next|pending|proofread|advance|apply|proto-go|log> <项目目录> …（项目目录须含 project.json）\n' +
    '  new       开一条新切片　　　　　candidate 把审阅点出的事开成修改切片\n' +
    '  lit       模块点亮完，把业务编号登记进模块切片　　pass      模块切片推到下一遍（骨架 → 行为）\n' +
    '  next      问这条切片下一步做什么　proofread 校对\n' +
    '  pending   这条切片还有什么要人裁的（五处汇总）；业务这一关的活就是把它清空\n' +
    '  advance   推进某一阶段的状态　　 apply     把走查的裁定卡写进 raw/rulings.md\n' +
    '  proto-go  出原型那道门　　　　　 log       往切片日志里记一笔')
}

// ---------- new ----------
if (cmd === 'new') {
  const id = args[2]
  const title = args[3]
  if (!id || !title) die('用法：slice new <项目目录> <切片id> <标题> [--kind …] [--codebase …] [--modules …] [--aggregates …] [--use-cases …] [--traces …]')
  if (!/^[skm]-[0-9]{3,}$/.test(id)) die('切片 id 形如 s-001（段落 / 实现 / 改说法）、k-001（模块切片）或 m-001（修改切片）')
  if (fs.existsSync(slicePath(id))) die(`切片已存在：${id}`)
  if (opt('--pass')) die('--pass 不再手填（第九十七批）：模块切片建好就在骨架初稿，初稿定了用 slice pass 推到业务走查；段落切片只做应用层，没有遍')
  const implementsArg = opt('--implements')
  // 模块切片（第九十七批）：一个模块的模型一次起草（骨架初稿），再靠业务走查长出行为；只有业务与模型，不写代码
  const kind = args.includes('--改') || id.startsWith('m-') ? 'change' : args.includes('--重构') ? 'refactor' : args.includes('--module') ? 'module' : args.includes('--story') ? 'story' : implementsArg ? 'implementation' : (opt('--kind') ?? (fs.existsSync(path.join(root, 'slices')) && fs.readdirSync(path.join(root, 'slices')).length ? 'increment' : 'initial'))
  if (kind === 'module' && !id.startsWith('k-')) die('模块切片的 id 形如 k-001')
  if (id.startsWith('k-') && kind !== 'module') die('k-xxx 只给模块切片用（--module <Module>）')
  if (kind === 'module' && !opt('--module')) die('模块切片要指明模块：--module <Module>（一个）')
  const slice = {
    id,
    title,
    kind,
    // 同一个项目的切片写的是同一个代码库：沿用上一条切片记的那个，别每次退回默认值——
    // 默认值只在项目第一条切片时才对，后来的切片照抄它就指向了一个不存在的目录（s-003 就这么错过一次）
    codebase: opt('--codebase') ?? lastCodebase() ?? '../' + path.basename(root) + '-code',
    scope: { modules: kind === 'module' ? [opt('--module')] : list('--modules'), aggregates: list('--aggregates'), useCases: list('--use-cases') },
    // 一个故事段落只许有一个业务意图，写不出一句话就是不止一个（seed/slices.md「开发范围怎么切」）
    ...(opt('--意图') ? { intent: opt('--意图') } : {}),
    // 模块切片从骨架初稿起步；初稿定了 slice pass 推到业务走查（第九十七批）
    ...(kind === 'module' ? { pass: '骨架' } : {}),
    ...(opt('--业务故事') ? { businessStory: opt('--业务故事') } : {}),
    traces: list('--traces'),
    stages: {
      // 业务这一关排在最前：范围内的语句立好改好、没有等人答的问题，模型这一关才开工（第一百七十八批）
      business: { status: 'pending', confirmedAt: null, note: null },
      model: { status: 'pending', confirmedAt: null },
      code: { status: 'pending', at: null },
      validate: { status: 'pending', decodedVersion: null, reportAt: null },
    },
    log: [{ ts: today, stage: 'slice', text: `切片建立：${title}` }],
  }
  if (kind === 'change') {
    // 修改切片（第八十六批）：已走通的段落上被点出的一件事。id 用 m-xxx，来源与动到哪几段必填——没有来源就不是修改，是新段落
    if (!id.startsWith('m-')) die('修改切片的 id 形如 m-001（段落切片才用 s-）')
    const origin = opt('--来源')
    if (!origin) die('修改切片要写来源：--来源 "<试原型页 / 审阅页 / 裁定第几批点出的什么>"')
    slice.origin = origin
    slice.touches = list('--动到')
    if (!slice.touches.length) die('修改切片要写动到哪几条切片：--动到 s-001,s-002（段落，收口前人要在原型上重走）或 k-001（模块，模型要重审）')
    slice.log[0].text = `修改切片建立：${title}；来源：${origin}；动到 ${slice.touches.join('、')}`
  } else if (id.startsWith('m-')) die('m-xxx 只给修改切片用')
  if (kind === 'implementation') {
    // 实现切片：范围 = 这些故事走过的聚合与用例；模型已在建模切片里确认，直接进编码
    slice.stories = implementsArg.split(',').map((s) => s.trim()).filter(Boolean)
    const aggs = new Set(slice.scope.aggregates), ucs = new Set(slice.scope.useCases), mods = new Set(slice.scope.modules), tr = new Set(slice.traces)
    let latest = null
    for (const sid of slice.stories) {
      const sp = path.join(root, 'slices', `${sid}.json`), stp = path.join(root, 'slices', `${sid}.story.json`)
      if (!fs.existsSync(sp) || !fs.existsSync(stp)) die(`故事切片不存在：${sid}`)
      const s = readJson(sp), st = readJson(stp)
      if (s.stages.model.status !== 'done') die(`故事 ${sid} 的模型还没确认（${s.stages.model.status}），不能进实现切片`)
      if (!latest || s.stages.model.confirmedAt > latest) latest = s.stages.model.confirmedAt
      for (const t of s.traces) tr.add(t)
      for (const step of st.steps) { const w = step.walk; if (!w || w.kind === 'none') continue; if (w.aggregate) { aggs.add(w.aggregate); mods.add(w.aggregate.split('.')[0]) } for (const n of walkNames(w.name)) if (n.includes('.')) { ucs.add(n); mods.add(n.split('.')[0]) } }
    }
    slice.scope = { modules: [...mods].sort(), aggregates: [...aggs].sort(), useCases: [...ucs].sort() }
    slice.traces = [...tr].sort()
    slice.stages.model = { status: 'done', confirmedAt: latest }
    slice.log.push({ ts: today, stage: 'slice', text: `实现切片：给 ${slice.stories.join('、')} 的原型换上生产外壳（聚合 ${aggs.size}，用例 ${ucs.size}）；模型与领域代码已在故事切片里确认` })
  }
  writeJson(slicePath(id), slice)
  console.log(`已建立切片 ${id}（${kind}）：${path.relative(process.cwd(), slicePath(id))}`)
  if (args.includes('--story') || kind === 'module') {
    // 模块切片的走查一场一条（第一百五十批）：从第一场建起，文件名带场次；段落故事照旧一整条
    const sp = path.join(root, 'slices', kind === 'module' ? `${id}.w1.story.json` : `${id}.story.json`)
    const bi = args.indexOf('--based-on'), basedOn = bi > 0 ? args[bi + 1] : null
    const baseP = basedOn ? path.join(root, 'slices', `${basedOn}.story.json`) : null
    if (basedOn && !fs.existsSync(baseP)) { console.error(`上一版故事不存在：${basedOn}`); process.exit(1) }
    const base = basedOn ? readJson(baseP) : null
    // 模块切片的故事文件装的是业务走查场景（第九十七批）：讲解在走查那一步写，不是故事线
    const story = { slice: kind === 'module' ? `${id}.w1` : id, ...(kind === 'module' ? { scene: 1, premises: [], sealed: null } : {}), title: kind === 'module' ? `${opt('--module')} 业务走查 · 第一场` : title, persona: kind === 'module' ? { name: '（走查里出场的人）', description: '（讲解填：一句话）' } : base ? base.persona : { name: '（人物）', description: '（一句话：谁、分类、入册日）' }, steps: [], traces: [], choices: [], gaps: [], approved: null, log: [] }
    if (base) {
      story.basedOn = basedOn
      const picks = base.gapPicks ?? []
      const chosen = picks.length ? base.gaps[picks[0]] : null
      story.adds = chosen ? chosen.split(/[：:]/)[0] : '（这一版比上一版多了什么，一句话）'
      // 上一版没做的候选跟到这一版（做的那条不再是缺口；人勾了多条的，其余按顺序排前面）
      const rest = picks.slice(1).map((i) => base.gaps[i]).concat(base.gaps.filter((g, i) => !picks.includes(i)))
      story.gaps = rest
      // 上一版的步骤不抄过来：那条路留给原型与校验重走，不该让人再读一遍。
      // 这一版从新增那一段起笔，上一版的结局写成前情提要（讲解按上一版最后几步补全）。
      const last = base.steps[base.steps.length - 1]
      story.previously = { text: `（一段话：上一版「${base.title}」发生了什么、走到哪儿了）`, ...(last?.facts ? { facts: last.facts } : {}) }
      story.steps = []
      story.log.push(`${today} 从 ${basedOn}「${base.title}」滚出${chosen ? '，这一版做：' + chosen.split(/[：:]/)[0] : ''}；上一版的 ${base.steps.length} 步不抄过来、写成前情提要；带过来的候选 ${story.gaps.length} 条`)
    }
    writeJson(sp, story)
    console.log(kind === 'module' ? `已建业务走查的文件：${path.relative(process.cwd(), sp)}（讲解在骨架初稿定了之后写场景；下一步看 slice next）` : `已建故事骨架：${path.relative(process.cwd(), sp)}（${base ? `基于 ${basedOn}，上一版 ${base.steps.length} 步写成前情提要、不重复；` : ''}下一步：讲解写故事）`)
  } else {
    console.log('下一步：人与模型师商定范围后，把 scope 与 traces 填进切片记录，再执行 slice next。')
    if (slice.kind === 'change') console.log(`  先记一道方法块基线（动手改模型之前）：node tools/validate.js ${rel(root)} --slice ${id} --记基线\n  记下这一刻模块里每块方法的指纹，往后审模型页只摆这条切片动过的那几块；不记就整个模块摊给他看。`)
  }
}

// ---------- whole-look：最后一场之后他看过整张、说了定稿（第一百五十六批：模型定稿就可以出原型） ----------
if (cmd === 'whole-look') {
  const sid = args[2]
  if (!root || !sid) die('用法：node tools/slice.js whole-look <项目目录> <模块切片id> [他的话]')
  const sl = loadSlice(sid)
  if (sl.kind !== 'module') die(sid + ' 不是模块切片')
  const open = require('./lib/project').storiesOfSlice(root, sid).filter((s) => s.scene !== null && !s.sealed)
  if (open.length) die('第 ' + open.map((s) => s.scene).join('、') + ' 场还没锁死，先把每一场审完')
  sl.wholeLookAt = today
  sl.stages.model.status = 'done'; sl.stages.model.confirmedAt = today
  appendLog(sl, 'model', '看过整张，模型定稿（可以出原型）：' + (args.slice(3).join(' ') || '项目所有者说定稿'))
  writeJson(slicePath(sid), sl)
  console.log(sid + '：模型定稿（' + today + '），可以出原型')
  process.exit(0)
}

// ---------- scene：模块切片建下一场走查（第一百五十批） ----------
if (cmd === 'scene') {
  const sid = args[2]
  if (!root || !sid) die('用法：node tools/slice.js scene <项目目录> <模块切片id> [--title "<这一场演什么>"]')
  const { storiesOfSlice } = require('./lib/project')
  const all = storiesOfSlice(root, sid).filter((s) => s.scene !== null)
  const open = all.filter((s) => !s.sealed)
  if (open.length) die('第 ' + open.map((s) => s.scene).join('、') + ' 场还没审完锁死（story seal），一场走完再开下一场')
  const n = (all.length ? all[all.length - 1].scene : 0) + 1
  const p = path.join(root, 'slices', sid + '.w' + n + '.story.json')
  const titleIdx = args.indexOf('--title')
  const story = { slice: sid + '.w' + n, scene: n, premises: [], sealed: null, title: titleIdx > 0 ? args[titleIdx + 1] : '第 ' + n + ' 场', persona: { name: '（走查里出场的人）', description: '（讲解填：一句话）' }, steps: [], traces: [], choices: [], gaps: [], approved: null, log: [today + ' 建第 ' + n + ' 场：开演之前先把这一场靠着的前提写进 premises，摆给人确认'] }
  writeJson(p, story)
  // 新的一场从头走：讲解写这一场 → 模型师只建这一场碰到的 → 校验 → 他审（第一百五十六批）
  const sl = loadSlice(sid)
  if (sl.kind === 'module' && sl.stages?.model) { sl.stages.model.status = 'pending'; delete sl.stages.model.proofreadAt; appendLog(sl, 'model', '开第 ' + n + ' 场走查'); writeJson(slicePath(sid), sl) }
  console.log('已建第 ' + n + ' 场走查：' + path.relative(process.cwd(), p) + '（讲解先写 premises 给人确认，再写步骤；步号从 1 编起）')
  process.exit(0)
}

// ---------- candidate：候选修改（第八十六批：审阅点出的事先记下来，不当场改） ----------
const candidatesPath = () => path.join(root, 'slices', '_candidates.json')
function loadCandidates() { return fs.existsSync(candidatesPath()) ? readJson(candidatesPath()) : { items: [] } }
if (cmd === 'candidate') {
  const sub = args[2] ?? 'list'
  const c = loadCandidates()
  const find = (n) => { const x = c.items.find((y) => y.n === Number(n)); if (!x) die(`没有候选 #${n}`); return x }
  if (sub === 'add') {
    const text = args[3]
    if (!text) die('用法：slice candidate <项目目录> add "<改什么，一句话>" --来源 "<谁在哪儿点出的>" [--动到 s-001,s-002] [--备注 "<一句>"]')
    const origin = opt('--来源')
    if (!origin) die('候选要写来源：--来源 "<试原型页 / 审阅页 / 裁定第几批>"')
    const n = c.items.reduce((m, x) => Math.max(m, x.n), 0) + 1
    c.items.push({ n, text, origin, touches: list('--动到'), ts: today, status: 'open', openedAs: null, ...(opt('--备注') ? { note: opt('--备注') } : {}) })
    writeJson(candidatesPath(), c)
    console.log(`候选 #${n} 记下了：${text}（来源：${origin}）。不当场改；当前段落收口后 slice candidate open ${n} m-xxx`)
  } else if (sub === 'list') {
    if (!c.items.length) console.log('没有候选。')
    for (const x of c.items) console.log(`#${x.n} [${x.status === 'open' ? '等着开' : x.status === 'opened' ? '已开成 ' + x.openedAs : '不做'}] ${x.text}　来源：${x.origin}${x.touches?.length ? '　动到 ' + x.touches.join('、') : ''}${x.note ? '　备注：' + x.note : ''}`)
  } else if (sub === 'open') {
    const x = find(args[3])
    const id = args[4]
    if (x.status !== 'open') die(`候选 #${x.n} 已经${x.status === 'opened' ? '开成 ' + x.openedAs : '标成不做'}`)
    if (!/^m-[0-9]{3,}$/.test(id ?? '')) die('用法：slice candidate <项目目录> open <序号> <m-xxx> [--modules …] [--aggregates …] [--use-cases …] [--traces …] [--动到 …]')
    if (fs.existsSync(slicePath(id))) die(`切片已存在：${id}`)
    const touches = list('--动到').length ? list('--动到') : x.touches ?? []
    if (!touches.length) die('要写动到哪几段：--动到 s-001,s-002')
    const slice = {
      id, title: x.text, kind: 'change',
      codebase: opt('--codebase') ?? lastCodebase() ?? '../' + path.basename(root) + '-code',
      scope: { modules: list('--modules'), aggregates: list('--aggregates'), useCases: list('--use-cases') },
      origin: x.origin, touches, candidate: x.n,
      traces: list('--traces'),
      stages: { business: { status: 'pending', confirmedAt: null, note: null }, model: { status: 'pending', confirmedAt: null }, code: { status: 'pending', at: null }, validate: { status: 'pending', decodedVersion: null, reportAt: null } },
      log: [{ ts: today, stage: 'slice', text: `修改切片建立（候选 #${x.n}）：${x.text}；来源：${x.origin}；动到 ${touches.join('、')}` }],
    }
    writeJson(slicePath(id), slice)
    x.status = 'opened'; x.openedAs = id; x.openedAt = today
    writeJson(candidatesPath(), c)
    console.log(`候选 #${x.n} 开成修改切片 ${id}：${path.relative(process.cwd(), slicePath(id))}。下一步：slice next`)
    console.log(`  先记一道方法块基线（动手改模型之前）：node tools/validate.js ${rel(root)} --slice ${id} --记基线\n  记下这一刻模块里每块方法的指纹，往后审模型页只摆这条切片动过的那几块；不记就整个模块摊给他看。`)
  } else if (sub === 'drop') {
    const x = find(args[3])
    const why = args[4]
    if (!why) die('用法：slice candidate <项目目录> drop <序号> "<为什么不做>"')
    x.status = 'dropped'; x.note = why; x.droppedAt = today
    writeJson(candidatesPath(), c)
    console.log(`候选 #${x.n} 标成不做：${why}`)
  } else if (sub === 'done') {
    // 「做掉了」和「不做」是两回事，从前只记得下后者，账本因此长期失真（第一百八十批）
    const x = find(args[3])
    const why = args[4]
    if (!why) die('用法：slice candidate <项目目录> done <序号> "<在哪一批、怎么做掉的>"')
    x.status = 'done'; x.note = why; x.doneAt = today
    writeJson(candidatesPath(), c)
    console.log(`候选 #${x.n} 标成做掉了：${why}`)
  } else die('用法：slice candidate <项目目录> add|list|open|done|drop …')
}

// ---------- next：路由的大脑 ----------
function reportOf(direction, sliceId) {
  const dir = path.join(root, 'reports')
  // 先找本切片自己那份存档；没有再看当前那份，且必须确实是本切片的
  const mine = path.join(dir, `validate-${direction}.${sliceId}.json`)
  if (sliceId && fs.existsSync(mine)) {
    const own = readJson(mine)
    const live = path.join(dir, `validate-${direction}.json`)
    if (fs.existsSync(live)) {
      const cur = readJson(live)
      // 当前那份也是本切片的，就以新的为准（存档是被顶掉时留下的旧副本）
      if (cur.slice === sliceId) return cur
    }
    return own
  }
  const p = path.join(dir, `validate-${direction}.json`)
  if (!fs.existsSync(p)) return null
  const r = readJson(p)
  if (sliceId && r.slice && r.slice !== sliceId) return null
  return r
}
/** 报告的状态：从「机械错误」到「人已审完」逐层看 */
function reportState(r) {
  if (!r) return { state: 'none' }
  // 只有错误挡路：错误必须修，是模型师（或编码）的活。
  // 警告不挡——它的出路是「修掉，或由人驳回并留理由」，角色修不掉、也判它站得住的时候，只有人能放行。
  // 从前警告和错误一起挡，2026-09-16 k-001 只剩 R-103 一条警告、校验角色判它站得住请人驳回，
  // slice next 却一直派模型师去修、工作台待办数是 0，那六十条判断和那条警告谁也不提醒他去审。
  // 现在警告跟判断一起轮到人：驳回就写进 decisions，选「要改」就退回模型师。
  const warnings = r.warnings ?? []
  if (r.errors.length) return { state: 'blocked', errors: r.errors.length, warnings: warnings.length }
  const unjudged = r.judgments.filter((j) => !j.verdict).length
  if (unjudged) return { state: 'unjudged', unjudged }
  const unreviewed = require('./lib/project').humanTodo(r).length
  if (unreviewed) return { state: 'unreviewed', unreviewed }
  const rework = [...r.judgments.filter(needsWork), ...r.confirms.filter(needsWork), ...warnings.filter((w) => w.human?.verdict && w.human.verdict !== 'dismissed'), ...(r.blocks ?? []).filter((b) => b.human?.verdict === 'fix')]
  if (rework.length) return { state: 'rework', rework: rework.length, applied: !!r.applied }
  return { state: 'clean', applied: !!r.applied }
}
/** 判断的最终结论：人同意 → 取校验角色的结论；人不同意 → 反过来；人直接填 pass / fail → 以人为准 */
function effectiveVerdict(j) {
  const h = j.human?.verdict
  if (h === 'agree') return j.verdict
  if (h === 'disagree') return j.verdict === 'pass' ? 'fail' : 'pass'
  return h
}
/** 一条裁决过的条目是否意味着「要改东西」 */
function needsWork(it) {
  const h = it.human?.verdict
  if (!h) return false
  // pre-pr 的发现（角度 A–F、S）：「说明」（low）人同意只是认可这个观察，不是要改——风格与说明永不挡合并（pre-pr-reviewer.md 严重度表）；
  // 必须改（high）与应该改（medium）人同意才回流。2026-09-14 s-002 十条说明全被当成回流、slice next 让原型改，口径错了
  if ('sides' in it && /^[A-Z] /.test(String(it.check ?? '')) && it.importance === 'low') return false
  if ('sides' in it) return effectiveVerdict(it) === 'fail'
  // 需人确认：选项 1–3 是要改；4 / accepted / dismissed 是维持现状
  return /^[123]$/.test(String(h))
}
function computeNext(slice) {
  const st = slice.stages
  // 初次建模时模块与聚合尚不存在，范围只能用业务语句编号（traces）表达；
  // 增量切片则要求指明动到哪些模块 / 聚合 / 用例。
  const scopeNamed = slice.scope.modules.length || slice.scope.aggregates.length || slice.scope.useCases.length
  // 故事切片：范围由故事定（业务理解一致后编号并入 traces），不要求先点名模块 / 聚合
  // 一场一条的走查：眼下是还没锁死的最前一场（第一百五十批）
  const cur = require('./lib/project').currentStory(root, slice.id)
  const storyP = cur ? cur.file : path.join(root, 'slices', `${slice.id}.story.json`)
  const story = cur ? cur.story : null
  // 修改切片（第八十六批）：不走故事、不走卡，只改被点出的那一件事；写码与审查的口径同段落切片（原型角色、A/B/D/S）
  const isChange = slice.kind === 'change'
  // 段落切片的范围由故事定（点亮回填 traces、理解一致后并入切片），不要求先点名模块 / 聚合，也不要求先有 traces——模型现在建在人走故事之前（第八十九批）
  const scopeEmpty = story ? false : slice.kind === 'initial' ? !scopeNamed && !slice.traces.length : !scopeNamed
  const codebase = path.resolve(root, slice.codebase)
  const rel = (p) => path.relative(process.cwd(), p) || '.'
  /**
   * 业务这一关的门（第一百七十八批，项目所有者：「调用顺序本身是业务 → 模型，但如果没有业务的
   * 确定，上游有待定的事项，模型师本不应开工」）。从前模型这一关的条件是「范围已定」，模型师
   * 任何时候都派得出去——2026-09-20 m-004 的业务活就是在没有关、没有门的情况下做的，他的答复
   * 一到，已经判过的三条判断全部重浮重填。三个「模型师开工」的入口都要过这道门。
   */
  const businessGate = () => {
    if ((st.business?.status ?? 'done') === 'done') return null
    const open = openQuestions(slice.id)
    if (open.length) return step('人', `业务这一关卡在 ${open.length} 件等你答：\n${open.map((q) => `    ${q.id}　${q.question}`).join('\n')}`, `node tools/scene.js ${rel(root)} answer <问题号> "<你怎么答的>"`, '上游有待定的事项，模型师不开工（第一百七十八批）')
    return step('开发指挥', '业务这一关收口：跑一趟 slice pending 看还有什么要人裁的、确认范围内的语句都立好改好了，再按下面这条', `node tools/slice.js advance ${rel(root)} ${slice.id} business done`, '调用顺序是业务 → 模型；业务定了模型才开工（第一百七十八批）')
  }
  const validateCmd = (withCode) => `node tools/validate.js ${rel(root)}${withCode ? ` --code ${rel(codebase)}` : ''} --slice ${slice.id}`
  const step = (role, action, command, why) => ({ slice: slice.id, role, action, command: command ?? null, why })
  // 按裁定归档的切片只是记录，不再派活（看板也这么认）
  if (slice.archived) return step('—', '已归档：' + slice.archived.reason, null, '这条切片按裁定归档，不再推进')

  // 阶段一：模型。业务描述是模型的上游：没有它就无从定范围
  // 只改说法或结构的那一类不动模型，模型这一关对它不适用
  if (st.model.status !== 'done' && slice.kind !== 'refactor') {
    const { business, glossary } = loadProject(root)
    const inScope = slice.traces.length ? business.filter((s) => slice.traces.includes(s.id)) : business
    if (!business.length && !fs.existsSync(path.join(root, 'business', '00-overview.md'))) return step('业务分析', '粗读 raw/：写全景（business/00-overview.md）、模块候选、词汇表种子；不写编号语句，语句按段落点亮', null, '本项目还没粗读过')
    if (!glossary.terms.length) return step('业务分析', '补词汇表：业务描述里的名词逐个收录', null, '模型只能使用词汇表的法定名')
    if (slice.traces.length && !inScope.length) return step('业务分析', `切片追溯的编号在业务描述里不存在：${slice.traces.join('、')}`, null, '切片的 traces 必须指向已有的业务语句')
    // 模块切片（第九十七批）：骨架初稿（按模块一次起草，允许不准）→ 业务走查长出聚合行为。只有业务与模型，不写代码
    if (slice.kind === 'module') {
      const mod = slice.scope.modules[0]
      const modsP = path.join(root, 'model', 'modules.json')
      const mods = fs.existsSync(modsP) ? readJson(modsP) : null
      if (!mod) return step('开发指挥', '模块切片要指明模块（scope.modules 一个）', null, '模块切片的范围就是一个模块')
      // 业务分析之后仍要模型师战略设计——划上下文、划模块，最粗的一道结构（他 2026-09-15 夜里补的）
      if (!mods || !(mods.modules ?? []).some((m) => m.name === mod)) return step('模型师', `战略设计：和项目所有者一起按语言边界与流程边界划上下文与模块，写 model/modules.json（每个模块一句职责 + traces）和各模块 module.json 的粗版聚合清单；${mod} 要在里面。这是最粗的一道结构，人单独确认`, null, '业务分析之后先有最粗的结构，再起草骨架（第九十七批）')
      const passNow = slice.pass ?? '骨架'
      const r1 = reportOf(1, slice.id), s1 = reportState(r1)
      const needV1 = s1.state === 'none' || (r1?.slice && r1.slice !== slice.id)
      if (passNow === '骨架') {
        if (!st.model.litAt) return step('业务分析', `模块点亮：把 ${mod} 在原料里提到的概念性语句一轮点亮——事实（记着什么）、能力（谁能做到什么）、顺带约束；写成正向陈述句、分层、标 (层-种类)、发编号。不等故事，这一轮给骨架初稿当底子。交回时列出编号，开发指挥用 slice lit 登记`, `node tools/slice.js lit ${rel(root)} ${slice.id} <R-xxx,G-xxx,…>`, '骨架照点亮的语句起草，元素才有编号可追（他选甲，第九十七批）')
        if (st.model.status === 'pending') { const g = businessGate(); if (g) return g }
    if (st.model.status === 'pending') return step('模型师', `薄骨架（第一百五十六批）：在 model/${mod}/module.json 列出 ${mod} 有哪几个聚合，每个聚合根文件只写一句 aggregateNarrative 说它管什么；**不写字段**、不建守卫、不变量、行为、error、领域服务，不填 walk。允许不准，后面的场推翻它不算错。交稿前按 agents/common/wording.md 自检措辞`, `node tools/slice.js advance ${rel(root)} ${slice.id} model in-progress`, '骨架初稿按模块一次起草，形状先铺开（第九十七批）')
        if (!st.model.proofreadAt) return step('文职', `总校一趟：${mod} 这一轮点亮的语句与初稿里给人读的文字，只改字不改意；改完跑 validate --重新定基 接回裁决，再标记`, `node tools/slice.js proofread ${rel(root)} ${slice.id}`, '文职一趟，排在人看之前（第八十九批）')
        if (needV1) return step('开发指挥', '跑校验 ①（机械检查；骨架只查事实的落点，其余留给走查）', validateCmd(false), '初稿也要过机械检查')
        if (s1.state === 'blocked') return step('模型师', `修正初稿：方向 ① 有 ${s1.errors} 个错误（警告不挡：修得掉就顺手修，修不掉的留给人驳回）`, validateCmd(false), '机械检查未过，先改再重跑')
        return step('人', `看 ${mod} 的薄骨架：工作台「模型图」页看有哪几个聚合、各管什么（一句话），哪个该拆该合当场说。看完说「就按这个走」，开发指挥在「切片」页按「初稿定了」（或跑右边的命令）；字段、行为都等走查一场一场长出来`, `node tools/slice.js advance ${rel(root)} ${slice.id} model done 初稿定了`, '初稿由他定、允许不准，不派校验角色逐条判（第九十七批）')
      }
      // 业务走查：讲解出场景，模型师拿初稿走、长出行为，他在场
      const storyRelM = rel(storyP)
      if ((!story || !story.steps.length) && story?.scene) return step('讲解', `写 ${mod} 业务走查的第 ${story.scene} 场到 ${storyRelM}：先把这一场靠着的前提写进 premises（编号 + 一句人话），摆给人确认了再写步骤；一场 5–30 步、步号从 1 编起、按日期排，每步 text 带金额与事实，traces 填已点亮的编号；跨场引用说事情不说步号（第一百五十批）。不是故事线、不出题；走不通的写 gaps`, null, '走查一场一条（第一百五十批）')
      if (!story || !story.steps.length) return step('讲解', `写 ${mod} 的业务走查场景到 ${storyRelM}：几个场景，每个场景一串按日期排的步骤，合起来把这个模块每个概念的建立、改动、查看、结束都走到；每步 text 带金额与事实，traces 填已点亮的编号，needs 可空。不是故事线、不点亮段落、不出题；走不通的写 gaps`, null, '走查场景是长出聚合行为的抓手（第九十七批）')
      const ssM = storyState(story, { quizRequired: false })
      if (ssM.state === 'challenged') return step('路由', `核对人对走查的 ${ssM.count} 处质疑：对照语句、裁定与手册逐条回应；人对了就落成裁定并派讲解或模型师改`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人质疑了走查的业务内容，先解决再往下')
      if (ssM.state === 'notes') return step('路由', `读人在走查上留下的 ${ssM.count} 条想法：逐条回应；成立的落成裁定或派给业务分析、讲解、模型师`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人的想法要有人看、有人回')
      if (st.model.status === 'pending') { const g = businessGate(); if (g) return g }
    if (st.model.status === 'pending') return step('模型师', `${story?.scene ? '走第 ' + story.scene + ' 场' : '走'}（${storyRelM}）：**只建或改这一场碰到的**字段、创建、方法、不变量、领域服务、error，后面的场才用到的一律不建；方法、创建、领域服务操作照 agents/model/modeler.md「方法怎么写」写七段（作用、入参、做法每步改哪几栏、规则、错误、事件、返回）；**前面的场建过的只改非改不可的**，顺手改措辞会让那一块白白重浮，交回时报「本想顺手改、忍住了」的几处。每步填 walk（调哪个方法、改了什么）；建立、搜索这类不是聚合行为，walk 标 leftTo: 应用。本场落不了的语句用 slice background add 登记，别整份改写切片文件。不建 event、命令、查询、端口（第一百五十六批）`, `node tools/slice.js advance ${rel(root)} ${slice.id} model in-progress`, '行为从走查里长出来，过程中精进聚合（第九十七批）')
      if (ssM.state === 'no-walk') return step('模型师', `走查还有 ${ssM.count} 步没填 walk：动了哪个聚合、变了什么；不是聚合行为的标 leftTo: 应用`, storyRelM, '每一步都要走到')
      if (!st.model.proofreadAt) return step('文职', `总校一趟：走查场景与这一轮新建、改动的模型元素给人读的文字，只改字不改意；改完跑 validate --重新定基 接回裁决，再标记`, `node tools/slice.js proofread ${rel(root)} ${slice.id}`, '文职一趟，排在校验角色填判断之前（第八十九批）')
      if (needV1) return step('开发指挥', '跑校验 ①（机械检查 + 生成判断清单；这一步查事实、约束、公式、情形的落点）', validateCmd(false), '还没有本切片这一步的方向 ① 报告')
      if (s1.state === 'blocked') return step('模型师', `修正模型：方向 ① 有 ${s1.errors} 个错误（警告不挡：修得掉就顺手修，修不掉的留给人驳回）`, validateCmd(false), '机械检查未过，先改再重跑')
      if (['unapproved', 'usage-proposed', 'awaiting-human'].includes(ssM.state)) return step('人', `在「走故事」页走一遍 ${mod} 的业务走查：逐步同意或质疑（聚合这么分对不对、行为这么长对不对）；裁 ${story.choices.filter((c) => !c.ruling).length} 张卡`, `node tools/story.js serve ${rel(root)} ${slice.id}`, '走查是他在场的：模拟业务，看聚合行为长得对不对（第九十七批）')
      if (ssM.state === 'unapplied') return step('路由', `把 ${ssM.count} 张裁定卡写回裁定文件与切片 log`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '裁定已填但未写回')
      if (ssM.state === 'rework') return step('模型师', `按回流改模型（裁定 ${ssM.rework} 项、走不通 ${ssM.gaps} 处）；改完更新 choices 的 current、清掉 gap，重跑校验 ①`, validateCmd(false), '人的裁定与模型现状不同，或走查走不通')
      if (s1.state === 'unjudged') return step('模型校验', `填写 ${s1.unjudged} 条判断（verdict / confidence / reason）`, `reports/validate-1.json`, '判断清单待校验角色逐条判断')
      if (s1.state === 'unreviewed') { wordingReminders(r1, '模型校验'); return step('人', `在「审模型」页审这一场：按模型看——新的与重浮的方法块点「写得对 / 要改」；按业务看——只裁推上来的判断；警告驳回要写理由，不驳回就退回模型师。一共 ${s1.unreviewed} 项`, `node tools/review.js ${rel(path.join(root, 'reports', 'validate-1.json'))}`, '人过目后模型即确认（第八十九批）') }
      if (!s1.applied) return step('路由', '把裁决写回 decisions[] 与切片 log', `node tools/slice.js apply ${rel(root)} ${rel(path.join(root, 'reports', 'validate-1.json'))} --slice ${slice.id}`, '裁决已填但未写回')
      if (s1.state === 'rework') return step('模型师', `按回流清单修改模型（${s1.rework} 项），改完重跑校验 ①`, validateCmd(false), '人的裁决里有要改的项')
      // 一场一条（第一百五十、一百五十六批）：这一场的模型审完了——先把这一场锁死，再开下一场；都走完了看一次整张，定稿
      if (story?.scene && !story.sealed) return step('开发指挥', `第 ${story.scene} 场的走查与模型都审完了：锁死这一场，往后不再动它`, `node tools/story.js seal ${rel(root)} ${slice.id}.w${story.scene}`, '审完一场锁一场（第一百五十批）')
      if (story?.scene && story.sealed && !slice.wholeLookAt) return step('人', `${mod} 已经走完 ${story.scene} 场。还有没走到的场景，开发指挥开下一场（右边的命令）；都走完了，就在「审模型」页「按模型看」的总览里点走查的每一步，看支撑它的聚合、方法、字段亮没亮——看完说「定稿」，模型就定了，可以出原型`, `node tools/slice.js scene ${rel(root)} ${slice.id}　或　node tools/slice.js whole-look ${rel(root)} ${slice.id} <他的话>`, '最后看一次整张（第一百五十六批）')
      return step('路由', `${mod} 的模型确认：走查过完、方向 ① 干净、人审完，标 done`, `node tools/slice.js advance ${rel(root)} ${slice.id} model done`, '方向 ① 干净且人已审完')
    }
    // 故事切片（第八十九批，2026-09-14 项目所有者选甲：「来回太多」——s-002 那一段派了 14 趟角色、人坐了 9 次）：
    // 角色的活先全做完：讲解写故事 → 业务分析点亮（一趟）→ 模型师建最少模型、填 walk、列 choices → 文职总校（一趟）
    // → 校验 ① 机械检查（开发指挥自己跑）→ 讲解出题；然后人在「走故事」页一坐做完：理解一致、预测、过卡。
    // 回流模型师改 → 校验角色填判断 → 人审模型；审完干净直接算模型确认，不再单点一次。
    // 第九十六批：五问不再是每段必过的一步——它只是认出「情形」这一种语句的判据；登记了 usage 才要人确认。
    const ss = story ? storyState(story) : null
    const storyRel = rel(storyP)
    if (ss?.state === 'no-steps') return step('讲解', story.basedOn ? `从上一版 ${story.basedOn} 起笔写故事到 ${storyRel}：老步骤照抄不改，插进这一版新增的那段，重新编号；填 adds；整条要从头走到尾` : `写本段故事到 ${storyRel}：一个人物、逐步的日期与金额；每步标 needs（需要哪条业务，人话），traces 留空等业务分析点亮`, null, '段落的范围由故事决定；故事写在语句之前')
    if (ss?.state === 'adds-missing') return step('讲解', `故事 ${storyRel} 基于 ${story.basedOn} 但 adds 还是占位：一句话写清这一版多了什么`, null, '谱系要能一眼看出每版加了什么')
    if (story) {
      const dark = story.steps.filter((s) => (s.needs ?? []).length && !(s.traces ?? []).length).length
      if (dark) return step('业务分析', `点亮：按故事 ${storyRel} 每步的 needs 回 raw，写成正向陈述句、分层进 abstraction.md / practice.md、标 (层-种类)、发编号、回填每步 traces（还有 ${dark} 步没点亮）。碰到「可能同时、可能重来、成批来、半路没成、谁看得见」这类话，种类标「情形」、只写情况不写软件怎么回应（第九十六批）。交稿前按第八十四批自检措辞——文职不再单独校这一批`, null, '点亮一趟做完，人只坐一次（第八十九批）')
      if (ss.state === 'challenged') return step('路由', `核对人对故事的 ${ss.count} 处质疑：对照语句、裁定与手册逐条回应；人对了就落成裁定并派业务分析或讲解改，人误会了就解释；改完让人重看`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人质疑了故事的业务内容，先解决再认可')
      if (ss.state === 'notes') return step('路由', `读人在故事上留下的 ${ss.count} 条想法（同意但有话说的也算）：逐条回应；成立的落成裁定或派给业务分析、讲解、模型师`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人的想法要有人看、有人回')
    }
    if (scopeEmpty) return step('人 + 模型师', '定范围：填切片记录的 scope 与 traces', null, '切片首先是对模型改动范围的定稿')
    // 人在模型图上留的意见：先有人看、有人回，再往下走
    const mnP = path.join(root, 'reports', '_model-notes.json')
    const mnOpen = fs.existsSync(mnP) ? Object.entries(readJson(mnP)).flatMap(([f, ns]) => ns.filter((n) => !n.handled).map((n) => ({ f, ...n }))) : []
    if (mnOpen.length) return step('路由', `读人对模型的 ${mnOpen.length} 条意见（reports/_model-notes.json）：逐条回应；要改的派模型师，改完把 handled 置真`, null, '人在模型图上留了意见，先回应再推进')
    if (st.model.status === 'pending') { const g = businessGate(); if (g) return g }
    if (st.model.status === 'pending') return step('模型师', story ? (story.basedOn ? `只建这一版新增那段所需的最少模型（上一版 ${story.basedOn} 的模型已在）；给每一步填 walk——老步骤也要重走，保证老路没被新东西弄断；做过的选择列进 choices。人还没走故事，他走时质疑或裁定不同再回流；交稿前按 agents/common/wording.md 自检措辞` : '按故事建走通它所需的最少模型；写完给每一步填 walk，把做过的选择列进 choices（每条带 current 与 recommended）。人还没走故事，他走时质疑或裁定不同再回流；交稿前按 agents/common/wording.md 自检措辞') : '在范围内建模 / 改模', `node tools/slice.js advance ${rel(root)} ${slice.id} model in-progress`, story ? '模型建在人走故事之前，人一坐看全（第八十九批）' : '范围已定，模型阶段尚未开始')
    if (ss?.state === 'no-walk') return step('模型师', `走故事：给 ${ss.count} 步填 walk（命令 / 事件 / 查询、动了哪个聚合、变了什么；走不通的填 gap），把做过的选择列进 choices（每条带 current 与 recommended）`, storyRel, '模型建好后先在故事上走一遍')
    // 文职只跑一趟：人审之前，是最后一个动文字的人；校完把裁决按对照接回，再 slice proofread 记一笔
    if (story && !st.model.proofreadAt) return step('文职', `总校一趟：本段新点亮的语句（切片与故事 traces 里的编号）与本段新建、改动的模型元素给人读的文字，只改字不改意（第八十四批）。改完把改前改后写成整句对照、跑 validate --重新定基 接回裁决，再标记`, `node tools/slice.js proofread ${rel(root)} ${slice.id}`, '文职一趟，排在校验角色填判断之前（第八十九批）')
    const r1 = reportOf(1, slice.id)
    const s1 = reportState(r1)
    // in-progress：看方向 ① 报告走到哪。机械检查开发指挥自己跑，校验角色只填判断
    if (s1.state === 'none' || (r1.slice && r1.slice !== slice.id)) return step('开发指挥', '跑校验 ①（机械检查 + 生成判断清单）', validateCmd(false), '模型阶段进行中，还没有本切片的方向 ① 报告；机械检查不用派人（第八十九批）')
    if (s1.state === 'blocked') return step('模型师', `修正模型：方向 ① 有 ${s1.errors} 个错误（警告不挡：修得掉就顺手修，修不掉的留给人驳回）`, validateCmd(false), '机械检查未过，先改再重跑')
    if (ss?.state === 'no-quiz' || (story && !story.steps.some((s) => s.quiz))) return step('讲解', `出题：给关键步骤加 quiz（预测再揭晓：数字或选择，不要作文），检查 choices 的措辞与金额例子`, storyRel, '人走故事前要有题')
    // 人一坐：理解一致、确认五问语句、预测、过卡，都在走故事页
    if (ss && ['unapproved', 'usage-proposed', 'awaiting-human'].includes(ss.state)) {
      const nUsage = ss.state === 'usage-proposed' ? (story.usage?.proposed ?? []).length : 0
      const nQuiz = story.steps.filter((s) => s.quiz && !s.human).length
      const nChoice = story.choices.filter((c) => !c.ruling).length
      const items = [`逐步读故事「${story.title}」、逐条确认语句、同意或质疑每一步（理解一致）`, ss.state === 'usage-proposed' ? `确认业务分析登记的 ${nUsage} 条情形语句（页面上确认；页面没有这一栏就口头说一声，开发指挥跑 story usage confirm）` : null, `预测 ${nQuiz} 题`, `裁 ${nChoice} 张卡`].filter(Boolean)
      return step('人', `在「走故事」页一坐做完：${items.map((t, i) => `${'①②③④'[i]} ${t}`).join('；')}`, `node tools/story.js serve ${rel(root)} ${slice.id}`, '角色的活都做完了，人只坐一次（第八十九批）')
    }
    if (ss?.state === 'unapplied') return step('路由', `把 ${ss.count} 张裁定卡写回裁定文件与切片 log`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '裁定已填但未写回')
    if (ss?.state === 'rework') return step('模型师', `按回流改模型（裁定 ${ss.rework} 项、走不通 ${ss.gaps} 处）；改完更新 choices 的 current、清掉 gap，重跑校验 ①；改了文字自己按第八十四批自检`, validateCmd(false), '人的裁定与模型现状不同，或故事走不通')
    if (s1.state === 'unjudged') return step('模型校验', `填写 ${s1.unjudged} 条判断（verdict / confidence / reason）`, `reports/validate-1.json`, '判断清单待校验角色逐条判断')
    if (s1.state === 'unreviewed') wordingReminders(r1, '模型校验')
    if (s1.state === 'unreviewed') return step('人', `在「审模型」页审阅 ${s1.unreviewed} 条判断 / 需确认项 / 警告（警告驳回要写理由，不驳回就退回模型师）；审完干净就算模型确认，不用再点一次`, `node tools/review.js ${rel(path.join(root, 'reports', 'validate-1.json'))}`, '人过目后模型即确认（第八十九批）')
    if (!s1.applied) return step('路由', '把裁决写回 decisions[] 与切片 log', `node tools/slice.js apply ${rel(root)} ${rel(path.join(root, 'reports', 'validate-1.json'))} --slice ${slice.id}`, '裁决已填但未写回')
    if (s1.state === 'rework') return step('模型师', `按回流清单修改模型（${s1.rework} 项），改完重跑校验 ①`, validateCmd(false), '人的裁决里有要改的项')
    return step('路由', '模型确认：审模型页过完、干净，直接标 done（触及模块划分或聚合清单的变动仍要人单独说一声）', `node tools/slice.js advance ${rel(root)} ${slice.id} model done`, '方向 ① 干净且人已审完；第八十九批：不再让人单点一次')
  }
  // 阶段二之前：编码计划。从模型算出这次要动哪些文件、按什么顺序；角色补关键逻辑；人确认；写的时候按顺序登记；写完核对。
  // 只改说法或结构的切片：没有业务意图，所以不走故事、不走裁定卡、也不算编码计划。
  // 它要证明的只有一件事：行为一个字没变——代码跟模型 0 差异，测试照旧全绿。
  if (slice.kind === 'refactor') {
    if (st.code.status !== 'done') {
      if (st.code.status === 'pending') return step('编码', '按这条切片的范围把代码里的说法改齐：一个字的业务行为都不许变，测试的断言值一个都不许改。改完先跑测试，再把代码解回来跟模型比', `node tools/slice.js advance ${rel(root)} ${slice.id} code in-progress`, '只改说法，不改行为')
      return step('人', '代码改齐、测试全绿（门禁）', `node tools/slice.js advance ${rel(root)} ${slice.id} code done`, '改完才比对')
    }
    if (st.validate.status !== 'done') return step('模型校验', '证明只有说法变了：改前的解码结果在 model-decoded/<改前版本>/（上一次校验 ② 留下的；没有就先 git 切回改前跑一次 validate --code），改后再跑一次 validate --code 得到新版本；然后把改名对照套在改前那份上与改后逐字节比，必须一字不差。不要求跟模型 0 差异——模型常跑在代码前面，那跟改名无关', `node tools/rename-check.js ${rel(path.join(root, 'model-decoded', '<改前版本>'))} ${rel(path.join(root, 'model-decoded', '<改后版本>'))} <rename-map.json>`, '代码已改齐')
    return step('人', '合并（门禁）', null, '套上改名逐字节比过、一字不差，且测试照旧全绿：行为没变，说法改齐了')
  }
  // 模块切片（第九十七批）：只有业务与模型。骨架初稿定了就推到走查；走查完模块的模型就定了，代码由段落切片在应用层带出来
  if (slice.kind === 'module') {
    if ((slice.pass ?? '骨架') === '骨架') return step('开发指挥', `${slice.id} 的骨架初稿定了：推到业务走查——讲解出场景、模型师拿初稿走、长出聚合行为`, `node tools/slice.js pass ${rel(root)} ${slice.id} 行为`, '骨架初稿允许不准，走查时再改精（第九十七批）')
    return step('—', `${slice.scope.modules.join('、')} 的模型定了（骨架初稿 + 业务走查）。接下来按故事线切段落：slice new <项目> s-xxx <标题> --story --意图 <一句话>，段落只做应用层（命令、查询、端口、walk），模型确认后项目所有者看一遍再出原型`, null, '模块切片不写代码（第九十七批）')
  }
  const isStory = slice.kind === 'story' || !!story
  // 修改切片改的是原型阶段的代码：写码的是原型角色，pre-pr 查 A / B / D / S
  const protoLike = isStory || isChange
  const coderRole = protoLike ? '原型' : '编码'
  const planP = path.join(root, 'plans', `${slice.id}.json`)
  const plan = fs.existsSync(planP) ? readJson(planP) : null
  const planCmd = (sub) => `node tools/plan.js ${sub} ${rel(root)} ${slice.id}${sub === 'build' || sub === 'check' ? ` --code ${rel(codebase)}` : ''}`
  const protoCmd = `node tools/proto.js check ${rel(root)} --code ${rel(codebase)}`
  if (st.code.status !== 'done') {
    // 实现切片：先有契约（接口角色），再有计划
    if (slice.kind === 'implementation') {
      const cc = spawnSync(process.execPath, [path.join(__dirname, 'contract.js'), 'check', root, slice.id, '--json'], { encoding: 'utf8' })
      let c = null
      try { c = JSON.parse(cc.stdout) } catch { c = null }
      if (!c) return step('接口', `定这几条故事的生产契约：范围内每个命令 / 查询一份 HTTP 契约、每个聚合一份表结构、每个模块一份错误 → 状态码，写进 contracts/；字段名沿用模型 input 的名字，类型不确定就问人，没问过标「（没问过）」，人推迟标「（故意推迟）」`, `node tools/contract.js check ${rel(root)} ${slice.id}`, '外壳的接口要先钉死，编码角色才不用猜')
      if (c.missing.length) return step('接口', `补缺的契约：${c.missing.join('、')}`, `node tools/contract.js check ${rel(root)} ${slice.id}`, '范围内每个命令 / 查询 / 聚合都要有契约')
      if (c.unasked.length) return step('接口', `契约里还有 ${c.unasked.length} 处「（没问过）」：整理成表问人，答了填进去，人推迟的标「（故意推迟）」`, `node tools/contract.js check ${rel(root)} ${slice.id}`, '不猜类型')
      if (c.unconfirmed.length) return step('人', `确认 ${c.unconfirmed.length} 份契约（contracts/）：HTTP 字段、表结构、错误 → 状态码——前端和别的系统要对着它写`, `node tools/contract.js confirm ${rel(root)} ${slice.id}`, '这是接口决定，人拍')
    }
    // 出原型是一道门（第九十七批）：段落的模型确认了，先请项目所有者看一遍整个模型，他说「出原型」才算计划、写原型
    if (slice.kind === 'story' && !slice.protoGo && !plan) return step('人', `看一遍整个模型（工作台「模型图」页、「这段改了什么」页），决定这一段要不要现在出原型；要，就在「切片」页按「出原型」`, `node tools/slice.js proto-go ${rel(root)} ${slice.id}`, '模型定了不等于马上写码：他先看，再定出不出原型（第九十七批）')
    if (!plan) return step('路由', '从模型算出编码计划（要动哪些文件、按什么顺序）', planCmd('build'), '编码前先有计划，人能看链路对不对')
    const unfilled = plan.steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length
    if (unfilled) return step(coderRole, `给编码计划 plans/${slice.id}.json 的 ${unfilled} 步补关键逻辑（keyLogic）：这一步守哪条规则、哪条不变量在这里生效、分流怎么走${plan.kind === 'shell' ? '、事务边界在哪、锁怎么落、哪个错误映射哪个状态码' : ''}；只填 keyLogic，不动别的字段`, `plans/${slice.id}.md`, '关键逻辑是人要看的东西，机器算不出来')
    if (!plan.confirmedAt) return step('人', `看编码计划 plans/${slice.id}.md：链路顺序对不对（先建被引用的聚合、再仓储、再用例）、每步的关键逻辑是不是在该在的层（判断在聚合 / 服务，处理器只编排）；对了就确认`, planCmd('confirm'), '计划确认前不开写；编码顺序必须与计划一致')
    if (st.code.status === 'pending') return step(coderRole, isChange ? `按计划顺序只改这一件事：${slice.title}。领域代码、应用层、测试按 03 与 06 改，别的不动；每完成一步 plan done；每层自跑解码比对；最后跑 ${protoCmd}` : isStory ? `按计划顺序写这条故事的领域代码与应用层（按 03 与 06，可解码），内存仓储与直连端口适配器，组合根登记到原型宿主，src/proto/main.ts，领域与用例测试；每完成一步 plan done；每层自跑解码比对；给每一步 walk 填 input；最后跑 ${protoCmd}` : `按计划顺序写（按 03 与 06${slice.kind === 'implementation' ? '，契约见 contracts/；领域层与应用层一行不动，只补外壳' : ''}）；每完成一步 plan done；每层自跑解码比对`, `node tools/slice.js advance ${rel(root)} ${slice.id} code in-progress`, '计划已确认')
    return step(coderRole, `写完：${planCmd('check')} 过${protoLike ? `、${protoCmd} 过` : ''}，就标记完成`, `node tools/slice.js advance ${rel(root)} ${slice.id} code done`, '编码进行中')
  }
  // 编码完成：先核对计划（文件都在、顺序一致），再校验 ②
  if (plan) {
    const pc = spawnSync(process.execPath, [path.join(__dirname, 'plan.js'), 'check', root, slice.id, '--code', codebase, '--json'], { encoding: 'utf8' })
    let pr = null
    try { pr = JSON.parse(pc.stdout) } catch { pr = null }
    if (pr && !pr.ok) return step(coderRole, `计划核对未过（${pr.issues.length} 处）：${pr.issues.slice(0, 3).join('；')}${pr.issues.length > 3 ? '……' : ''}`, planCmd('check'), '编码顺序与文件要和计划一致')
  }
  // 阶段三：校验 ②
  const r2 = reportOf(2, slice.id)
  const s2 = reportState(r2)
  if (!fs.existsSync(codebase)) return step('人', `代码库不存在：${codebase}`, null, '切片记录的 codebase 指向的目录不存在')
  if (s2.state === 'none') return step('模型校验', '跑校验 ②（解码 + lint + 比对）', validateCmd(true), '编码完成，还没有本切片的方向 ② 报告')
  if (s2.state === 'blocked') return step('人', `处理差异：方向 ② 有 ${s2.errors} 个错误——代码错回编码，模型错回模型师`, `reports/validate-2.md`, '差异回流由人判定回到哪一侧')
  if (s2.state === 'unjudged') return step('模型校验', `填写 ${s2.unjudged} 条语义等价判断`, `reports/validate-2.json`, '文字差异待判断')
  if (s2.state === 'unreviewed') wordingReminders(r2, '模型校验')
  if (s2.state === 'unreviewed') return step('人', `审阅 ${s2.unreviewed} 条`, `node tools/review.js ${rel(path.join(root, 'reports', 'validate-2.json'))}`, '人过目')
  if (!s2.applied) return step('路由', '把裁决写回', `node tools/slice.js apply ${rel(root)} ${rel(path.join(root, 'reports', 'validate-2.json'))} --slice ${slice.id}`, '裁决已填但未写回')
  if (s2.state === 'rework') return step('人', `按回流清单决定改模型还是改代码（${s2.rework} 项）`, `reports/validate-2.md`, '语义不等价的项由人定改哪一侧')
  if (st.validate.status !== 'done') return step('路由', '标记校验完成', `node tools/slice.js advance ${rel(root)} ${slice.id} validate done`, '方向 ② 干净且已审完')
  // 校验 ② 之后：pre-pr 审查（判断）。故事切片查 A / B / D——领域代码刚写完最便宜；实现切片查 C / E / F——外壳
  const prMode = protoLike ? 'proto' : 'shell'
  const prP = path.join(root, 'reports', `pre-pr-${prMode}.json`)
  const pr = fs.existsSync(prP) ? readJson(prP) : null
  const prCmd = (sub) => `node tools/prepr.js ${sub} ${rel(root)} ${slice.id} --mode ${prMode}${sub === 'new' ? ` --code ${rel(codebase)}` : ''}`
  const angles = protoLike ? 'A 用例流程 / B 被删的不变量 / D 测试行为 / S 风格' : 'C 契约完整 / E 防御正确性 / F 并发与状态 / S 风格'
  if (!pr || pr.slice !== slice.id) return step('pre-pr 审查', `查 ${angles}：先 ${prCmd('new')} 出骨架（列了范围文件与可跳过的 U-xxx），逐角度找候选、每条复核一票，填进 judgments 与 cleanAngles，最后 ${prCmd('check')}`, prCmd('new'), protoLike ? '领域代码刚写完，查业务行为最便宜' : '外壳写完，查契约、输入边界、错误处理与并发')
  if (pr.conclusion === null) return step('pre-pr 审查', `报告还没过形状核对（每个角度要有结论、每条发现要有文件:行与失败场景）`, prCmd('check'), 'pre-pr 报告形状与校验报告一致，审阅工具才能读')
  const ps = reportState(pr)
  if (ps.state === 'unreviewed') return step('人', `审阅 pre-pr 报告的 ${ps.unreviewed} 条发现：同意「必须改」的即回流${protoLike ? '原型' : '编码'}；「应该改」由你定`, `node tools/review.js ${rel(prP)}`, '发现的是代码问题，不写 decisions，只记切片 log')
  if (!ps.applied) return step('路由', '把 pre-pr 的审阅结果写回切片 log', `node tools/slice.js apply ${rel(root)} ${rel(prP)} --slice ${slice.id}`, '审阅已填但未写回')
  if (ps.state === 'rework') return step(coderRole, `按 pre-pr 回流改代码（${ps.rework} 项，见切片 log）；改完重跑 ${planCmd('check')} 与校验 ②，再 ${prCmd('new')} 让审查角色重查`, prCmd('new'), '人同意的「必须改」项要改掉再复查')
  if (isChange) return step('人', `在原型上重走这条修改动到的段落（${(slice.touches ?? []).join('、')}）：node tools/proto.js serve ${rel(root)} --code ${rel(codebase)}；老路没断、这件事改对了就收口`, null, '修改切片改的是已走通的段落，重走一遍才算没弄断')
  if (isStory) return step('人', `在原型上走一遍故事「${story?.title ?? slice.title}」：node tools/proto.js serve ${rel(root)} --code ${rel(codebase)}，按故事走、随手改输入试规则、试 U-xxx 说的连点 / 同时 / 成批；对了就合并；不对的在故事页或模型图上留意见`, null, '原型是人对模型的最后一道检查')
  return step('人', '切片完成，合并', null, '模型、代码、校验、审查都已完成')
}
/** 模块切片从骨架初稿推到业务走查（第九十七批，seed/slices.md「模型怎么建」）：模型关重新开，点亮的语句与走查文件留着。只许往前 */
if (cmd === 'pass') {
  const id = args[2], to = args[3]
  if (!id || !PASSES.includes(to)) die(`用法：slice pass <项目目录> <切片id> <${PASSES.join('|')}>`)
  const slice = readJson(slicePath(id))
  if (slice.kind !== 'module') die(`${id} 不是模块切片：遍是模块切片的事（骨架初稿 → 业务走查）；段落切片只做应用层，没有遍可推（第九十七批）`)
  const from = slice.pass ?? '骨架'
  if (PASSES.indexOf(to) <= PASSES.indexOf(from)) die(`${id} 现在在${from}，只许往前推（${PASSES.join(' → ')}）；要退回去先跟项目所有者说，再手改切片记录`)
  if (slice.stages.model.status !== 'done') die(`${id} 的${from === '骨架' ? '骨架初稿' : '走查'}还没定（${slice.stages.model.status}），没定不推下一步`)
  const was = slice.stages.model.confirmedAt
  // 骨架初稿里记下的「这一步接不住」到走查就该失效：那几条正是走查要长出不变量与领域服务来接的。
  // 留着的话，走查一给落点，校验器就报「记成只作背景，模型里却给了落点」（第九十七批）。
  const dropped = slice.backgroundTraces ?? []
  if (dropped.length) delete slice.backgroundTraces
  slice.pass = to
  slice.stages.model = { status: 'pending', confirmedAt: null }
  appendLog(slice, 'slice', `骨架初稿 ${was ?? '—'} 定了，推到业务走查：模型关重新开，点亮的语句留着，走查场景由讲解写${dropped.length ? `；骨架接不住的 ${dropped.length} 条（${dropped.map((b) => b.id).join('、')}）登记作废，走查要给它们落点` : ''}`)
  writeJson(slicePath(id), slice)
  console.log(`${id} 推到业务走查：讲解出场景，模型师拿初稿走、长出聚合行为，他在场。下一步看 slice next`)
  if (dropped.length) console.log(`  骨架接不住的 ${dropped.length} 条登记作废，逐条看一遍：走查长得出落点的就让它长，落点其实在应用层（段落切片）的重新登记回 backgroundTraces：\n${dropped.map((b) => `    ${b.id}：${b.why}`).join('\n')}`)
}
/**
 * 业务分析模块点亮完，开发指挥把编号登记进模块切片（第九十七批）：骨架初稿照这些语句起草。
 * 修改切片也用它（第一百七十五批）：m-004 改到一半发现模型里建着「被拒的钱放回时账上另记合计、留痕」，
 * 业务里一条语句都没有；业务分析补了 R-250，不登记进切片，校验就不给它出判断，模型里那一条从此没人判。
 */
/** 看板上这条切片还没答的问题（第一百七十八批：业务这一关收口、模型这一关开工都看它） */
function openQuestions(sliceId) {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(root, 'reports', '_scene.json'), 'utf8'))
    return (sc.questions ?? []).filter((q) => q.slice === sliceId && !q.answeredAt)
  } catch { return [] }
}

if (cmd === 'lit') {
  const id = args[2], ids = (args[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!id || !ids.length) die('用法：slice lit <项目目录> <切片id> <R-001,G-002,…>　业务分析点亮完（模块切片）或补了新语句（修改切片），开发指挥把编号登记进切片')
  const slice = loadSlice(id)
  if (slice.kind !== 'module' && slice.kind !== 'change') die(`${id} 既不是模块切片也不是修改切片；段落的编号由故事点亮回填，不用登记`)
  const { business } = loadProject(root)
  const known = new Set(business.map((s) => s.id))
  const missing = ids.filter((i) => !known.has(i))
  if (missing.length) die(`这些编号在 business/ 里不存在：${missing.join('、')}`)
  slice.traces = [...new Set([...slice.traces, ...ids])].sort()
  const isChange = slice.kind === 'change'
  if (!isChange) {
    slice.stages.model.litAt = today
    // 模块切片点亮登记完，业务这一关就算定了（第一百七十八批把这件事显式化）
    const open = openQuestions(id)
    if (!open.length) { slice.stages.business.status = 'done'; slice.stages.business.confirmedAt = today }
    else console.error(`  ⚠ 业务这一关没收口：${id} 上还有 ${open.length} 件等人答（${open.map((q) => q.id).join('、')}）`)
  }
  appendLog(slice, 'model', isChange ? `补的语句登记 ${ids.length} 条：${ids.join('、')}` : `模块点亮登记 ${ids.length} 条：${ids.join('、')}`)
  writeJson(slicePath(id), slice)
  console.log(`${id}：登记了 ${ids.length} 条编号，共 ${slice.traces.length} 条。下一步 ${isChange ? '跑一趟 validate，新编号会出一条判断，交给模型校验填' : 'slice next（模型师起草骨架初稿）'}`)
}
/**
 * 只作背景（候选 #9）：只改切片记录里 backgroundTraces 这一栏，读、改、写在同一刻做完。
 * 从前角色自己整份写回切片文件，几个角色轮流写，后一个把前一个刚加的冲掉——k-002 里业务分析补语句时冲掉了模型师登记的 4 条，没有任何提示。
 */
if (cmd === 'background') {
  const id = args[2], op = args[3], tid = args[4]
  if (!id || !['add', 'remove', 'list'].includes(op) || (op !== 'list' && !tid)) die('用法：slice background <项目目录> <切片id> add <R-xxx> "<为什么本段落不了：缺哪个动作、等哪一段>" | remove <R-xxx> | list')
  const slice = loadSlice(id)
  slice.backgroundTraces = slice.backgroundTraces ?? []
  if (op === 'list') { for (const b of slice.backgroundTraces) console.log(b.id + '　' + b.why); console.log('共 ' + slice.backgroundTraces.length + ' 条'); process.exit(0) }
  if (op === 'add') {
    const why = args.slice(5).join(' ').trim()
    if (!why) die('要写为什么本段落不了（缺哪个动作、等哪一段）——只写编号，日后没人知道它为什么在这儿')
    const { business } = loadProject(root)
    if (!business.some((s) => s.id === tid)) die(tid + ' 在 business/ 里不存在')
    const had = slice.backgroundTraces.find((b) => b.id === tid)
    if (had) had.why = why; else slice.backgroundTraces.push({ id: tid, why })
    appendLog(slice, 'model', (had ? '改写只作背景的理由：' : '登记只作背景：') + tid)
  } else {
    const n = slice.backgroundTraces.length
    slice.backgroundTraces = slice.backgroundTraces.filter((b) => b.id !== tid)
    if (slice.backgroundTraces.length === n) die(tid + ' 不在只作背景里')
    appendLog(slice, 'model', '撤掉只作背景：' + tid)
  }
  writeJson(slicePath(id), slice)
  console.log(id + '：只作背景现在 ' + slice.backgroundTraces.length + ' 条')
  process.exit(0)
}
/** 出原型这道门（第九十七批）：段落的模型确认后，项目所有者看过整个模型、说了「出原型」才算编码计划 */
if (cmd === 'proto-go') {
  const id = args[2]
  if (!id) die('用法：slice proto-go <项目目录> <切片id> [他的话]')
  const slice = loadSlice(id)
  if (slice.kind !== 'story') die(`${id} 不是段落切片；出原型这道门只在段落上`)
  if (slice.stages.model.status !== 'done') die(`${id} 的模型还没确认（${slice.stages.model.status}），先审完模型再说出原型`)
  if (slice.protoGo) die(`${id} 已经在 ${slice.protoGo.at} 说过出原型了`)
  slice.protoGo = { at: today, note: args.slice(3).join(' ') || '项目所有者看过模型，说出原型' }
  appendLog(slice, 'slice', `出原型：${slice.protoGo.note}`)
  writeJson(slicePath(id), slice)
  console.log(`${id}：记下了，出原型。下一步 slice next（算编码计划）`)
}
if (cmd === 'next') {
  const slice = loadSlice(args[2] ?? die('用法：slice next <项目目录> <切片id> [--json]'))
  const n = computeNext(slice)
  // 换了机器还没 git pull 就动手，先提醒一句（现场看板记着上一次是哪台机器写的）
  const sceneP = path.join(root, 'reports', '_scene.json')
  if (!args.includes('--json') && fs.existsSync(sceneP)) {
    try {
      const sc = JSON.parse(fs.readFileSync(sceneP, 'utf8'))
      const me = require('node:os').hostname()
      if (sc.machine && sc.machine !== me) console.log(`⚠ 现场上一次是在「${sc.machine}」写的，本机是「${me}」——先确认 git pull 过了；交接看 scene 一屏或页面`)
    } catch {}
  }
  // 这条切片上还有几件等人答：等着的时候不往下派（项目所有者 2026-09-20：「上游有待定的事项，
  // 模型师本不应开工」）。今天真出过——m-004 的三个问题挂着没答，业务分析先立了语句、模型校验
  // 先判了三条；他的答复一到，模型又改一轮，那三条判断全部重浮，一趟 2.8M 白花。
  const pending = (() => {
    try {
      const sc = JSON.parse(fs.readFileSync(sceneP, 'utf8'))
      return (sc.questions ?? []).filter((q) => q.slice === slice.id && !q.answeredAt)
    } catch { return [] }
  })()
  n.pending = pending.map((q) => ({ id: q.id, who: q.who, phase: q.phase, question: q.question }))
  if (args.includes('--json')) console.log(JSON.stringify(n, null, 2))
  else {
    console.log(`切片 ${slice.id}「${slice.title}」　模型 ${slice.stages.model.status} · 编码 ${slice.stages.code.status} · 校验 ${slice.stages.validate.status}`)
    // 业务这一关还没定时，下面的「下一步」本身就是「等你答」，这里不再重复列一遍（第一百七十八批）
    if (pending.length && (slice.stages.business?.status ?? 'done') === 'done') {
      console.log(`\n⛔ 这条切片还有 ${pending.length} 件等人答，先别往下派：`)
      for (const q of pending) console.log(`   ${q.id}（${q.who} 在${q.phase || '—'}这一关问的）：${q.question}`)
      console.log(`   答复一到，已经建好的语句、模型、判断都可能要改一轮——今天 m-004 就这么白判了一趟。`)
      console.log(`   人答了用 scene answer 记上；确实挡不住这一步的，自己判断往下走，并在裁定里记一笔为什么。\n`)
    }
    console.log(`下一步：${n.role} — ${n.action}`)
    if (n.command) console.log(`执行：${n.command}`)
    console.log(`因为：${n.why}`)
  }
}

// ---------- proofread：文职总校完了记一笔 ----------
if (cmd === 'proofread') {
  const slice = loadSlice(args[2] ?? die('用法：slice proofread <项目目录> <切片id>'))
  slice.stages.model.proofreadAt = today
  appendLog(slice, 'model', '文职总校完（本段新语句与模型文字，只改字不改意；裁决已按对照接回）')
  writeJson(slicePath(slice.id), slice)
  console.log(`${slice.id}：文职总校记下了（${today}）。下一步 slice next`)
}

// ---------- advance ----------
/**
 * 这条切片上还有什么要人裁的：一张单子，业务这一关的活就是把它清空（第一百七十八批）。
 * 散在五处——看板上没答的问题、故事里标了轮次的缺口、动到这条切片的候选、校验报告里的需人确认、
 * 走查里没裁的卡。从前要一处一处翻，翻漏了就成了「做到一半才发现要问」。
 */
if (cmd === 'pending') {
  const rel = (p) => path.relative(process.cwd(), p) || '.'
  const id = args[2] ?? die('用法：slice pending <项目目录> <切片id>')
  const slice = loadSlice(id)
  // 挡业务这一关：答案一变，上游的语句、模型、判断都要跟着改一轮。
  // 这一组的算法在 lib/project.js 的 businessBlockers 里，工作台顶栏读的是同一个函数——
  // 命令行说卡着四件、页面说没有等你的事，那个数就没人信了（第一百八十二批）
  const items = require('./lib/project').businessBlockers(root, id)
  const line = (b) => (b.id ? `${b.id}　` : '') + b.text
  const upstream = items.filter((b) => b.blocking).map((b) => [b.kind, line(b)])
  const later = items.filter((b) => !b.blocking).map((b) => [b.kind, line(b)])
  // 挡模型这一关收口：他在审模型页上要按的那些
  const downstream = []
  const r1 = reportOf(1, id)
  if (r1) for (const t of require('./lib/project').humanTodo(r1)) {
    if (t.name) downstream.push(['方法块', `${t.name}　写得对不对`])
    else if (t.target) downstream.push(['判断／警告', `${t.target}　${(t.ask ?? t.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}`])
  }
  const bs = slice.stages.business?.status ?? '（旧记录，没有这一关）'
  console.log(`${id}「${slice.title}」　业务 ${bs} · 模型 ${slice.stages.model.status}`)
  const print = (title, rows, tail) => {
    console.log(`\n${title}：${rows.length} 件`)
    let last = null
    for (const [kind, text] of rows) { if (kind !== last) { console.log(`  【${kind}】`); last = kind } console.log('   ' + text) }
    if (tail) console.log('  ' + tail)
  }
  print('挡住业务这一关', upstream, upstream.length
    ? '这一关的活就是把它清空。还没挂上看板的，现在就 scene ask 挂上去——做到一半才发现要问，上游已经建好的语句、模型、判断都得跟着改一轮。'
    : `业务这一关没有挡路的了：node tools/slice.js advance ${rel(root)} ${id} business done`)
  print('挡住模型这一关收口（他在审模型页上按）', downstream, downstream.length ? '这些不挡业务，也不挡模型师开工；模型要收口才要它们清完。' : '')
  // 缺口不挡这一关（项目所有者 2026-09-21 裁）：它是下一版故事的候选，重走那一趟才捡起来。
  // 摆在这里是为了让人看见「这一段主线之外还欠着什么」，不进要清空的那一组。
  if (later.length) print('留给下一轮（不挡这一关）', later, '走查缺口＝下一版故事的候选。要现在做的，用 candidate add 开成候选修改，或者 scene ask 挂成问题。')
  process.exit(0)
}

if (cmd === 'advance') {
  const [, , id, stage, status, ...rest] = args
  if (!id || !['business', 'model', 'code', 'validate'].includes(stage) || !['pending', 'in-progress', 'done'].includes(status)) {
    die('用法：slice advance <项目目录> <切片id> <business|model|code|validate> <pending|in-progress|done> [说明]')
  }
  const slice = loadSlice(id)
  const s = slice.stages[stage]
  const from = s.status
  s.status = status
  if (stage === 'business') {
    // 收口前挡一道：这条切片还有等人答的问题，业务就不算定了（第一百七十八批）
    if (status === 'done') {
      const open = openQuestions(id)
      if (open.length && !rest.length) {
        die(`${id} 上还有 ${open.length} 件等人答，业务这一关不能收口：\n${open.map((q) => `  ${q.id}　${q.question}`).join('\n')}\n人答了用 scene answer 记上；确实挡不住这一关的，把理由写在命令末尾当说明，它会记进切片日志。`)
      }
      s.note = rest.join(' ') || null
    }
    s.confirmedAt = status === 'done' ? today : null
  }
  if (stage === 'model') s.confirmedAt = status === 'done' ? today : null
  // 模型阶段开工时记下基线提交：model-delta 拿它算「这一段改了什么」，人只确认增量
  if (stage === 'model' && status === 'in-progress' && !s.baseline) { const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }); s.baseline = g.status === 0 ? g.stdout.trim() : null }
  if (stage === 'code') s.at = status === 'done' ? today : null
  if (stage === 'validate') {
    s.reportAt = status === 'done' ? today : null
    if (status === 'done') s.decodedVersion = reportOf(2, id)?.decodedVersion ?? null
  }
  appendLog(slice, stage, rest.join(' ') || `${from} → ${status}`)
  writeJson(slicePath(id), slice)
  console.log(`${id}.${stage}: ${from} → ${status}`)
}

// ---------- apply：裁决写回 ----------
function targetFiles(it) {
  // 目标是模型文件路径（可带 #片段）→ 该文件；目标是业务编号 → related 里的每个文件
  const file = it.target.split('#')[0]
  if (file.startsWith('model/') && file.endsWith('.json')) return [file]
  return it.related ?? []
}
if (cmd === 'apply') {
  const reportPath = args[2] && path.resolve(args[2])
  if (!reportPath || !fs.existsSync(reportPath)) die('用法：slice apply <项目目录> <报告 json> [--slice <切片id>]')
  const report = readJson(reportPath)
  const sliceId = opt('--slice') ?? report.slice
  const slice = sliceId ? loadSlice(sliceId) : null
  const stage = report.direction === 1 ? 'model' : report.direction === 3 ? 'pre-pr' : 'validate'
  const codeReview = report.direction === 3 // pre-pr：发现的是代码问题，不写任何 decisions[]
  const written = new Map() // file → [decision]
  const rework = []
  const skipped = []

  const pushDecision = (it, verdict, note) => {
    const files = targetFiles(it)
    if (!files.length) return skipped.push(`${it.target}：找不到写回的模型文件`)
    for (const f of files) {
      if (!written.has(f)) written.set(f, [])
      written.get(f).push({ target: it.target, check: it.check, verdict, note, at: today, by: 'human', ...(it.on ? { on: it.on } : {}) })
    }
  }
  for (const j of report.judgments) {
    const h = j.human?.verdict
    if (!h) continue
    const note = [j.reason, j.human.note].filter(Boolean).join('；')
    if (needsWork(j)) rework.push(codeReview ? `[${j.check}] ${j.target}（${{ high: '必须改', medium: '应该改', low: '说明' }[j.importance] ?? j.importance}）：${j.failure ?? j.reason}${j.human.note ? `——${j.human.note}` : ''}` : `[${j.check}] ${j.target}：${h === 'agree' ? '校验判为不通过，人同意' : h === 'disagree' ? '校验判为通过，人不同意' : '人判为不通过'}${j.human.note ? `——${j.human.note}` : ''}`)
    else if (!codeReview) pushDecision(j, 'dismissed', note || '判断通过，人已同意')
  }
  for (const c of report.confirms) {
    const h = c.human?.verdict
    if (!h) continue
    if (needsWork(c)) rework.push(`[${c.check}] ${c.target}：选择「${c.options?.[Number(h) - 1] ?? h}」${c.human.note ? `——${c.human.note}` : ''}`)
    else {
      const verdict = h === 'dismissed' ? 'dismissed' : 'accepted'
      if (verdict === 'accepted' && !c.human.note) skipped.push(`${c.target}：承认例外 / 接受现状必须写理由（note）`)
      else pushDecision(c, verdict, c.human.note || '')
    }
  }
  for (const w of report.warnings ?? []) {
    const h = w.human?.verdict
    if (!h) continue
    // 人不驳回就是要改：退回去修，修好了重跑校验这条警告自己就没了
    if (h !== 'dismissed') { rework.push(`[${w.check}] ${w.target}：警告，人要改——${w.text}${w.human.note ? `——${w.human.note}` : ''}`); continue }
    if (!w.human.note) skipped.push(`${w.target}：驳回警告必须写理由（note）`)
    else pushDecision(w, 'dismissed', w.human.note)
  }
  // 按模型看的块（第一百五十六批）：写得对 → 记进那个文件的 decisions[]（带这一块的指纹，下一场认得出没变）；要改 → 回流给模型师
  for (const b of report.blocks ?? []) {
    const h = b.human?.verdict
    if (!h) continue
    if (h === 'fix') { rework.push(`[方法要改] ${b.name}（${b.kind === 'create' ? '字段与创建' : b.kind === 'operation' ? '领域服务操作' : '行为'}）${b.human.note ? '——' + b.human.note : ''}`); continue }
    if (!written.has(b.file)) written.set(b.file, [])
    written.get(b.file).push({ target: b.id, check: '方法写得对不对', verdict: 'dismissed', note: b.human.note || '写得对', at: today, by: 'human', on: b.fp })
  }
  // 写入模型文件：同 target + check 的旧裁决被替换
  for (const [f, ds] of written) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) {
      skipped.push(`${f}：文件不存在`)
      continue
    }
    const data = readJson(p)
    // 同一目标名下可能有好几条（多条聚合级不变量的 target 相同），靠指纹分辨：
    // 带指纹的只顶掉指纹相同的那条，不带指纹的仍按「目标+检查项」整条替换
    data.decisions = (data.decisions ?? []).filter((d) => !ds.some((n) => n.target === d.target && n.check === d.check && (n.on && d.on ? n.on === d.on : true)))
    data.decisions.push(...ds)
    writeJson(p, data)
  }
  report.applied = { at: new Date().toISOString(), files: [...written.keys()], rework: rework.length }
  writeJson(reportPath, report)
  if (slice) {
    appendLog(slice, stage, codeReview ? `pre-pr 审阅写回（${report.mode}）：发现 ${report.judgments.length} 条，人同意要改 ${rework.length} 项` : `裁决写回（方向 ${report.direction}）：${[...written.values()].flat().length} 条进 decisions[]，回流 ${rework.length} 项`)
    for (const r of rework) appendLog(slice, stage, `回流：${r}`)
    writeJson(slicePath(slice.id), slice)
  }
  console.log(`已写回 ${[...written.values()].flat().length} 条裁决到 ${written.size} 个文件；回流 ${rework.length} 项${slice ? `（已记入 ${slice.id} 的 log）` : ''}`)
  for (const r of rework) console.log(`  回流：${r}`)
  for (const s of skipped) console.log(`  跳过：${s}`)
}

// ---------- log ----------
if (cmd === 'log') {
  const [, , id, stage, ...rest] = args
  if (!id || !['slice', 'model', 'plan', 'contracts', 'code', 'validate', 'pre-pr'].includes(stage) || !rest.length) die('用法：slice log <项目目录> <切片id> <slice|model|plan|contracts|code|validate|pre-pr> <文字>')
  const slice = loadSlice(id)
  appendLog(slice, stage, rest.join(' '))
  writeJson(slicePath(id), slice)
  console.log(`已记录到 ${id}`)
}

if (!['new', 'candidate', 'pass', 'lit', 'proto-go', 'next', 'pending', 'proofread', 'advance', 'apply', 'log'].includes(cmd)) die(`未知子命令：${cmd}`)
