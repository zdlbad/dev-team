#!/usr/bin/env node
/**
 * 切片驱动。依据 seed/01-phases-and-slices.md 的切片周期与 seed/05-roles.md 的「路由」职责。
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
 *   node tools/slice.js next <项目目录> <切片id>            算出下一步：谁上场、跑什么
 *                       段落切片：… → 理解一致 → 业务分析按五问补语句 → 人确认 → 模型 → … → 模型确认 → 编码计划（plan.js）→ 人确认计划
 *                       → 原型按计划写 → plan check → 校验 ② → pre-pr 审查（A/B/D）→ 人看报告 → 人在原型上走故事
 *                       实现切片：接口角色定契约（contract.js）→ 人确认 → 编码计划 → 人确认 → 编码 → plan check → 校验 ② → pre-pr（C/E/F）→ 合并
 *   node tools/slice.js advance <项目目录> <切片id> <model|code|validate> <pending|in-progress|done> [说明]
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

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const today = new Date().toISOString().slice(0, 10)

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
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
}
/** 同项目已有切片里最后记下的代码库；一条都没有就返回 null */
function lastCodebase() {
  const dir = path.join(root, 'slices')
  if (!fs.existsSync(dir)) return null
  const ids = fs.readdirSync(dir).filter((f) => f.startsWith('s-') && f.endsWith('.json') && !f.endsWith('.story.json')).sort()
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
  die('用法：node tools/slice.js <new|next|advance|apply|log> <项目目录> …（项目目录须含 project.json）')
}

// ---------- new ----------
if (cmd === 'new') {
  const id = args[2]
  const title = args[3]
  if (!id || !title) die('用法：slice new <项目目录> <切片id> <标题> [--kind …] [--codebase …] [--modules …] [--aggregates …] [--use-cases …] [--traces …]')
  if (!/^s-[0-9]{3,}$/.test(id)) die('切片 id 形如 s-001')
  if (fs.existsSync(slicePath(id))) die(`切片已存在：${id}`)
  const implementsArg = opt('--implements')
  const kind = args.includes('--重构') ? 'refactor' : args.includes('--story') ? 'story' : implementsArg ? 'implementation' : (opt('--kind') ?? (fs.existsSync(path.join(root, 'slices')) && fs.readdirSync(path.join(root, 'slices')).length ? 'increment' : 'initial'))
  const slice = {
    id,
    title,
    kind,
    // 同一个项目的切片写的是同一个代码库：沿用上一条切片记的那个，别每次退回默认值——
    // 默认值只在项目第一条切片时才对，后来的切片照抄它就指向了一个不存在的目录（s-003 就这么错过一次）
    codebase: opt('--codebase') ?? lastCodebase() ?? '../' + path.basename(root) + '-code',
    scope: { modules: list('--modules'), aggregates: list('--aggregates'), useCases: list('--use-cases') },
    // 一个故事段落只许有一个业务意图，写不出一句话就是不止一个（seed/01-phases-and-slices.md「开发范围怎么切」）
    ...(opt('--意图') ? { intent: opt('--意图') } : {}),
    ...(opt('--业务故事') ? { businessStory: opt('--业务故事') } : {}),
    traces: list('--traces'),
    stages: {
      model: { status: 'pending', confirmedAt: null },
      code: { status: 'pending', at: null },
      validate: { status: 'pending', decodedVersion: null, reportAt: null },
    },
    log: [{ ts: today, stage: 'slice', text: `切片建立：${title}` }],
  }
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
  if (args.includes('--story')) {
    const sp = path.join(root, 'slices', `${id}.story.json`)
    const bi = args.indexOf('--based-on'), basedOn = bi > 0 ? args[bi + 1] : null
    const baseP = basedOn ? path.join(root, 'slices', `${basedOn}.story.json`) : null
    if (basedOn && !fs.existsSync(baseP)) { console.error(`上一版故事不存在：${basedOn}`); process.exit(1) }
    const base = basedOn ? readJson(baseP) : null
    const story = { slice: id, title, persona: base ? base.persona : { name: '（人物）', description: '（一句话：谁、分类、入册日）' }, steps: [], traces: [], choices: [], gaps: [], approved: null, log: [] }
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
    console.log(`已建故事骨架：${path.relative(process.cwd(), sp)}（${base ? `基于 ${basedOn}，上一版 ${base.steps.length} 步写成前情提要、不重复；` : ''}下一步：讲解写故事）`)
  } else console.log('下一步：人与模型师商定范围后，把 scope 与 traces 填进切片记录，再执行 slice next。')
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
  const blocking = r.errors.length + r.warnings.length
  if (blocking) return { state: 'blocked', errors: r.errors.length, warnings: r.warnings.length }
  const unjudged = r.judgments.filter((j) => !j.verdict).length
  if (unjudged) return { state: 'unjudged', unjudged }
  const unreviewed = [...r.judgments, ...r.confirms].filter((it) => !it.human?.verdict).length
  if (unreviewed) return { state: 'unreviewed', unreviewed }
  const rework = [...r.judgments.filter(needsWork), ...r.confirms.filter(needsWork)]
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
  const storyP = path.join(root, 'slices', `${slice.id}.story.json`)
  const story = fs.existsSync(storyP) ? readJson(storyP) : null
  const scopeEmpty = slice.kind === 'initial' || story ? !scopeNamed && !slice.traces.length : !scopeNamed
  const codebase = path.resolve(root, slice.codebase)
  const rel = (p) => path.relative(process.cwd(), p) || '.'
  const validateCmd = (withCode) => `node tools/validate.js ${rel(root)}${withCode ? ` --code ${rel(codebase)}` : ''} --slice ${slice.id}`
  const step = (role, action, command, why) => ({ slice: slice.id, role, action, command: command ?? null, why })
  // 按裁定归档的切片只是记录，不再派活（看板也这么认）
  if (slice.archived) return step('—', '已归档：' + slice.archived.reason, null, '这条切片按裁定归档，不再推进')

  // 阶段一：模型。业务描述是模型的上游：没有它就无从定范围
  // 只改说法或结构的那一类不动模型，模型这一关对它不适用
  if (st.model.status !== 'done' && slice.kind !== 'refactor') {
    const { business, glossary } = loadProject(root)
    const inScope = slice.traces.length ? business.filter((s) => slice.traces.includes(s.id)) : business
    if (!business.length && !fs.existsSync(path.join(root, 'business', '00-全景.md'))) return step('业务分析', '粗读 raw/：写全景（business/00-全景.md）、模块候选、词汇表种子；不写编号语句，语句按段落点亮', null, '本项目还没粗读过')
    if (!glossary.terms.length) return step('业务分析', '补词汇表：业务描述里的名词逐个收录', null, '模型只能使用词汇表的法定名')
    if (slice.traces.length && !inScope.length) return step('业务分析', `切片追溯的编号在业务描述里不存在：${slice.traces.join('、')}`, null, '切片的 traces 必须指向已有的业务语句')
    // 故事切片：先有故事，人在业务理解上与团队一致后才有范围
    const ss = story ? storyState(story) : null
    const storyRel = rel(storyP)
    if (ss?.state === 'no-steps') return step('讲解', story.basedOn ? `从上一版 ${story.basedOn} 起笔写故事到 ${storyRel}：老步骤照抄不改，插进这一版新增的那段，重新编号；填 adds；整条要从头走到尾` : `写本段故事到 ${storyRel}：一个人物、逐步的日期与金额；每步标 needs（需要哪条业务，人话），traces 留空等业务分析点亮`, null, '段落的范围由故事决定；故事写在语句之前')
    if (ss?.state === 'adds-missing') return step('讲解', `故事 ${storyRel} 基于 ${story.basedOn} 但 adds 还是占位：一句话写清这一版多了什么`, null, '谱系要能一眼看出每版加了什么')
    if (ss?.state === 'challenged') return step('路由', `核对人对故事的 ${ss.count} 处质疑：对照语句、裁定与手册逐条回应；人对了就落成裁定并派业务分析或讲解改，人误会了就解释；改完让人重看`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人质疑了故事的业务内容，先解决再认可')
    if (ss?.state === 'notes') return step('路由', `读人在故事上留下的 ${ss.count} 条想法（同意但有话说的也算）：逐条回应；成立的落成裁定或派给业务分析、讲解、模型师`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '人的想法要有人看、有人回')
    if (ss?.state === 'unapproved') return step('人', `走故事「${story.title}」：逐条确认语句、同意或质疑每一步，直到业务理解一致`, `node tools/story.js approve ${rel(root)} ${slice.id}`, '认可后故事的编号并入切片 traces')
    // 段落切片：理解一致之后、建模之前，业务分析按五问（同时 / 重复 / 一次几条 / 失败处置 / 可见性）补出本段还缺的情形，人确认
    if (ss?.state === 'usage-pending') return step('业务分析', `按故事「${story.title}」过五问：故事走到的每个动作问一遍会不会同时、会不会重复、一次几条与部分失败、失败怎么处置、谁能看见。问出来的可能发生的情况写成普通语句（业务落地-情形，R 编号），软件该怎么回应（幂等、锁、批量语义）不写、留给模型师；raw 里没有的写进问题清单问人。产出里列出新增编号，开发指挥据此登记`, `node tools/story.js usage ${rel(root)} ${slice.id} propose <R-xxx,… | --none>`, '五问问出来的情形通常不在原料里，要主动问；模型师照它们定第三层')
    if (ss?.state === 'usage-proposed') return step('人', `确认本故事按五问补出的 ${ss.count} 条语句：这是业务里可能碰上的情形，比如「两位案例经理可能同时处理同一位参与者」；软件怎么回应由模型师定`, `node tools/story.js usage ${rel(root)} ${slice.id} confirm`, '确认后编号并入切片 traces，校验 ① 会要求模型给它们落点')
    if (scopeEmpty) return step('人 + 模型师', '定范围：填切片记录的 scope 与 traces', null, '切片首先是对模型改动范围的定稿')
    const r1 = reportOf(1, slice.id)
    const s1 = reportState(r1)
    // 人在模型图上留的意见：先有人看、有人回，再往下走
    const mnP = path.join(root, 'reports', '_模型意见.json')
    const mnOpen = fs.existsSync(mnP) ? Object.entries(readJson(mnP)).flatMap(([f, ns]) => ns.filter((n) => !n.handled).map((n) => ({ f, ...n }))) : []
    if (mnOpen.length) return step('路由', `读人对模型的 ${mnOpen.length} 条意见（reports/_模型意见.json）：逐条回应；要改的派模型师，改完把 handled 置真`, null, '人在模型图上留了意见，先回应再推进')
    if (st.model.status === 'pending') return step('模型师', story ? (story.basedOn ? `只建这一版新增那段所需的最少模型（上一版 ${story.basedOn} 的模型已在）；给每一步填 walk——老步骤也要重走，保证老路没被新东西弄断；做过的选择列进 choices` : '按故事建走通它所需的最少模型；写完给每一步填 walk，把做过的选择列进 choices') : '在范围内建模 / 改模', `node tools/slice.js advance ${rel(root)} ${slice.id} model in-progress`, '范围已定，模型阶段尚未开始')
    // in-progress：看方向 ① 报告走到哪
    if (s1.state === 'none' || (r1.slice && r1.slice !== slice.id)) return step('模型校验', '跑校验 ①（机械检查 + 生成判断清单）', validateCmd(false), '模型阶段进行中，还没有本切片的方向 ① 报告')
    if (s1.state === 'blocked') return step('模型师', `修正模型：方向 ① 有 ${s1.errors} 个错误、${s1.warnings} 个警告`, validateCmd(false), '机械检查未过，先改再重跑')
    // 故事切片：人先走故事、过裁定卡，再轮到校验角色填判断
    if (ss?.state === 'no-walk') return step('模型师', `走故事：给 ${ss.count} 步填 walk（命令 / 事件 / 查询、动了哪个聚合、变了什么；走不通的填 gap），把做过的选择列进 choices（每条带 current 与 recommended）`, storyRel, '模型建好后先在故事上走一遍')
    if (ss?.state === 'no-quiz') return step('讲解', `出题：给关键步骤加 quiz（预测再揭晓：数字或选择，不要作文），检查 choices 的措辞与金额例子`, storyRel, '人走故事前要有题')
    if (ss?.state === 'awaiting-human') return step('人', `走故事：预测 ${ss.quiz} 题、裁定 ${ss.choices} 张卡`, `node tools/story.js serve ${rel(root)} ${slice.id}`, '人在模型上走一遍故事，顺手把模型师的选择定了')
    if (ss?.state === 'unapplied') return step('路由', `把 ${ss.count} 张裁定卡写回裁定文件与切片 log`, `node tools/story.js apply ${rel(root)} ${slice.id}`, '裁定已填但未写回')
    if (ss?.state === 'rework') return step('模型师', `按回流改模型（裁定 ${ss.rework} 项、走不通 ${ss.gaps} 处）；改完更新 choices 的 current、清掉 gap，重跑校验 ①`, validateCmd(false), '人的裁定与模型现状不同，或故事走不通')
    if (s1.state === 'unjudged') return step('模型校验', `填写 ${s1.unjudged} 条判断（verdict / confidence / reason）`, `reports/validate-1.json`, '判断清单待校验角色逐条判断')
    if (s1.state === 'unreviewed') return step('人', `审阅 ${s1.unreviewed} 条判断 / 需确认项`, `node tools/review.js ${rel(path.join(root, 'reports', 'validate-1.json'))}`, '人过目后才能确认模型')
    if (!s1.applied) return step('路由', '把裁决写回 decisions[] 与切片 log', `node tools/slice.js apply ${rel(root)} ${rel(path.join(root, 'reports', 'validate-1.json'))} --slice ${slice.id}`, '裁决已填但未写回')
    if (s1.state === 'rework') return step('模型师', `按回流清单修改模型（${s1.rework} 项），改完重跑校验 ①`, validateCmd(false), '人的裁决里有要改的项')
    return step('人', '确认模型（门禁）', `node tools/slice.js advance ${rel(root)} ${slice.id} model done`, '方向 ① 干净且人已审完；触及模块划分或聚合清单的变动需单独确认')
  }
  // 阶段二之前：编码计划。从模型算出这次要动哪些文件、按什么顺序；角色补关键逻辑；人确认；写的时候按顺序登记；写完核对。
  // 只改说法或结构的切片：没有业务意图，所以不走故事、不走裁定卡、也不算编码计划。
  // 它要证明的只有一件事：行为一个字没变——代码跟模型 0 差异，测试照旧全绿。
  if (slice.kind === 'refactor') {
    if (st.code.status !== 'done') {
      if (st.code.status === 'pending') return step('编码', '按这条切片的范围把代码里的说法改齐：一个字的业务行为都不许变，测试的断言值一个都不许改。改完先跑测试，再把代码解回来跟模型比', `node tools/slice.js advance ${rel(root)} ${slice.id} code in-progress`, '只改说法，不改行为')
      return step('人', '代码改齐、测试全绿（门禁）', `node tools/slice.js advance ${rel(root)} ${slice.id} code done`, '改完才比对')
    }
    if (st.validate.status !== 'done') return step('模型校验', '证明只有说法变了：改前的解码结果在 model-decoded/<改前版本>/（上一次校验 ② 留下的；没有就先 git 切回改前跑一次 validate --code），改后再跑一次 validate --code 得到新版本；然后把改名对照套在改前那份上与改后逐字节比，必须一字不差。不要求跟模型 0 差异——模型常跑在代码前面，那跟改名无关', `node tools/rename-check.js ${rel(path.join(root, 'model-decoded', '<改前版本>'))} ${rel(path.join(root, 'model-decoded', '<改后版本>'))} <新旧对照.json>`, '代码已改齐')
    return step('人', '合并（门禁）', null, '套上改名逐字节比过、一字不差，且测试照旧全绿：行为没变，说法改齐了')
  }
  const isStory = slice.kind === 'story' || !!story
  const coderRole = isStory ? '原型' : '编码'
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
    if (!plan) return step('路由', '从模型算出编码计划（要动哪些文件、按什么顺序）', planCmd('build'), '编码前先有计划，人能看链路对不对')
    const unfilled = plan.steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length
    if (unfilled) return step(coderRole, `给编码计划 plans/${slice.id}.json 的 ${unfilled} 步补关键逻辑（keyLogic）：这一步守哪条规则、哪条不变量在这里生效、分流怎么走${plan.kind === 'shell' ? '、事务边界在哪、锁怎么落、哪个错误映射哪个状态码' : ''}；只填 keyLogic，不动别的字段`, `plans/${slice.id}.md`, '关键逻辑是人要看的东西，机器算不出来')
    if (!plan.confirmedAt) return step('人', `看编码计划 plans/${slice.id}.md：链路顺序对不对（先建被引用的聚合、再仓储、再用例）、每步的关键逻辑是不是在该在的层（判断在聚合 / 服务，处理器只编排）；对了就确认`, planCmd('confirm'), '计划确认前不开写；编码顺序必须与计划一致')
    if (st.code.status === 'pending') return step(coderRole, isStory ? `按计划顺序写这条故事的领域代码与应用层（按 03 与 06，可解码），内存仓储与直连端口适配器，组合根登记到原型宿主，src/proto/main.ts，领域与用例测试；每完成一步 plan done；每层自跑解码比对；给每一步 walk 填 input；最后跑 ${protoCmd}` : `按计划顺序写（按 03 与 06${slice.kind === 'implementation' ? '，契约见 contracts/；领域层与应用层一行不动，只补外壳' : ''}）；每完成一步 plan done；每层自跑解码比对`, `node tools/slice.js advance ${rel(root)} ${slice.id} code in-progress`, '计划已确认')
    return step(coderRole, `写完：${planCmd('check')} 过${isStory ? `、${protoCmd} 过` : ''}，就标记完成`, `node tools/slice.js advance ${rel(root)} ${slice.id} code done`, '编码进行中')
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
  if (s2.state === 'blocked') return step('人', `处理差异：方向 ② 有 ${s2.errors} 个错误、${s2.warnings} 个警告——代码错回编码，模型错回模型师`, `reports/validate-2.md`, '差异回流由人判定回到哪一侧')
  if (s2.state === 'unjudged') return step('模型校验', `填写 ${s2.unjudged} 条语义等价判断`, `reports/validate-2.json`, '文字差异待判断')
  if (s2.state === 'unreviewed') return step('人', `审阅 ${s2.unreviewed} 条`, `node tools/review.js ${rel(path.join(root, 'reports', 'validate-2.json'))}`, '人过目')
  if (!s2.applied) return step('路由', '把裁决写回', `node tools/slice.js apply ${rel(root)} ${rel(path.join(root, 'reports', 'validate-2.json'))} --slice ${slice.id}`, '裁决已填但未写回')
  if (s2.state === 'rework') return step('人', `按回流清单决定改模型还是改代码（${s2.rework} 项）`, `reports/validate-2.md`, '语义不等价的项由人定改哪一侧')
  if (st.validate.status !== 'done') return step('路由', '标记校验完成', `node tools/slice.js advance ${rel(root)} ${slice.id} validate done`, '方向 ② 干净且已审完')
  // 校验 ② 之后：pre-pr 审查（判断）。故事切片查 A / B / D——领域代码刚写完最便宜；实现切片查 C / E / F——外壳
  const prMode = isStory ? 'proto' : 'shell'
  const prP = path.join(root, 'reports', `pre-pr-${prMode}.json`)
  const pr = fs.existsSync(prP) ? readJson(prP) : null
  const prCmd = (sub) => `node tools/prepr.js ${sub} ${rel(root)} ${slice.id} --mode ${prMode}${sub === 'new' ? ` --code ${rel(codebase)}` : ''}`
  const angles = isStory ? 'A 用例流程 / B 被删的不变量 / D 测试行为 / S 风格' : 'C 契约完整 / E 防御正确性 / F 并发与状态 / S 风格'
  if (!pr || pr.slice !== slice.id) return step('pre-pr 审查', `查 ${angles}：先 ${prCmd('new')} 出骨架（列了范围文件与可跳过的 U-xxx），逐角度找候选、每条复核一票，填进 judgments 与 cleanAngles，最后 ${prCmd('check')}`, prCmd('new'), isStory ? '领域代码刚写完，查业务行为最便宜' : '外壳写完，查契约、输入边界、错误处理与并发')
  if (pr.conclusion === null) return step('pre-pr 审查', `报告还没过形状核对（每个角度要有结论、每条发现要有文件:行与失败场景）`, prCmd('check'), 'pre-pr 报告形状与校验报告一致，审阅工具才能读')
  const ps = reportState(pr)
  if (ps.state === 'unreviewed') return step('人', `审阅 pre-pr 报告的 ${ps.unreviewed} 条发现：同意「必须改」的即回流${isStory ? '原型' : '编码'}；「应该改」由你定`, `node tools/review.js ${rel(prP)}`, '发现的是代码问题，不写 decisions，只记切片 log')
  if (!ps.applied) return step('路由', '把 pre-pr 的审阅结果写回切片 log', `node tools/slice.js apply ${rel(root)} ${rel(prP)} --slice ${slice.id}`, '审阅已填但未写回')
  if (ps.state === 'rework') return step(coderRole, `按 pre-pr 回流改代码（${ps.rework} 项，见切片 log）；改完重跑 ${planCmd('check')} 与校验 ②，再 ${prCmd('new')} 让审查角色重查`, prCmd('new'), '人同意的「必须改」项要改掉再复查')
  if (isStory) return step('人', `在原型上走一遍故事「${story?.title ?? slice.title}」：node tools/proto.js serve ${rel(root)} --code ${rel(codebase)}，按故事走、随手改输入试规则、试 U-xxx 说的连点 / 同时 / 成批；对了就合并；不对的在故事页或模型图上留意见`, null, '原型是人对模型的最后一道检查')
  return step('人', '切片完成，合并', null, '模型、代码、校验、审查都已完成')
}
if (cmd === 'next') {
  const slice = loadSlice(args[2] ?? die('用法：slice next <项目目录> <切片id> [--json]'))
  const n = computeNext(slice)
  // 换了机器还没 git pull 就动手，先提醒一句（现场看板记着上一次是哪台机器写的）
  const sceneP = path.join(root, 'reports', '_现场.json')
  if (!args.includes('--json') && fs.existsSync(sceneP)) {
    try {
      const sc = JSON.parse(fs.readFileSync(sceneP, 'utf8'))
      const me = require('node:os').hostname()
      if (sc.machine && sc.machine !== me) console.log(`⚠ 现场上一次是在「${sc.machine}」写的，本机是「${me}」——先确认 git pull 过了；交接看 scene 一屏或页面`)
    } catch {}
  }
  if (args.includes('--json')) console.log(JSON.stringify(n, null, 2))
  else {
    console.log(`切片 ${slice.id}「${slice.title}」　模型 ${slice.stages.model.status} · 编码 ${slice.stages.code.status} · 校验 ${slice.stages.validate.status}`)
    console.log(`下一步：${n.role} — ${n.action}`)
    if (n.command) console.log(`执行：${n.command}`)
    console.log(`因为：${n.why}`)
  }
}

// ---------- advance ----------
if (cmd === 'advance') {
  const [, , id, stage, status, ...rest] = args
  if (!id || !['model', 'code', 'validate'].includes(stage) || !['pending', 'in-progress', 'done'].includes(status)) {
    die('用法：slice advance <项目目录> <切片id> <model|code|validate> <pending|in-progress|done> [说明]')
  }
  const slice = loadSlice(id)
  const s = slice.stages[stage]
  const from = s.status
  s.status = status
  if (stage === 'model') s.confirmedAt = status === 'done' ? today : null
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
    if (h !== 'dismissed') continue
    if (!w.human.note) skipped.push(`${w.target}：驳回警告必须写理由（note）`)
    else pushDecision(w, 'dismissed', w.human.note)
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

if (!['new', 'next', 'advance', 'apply', 'log'].includes(cmd)) die(`未知子命令：${cmd}`)
