#!/usr/bin/env node
/**
 * 校验器。依据 agents/model/validation.md。
 *
 * 用法：node tools/validate.js <项目目录> [--code <代码库目录>] [--slice <切片id>]
 *   方向 ①（模型 ↔ 业务描述）总是执行；带 --code 时执行方向 ②（解码代码并与模型比对）。
 * 输出：reports/validate-1.json/.md、reports/validate-2.json/.md（每方向只留最新一份）。
 * 退出码：0 干净；1 不干净；2 用法或前置错误。
 *
 * 机械检查在此完成；判断类检查只产出「待判断清单」（judgments[]，verdict 为 null），由校验 agent 填写。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { applyWordMap, loadProject, LAYERS, KINDS, labelOf } = require('./lib/project')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
const codeIdx = args.indexOf('--code')
const codebase = codeIdx >= 0 ? path.resolve(args[codeIdx + 1]) : null
const sliceIdx = args.indexOf('--slice')
const sliceId = sliceIdx >= 0 ? args[sliceIdx + 1] : null
// 纯改名之后重新定基：给它一份「新说法 → 旧说法」的对照（JSON 文件），它反着换回去，
// 换出来的文字与当初人裁的那一段一字不差，才把指纹重算；证不出来的一律留着过期、由人重裁。
const rebaseIdx = args.indexOf('--重新定基')
const rebaseFile = rebaseIdx >= 0 ? args[rebaseIdx + 1] : null
const whyIdx = args.indexOf('--说明')
const rebaseWhy = whyIdx >= 0 ? args[whyIdx + 1] : null
// 正常跑那一趟也能带这份对照：上一份报告里已经填好的判断，文字只因改名而变的照样接过来
const renameIdx = args.indexOf('--改名')
const renameFile = renameIdx >= 0 ? args[renameIdx + 1] : (rebaseFile ?? null)
/** 把新说法反着换回旧说法；没给对照就原样返回 */
const unrename = (() => {
  if (!renameFile) return null
  let pairs
  try { pairs = JSON.parse(fs.readFileSync(path.resolve(renameFile), 'utf8')) } catch { return null }
  const keys = Object.keys(pairs).sort((a, b) => b.length - a.length) // 长的先换，免得「录入花费」被「录入」先切开
  return (t) => applyWordMap(t, pairs, keys)
})()
if (!root || !fs.existsSync(path.join(root, 'model'))) {
  console.error('用法：node tools/validate.js <项目目录> [--code <代码库目录>] [--slice <切片id>]')
  console.error('　　　　重新定基：node tools/validate.js <项目目录> --重新定基 <rename-map.json> --说明 "第几批只改了名字、换的是哪几个说法"')
  process.exit(2)
}
const devTeam = path.resolve(__dirname, '..')
const today = new Date().toISOString().slice(0, 10)

// ---------- 判断指南：每类判断在问什么、什么算通过 ----------
const GUIDES = {
  '模型规则是否与业务一致？': {
    question: '模型里这句话（不变量 / 行为规则 / 错误条件）是否完整、准确地表达了业务语句的意思？',
    pass: '意思一致。粒度可以不同：业务一句话可以拆到多个落点，每个落点只覆盖一部分也算通过，只要合起来不漏。',
    fail: '模型说得比业务少（漏了条件或例外）、说得比业务多（加了业务没说的限制）、或方向相反。落点本身站不住也不通过：一条不变量只是叙述、聚合自己核对不了、没有字段或守卫去查——那是为了给编号凑落点写的，修法是删掉、挪到端口或用例。',
    how: '先问落点站不站得住：不变量是聚合随时能核对的一句话吗？错误有没有条件？站得住再对照编号把业务语句拆成条件逐个核对：主语、条件、结果各对应到模型里的哪个词。',
  },
  '用例是否按步骤完成了业务目标？': {
    question: '这个命令 / 查询的步骤走完，业务目标是否真的达成？',
    pass: '步骤链能从触发走到目标所说的结果，中间没有跳跃。',
    fail: '缺关键步骤（比如说要通知却没有通知那一步），或用例做的其实是另一件事。',
    how: '把目标句拆成「谁、做什么、得到什么」，在步骤里逐个找。',
  },
  '步骤是否只是编排，没有夹带业务判断？': {
    question: '这一步的文字是不是纯粹的「取、调、存、发」？',
    pass: '描述的是一次调用或一次数据搬运，没有条件、没有计算。',
    fail: '文字里出现「如果 / 当 / 满足 / 超过 / 大于 / 计算」这类判断或计算——它们应该住在聚合行为或领域服务里，而不是编排步骤里。',
    how: '看动词：读取、创建、保存、发布、通知是编排；判断、校验、计算、比较是业务。',
  },
  '分流条件是否只引用了领域调用的结果？': {
    question: '这条 when 是否只引用了前一步领域调用的返回值？',
    pass: '形如「decision 为 discounted」：判断已在领域里做完，这里只是按结果走不同的路。',
    fail: '条件里比较了命令输入、聚合字段或数值——判断泄漏到了编排层。',
    how: '找到 when 引用的变量，确认它是某个 behavior / service / factory 步骤的 output。',
  },
  '模型对使用场景的回应是否充分？': {
    question: '这条旧的使用语句（会不会同时、会不会重复、一次几条、失败怎么处置、谁能看见）在模型里有没有一个明确的回应？',
    pass: '落点说清了系统怎么应对：同时改 → 版本号或状态守卫；重复触发 → 状态守卫或幂等；一次几条 → 命令的输入形状与部分失败的语义；失败处置 → 事件或错误；可见性 → 查询的范围。',
    fail: '只是挂了编号，落点的文字没有回应这条语句说的用法；或回应方式与语句矛盾（语句说两人可能同时改，模型没有任何守卫）。',
    how: '把语句拆成「谁、在什么情况下、做什么」，在落点里找对应的守卫、规则或输入；找不到就是不通过。',
  },
  '这条不变量是否需要另一个聚合才能成立？': {
    question: '这条聚合级不变量要成立，是否需要同时看另一个聚合的状态？',
    pass: '只涉及本聚合内部的成员（根、实体、值对象）。',
    fail: '需要另一个聚合的状态才能判定——这是边界信号，进入四条出路：合并、抽第三个聚合、最终一致、承认例外。',
    how: '数一数不变量里出现的名词，每个名词属于哪个聚合。',
  },
  '模型用的是词汇表的法定名吗？': {
    question: '模型里用的这个名字，是词汇表的法定名还是别名？',
    pass: '是法定名，或别名只出现在注释里。',
    fail: '模型元素用别名命名——改名，或在词汇表里把它升为法定名。',
    how: '对照词汇表的 name 与 aliases。',
  },
  '模型文字与代码注释是否同一个意思？': {
    question: '模型里的文字与代码注释是否同一个意思？',
    pass: '措辞不同但意思相同。',
    fail: '意思有出入——由人决定改模型还是改代码。',
    how: '两句并排读，找出多出来或少掉的条件。',
  },
  'writes.multiple': {
    question: '这个命令要在一个事务里写多个聚合，是有意为之吗？',
    options: ['合并：两者本该是一个聚合', '抽第三个聚合：让那条跨聚合的不变量有自己的家', '最终一致：先写一个、发事件、另一个跟进，失败补偿', '承认例外：保留并在 writesNote 写明理由'],
    how: '先问那条要求「同时改」的规则是什么、它必须在同一瞬间成立吗；答案决定走哪条路。',
  },
  'event.no-handler': {
    question: '这个事件没有任何处理者，它是终止事件（发出后无后续动作）吗？',
    pass: '是终止事件：驳回并写明。',
    fail: '本该有反应——补一条反应规则和事件处理。',
    how: '回到业务描述找「当 … 时」的反应规则。',
  },
}

// ---------- 结果收集 ----------
function makeReport(direction) {
  return { direction, project: root, slice: sliceId, at: new Date().toISOString(), decodedVersion: null, guides: GUIDES, errors: [], warnings: [], confirms: [], judgments: [], decided: [], blindSpots: [], conclusion: null }
}
const decisions = [] // 全部模型文件的 decisions[]
const decFile = new Map() // 每一条裁决出自哪个文件（重新定基时要写回去）
const staleSeen = [] // 这一趟遇到的过期裁决：{ dec, text }
const decStats = { 问过: 0, 压根没人裁过: 0, 指纹对上: 0, 挪位对上: 0, 没带指纹就认了: 0, 过期: 0 }
/** 裁决对象的指纹：文字变了裁决即过期 */
function fingerprint(text) {
  return require('node:crypto').createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8)
}
function decidedFor(target, check, text, siblingFps) {
  decStats.问过++
  // 只认人裁的。角色自己记的理由留在文件里备查，但不能替人把这一条盖过去。
  let mine = decisions.filter((d) => d.target === target && d.check === check && d.by !== 'role')
  const fp = fingerprint(text)
  // 同一个目标名下可能有好几条（一个聚合根的多条聚合级不变量 target 都一样）：
  // 先认指纹对得上自己这段文字的那一条，认不到再退回没带指纹的那条。
  const byFp = mine.find((x) => x.on === fp)
  if (byFp) { decStats.指纹对上++; return byFp }
  // 步骤类目标（…#steps.N）的裁决按下标挂着；中间插一步或重排，下标全体错位。
  // 文字一个字没变的那一步，它的裁决在同一个处理器的别的下标上——按指纹认回来，不再问第二遍。
  const m = /^(.*)#steps\.\d+$/.exec(target)
  if (m) {
    const moved = decisions.find((d) => d.check === check && d.by !== 'role' && d.on === fp && d.target !== target && d.target.startsWith(m[1] + '#steps.'))
    if (moved) { decStats.挪位对上++; return { ...moved, target } }
    // 挂在这个下标上、指纹却对得上别的一步现在的文字的，是别人的裁决——不拿来当这一步的「上次裁决」，那只会把人看糊涂
    if (siblingFps) mine = mine.filter((d) => !d.on || !siblingFps.has(d.on))
  }
  if (!mine.length) { decStats.压根没人裁过++; return null }
  // 老裁决没带指纹：认不出它是对着哪一版文字裁的，只能照认
  const noFp = mine.find((x) => !x.on)
  if (noFp) { decStats.没带指纹就认了++; return noFp }
  // 有人裁过，但裁的是另一版文字——这是**过期**，不是「没人裁过」。
  // 当成没人裁过会把人拍过的板悄悄丢掉：同一件事再问一遍，而没人知道它问过。
  // 同一个目标名下裁过好几次的，拿最近那一次当作过期的那一条。
  decStats.过期++
  const latest = mine.slice().sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? ""))).pop()
  staleSeen.push({ dec: latest, text })
  return { ...latest, stale: true }
}
function add(report, level, check, target, text, extra = {}) {
  const item = { check, target, text, on: fingerprint(text), ...extra }
  const d = decidedFor(target, check, text)
  if (d?.stale) item.staleDecision = { verdict: d.verdict, note: d.note, at: d.at }
  // 覆盖类是「范围」问题，范围由人裁定，所以它的错误可被裁决抑制；
  // 结构类错误（解析失败、追溯不存在、调用无法解析、比对差异等）不可抑制，必须修。
  const dismissible = level !== 'error' || check.startsWith('coverage.')
  if (d && !d.stale && dismissible) {
    report.decided.push({ ...item, verdict: d.verdict, note: d.note, at: d.at })
    return
  }
  if (level === 'error') report.errors.push(item)
  else if (level === 'warning') report.warnings.push(item)
  else report.confirms.push(item)
}
function judge(report, check, target, sides, importance, related, extra = {}) {
  const on = fingerprint(sides.model)
  const d = decidedFor(target, check, sides.model, extra.siblings)
  const item = { target, check, sides, verdict: null, importance, confidence: null, reason: '', on }
  if (related) item.related = related
  if (extra.context) item.context = extra.context // 这一条在哪个命令的第几步：给人读的，不参与指纹与判断键
  if (extra.ask) item.ask = extra.ask // 针对这一条的具体问题（给人读的；check 仍是类别，作指南与裁决的键）
  if (d?.stale) item.staleDecision = extra.reordered
    ? { at: d.at, reordered: true } // 这个处理器的步骤重排过：挂在这个下标上的旧裁决多半讲的是别的一步，旧说明不摆出来把人看糊涂
    : { verdict: d.verdict, note: d.note, at: d.at }
  if (d && !d.stale) {
    report.decided.push({ check, target, text: sides.model, verdict: d.verdict, note: d.note, at: d.at })
    return
  }
  report.judgments.push(item)
}

// ---------- 加载 ----------
const project = loadProject(root)
const { business, glossary, model } = project
for (const el of model.elements) for (const d of el.data?.decisions ?? []) { decisions.push(d); decFile.set(d, el.file) }
for (const mf of model.moduleFiles) for (const d of mf.data.decisions ?? []) { decisions.push(d); decFile.set(d, mf.file) }
for (const d of model.modules?.data.decisions ?? []) { decisions.push(d); decFile.set(d, model.modules.file) }

const byId = new Map(business.map((s) => [s.id, s]))
// 切片范围：切片记录里 traces 非空时，覆盖检查只针对范围内的业务语句。
// 范围外的语句本轮本来就还没有落点，报错等于要求一次建完全部模型。
const sliceRec = sliceId ? (project.slices ?? []).map((s) => s.data).find((s) => s.id === sliceId) : null
const scopeIds = sliceRec?.traces?.length ? new Set(sliceRec.traces) : null
const inScope = (id) => !scopeIds || scopeIds.has(id)
// 聚合粗版（module.json 的 aggregates / members / idRefs）是战略设计时人确认的路标，段落建到哪个聚合再细化哪个（seed/slices.md）。
// 带 --slice 时，切片 scope 之外还没建的聚合、成员、引用与范围外模块的空追溯不算错，记进 report.deferred 给人看个数。
const scopeAggs = sliceRec?.scope?.aggregates?.length ? new Set(sliceRec.scope.aggregates) : null
const scopeMods = sliceRec?.scope?.modules?.length ? new Set(sliceRec.scope.modules) : null
const qualify = (name, mod) => (name.includes('.') ? name : `${mod}.${name}`)
const defer = (kind, target, text, report = r1) => { (report.deferred ??= []).push({ kind, target, text }) }
// 方向 ②：解码比对里落在切片范围外的文件（别的模块、本段没建的聚合）不算错，记 deferred——和方向 ① 的粗版处理同一口径
function outOfScope(file) {
  if (!sliceRec || !file) return false
  const parts = String(file).replaceAll('\\', '/').replace(/^model\//, '').split('/')
  if (parts.length < 2) return false // modules.json 这类根文件
  const mod = parts[0]
  if (scopeMods && !scopeMods.has(mod)) return true
  if (scopeAggs && parts[1] === 'domain' && parts.length >= 4) {
    const folder = parts[2]
    const rootEl = els.find((e) => e.kind === 'aggregate-root' && e.module === mod && e.aggregateFolder === folder)
    if (rootEl && !scopeAggs.has(`${mod}.${rootEl.data.name}`)) return true
    if (!rootEl) return true // 这个目录里没有聚合根文件：本段没建到的粗版聚合
  }
  return false
}
const goals = business.filter((s) => s.kind === 'goal' && inScope(s.id))
const rules = business.filter((s) => s.kind === 'rule' && inScope(s.id))
const usages = business.filter((s) => s.kind === 'usage' && inScope(s.id))
const els = model.elements.filter((e) => e.kind !== 'invalid')
const of = (kind) => els.filter((e) => e.kind === kind)
const roots = of('aggregate-root')
const entities = of('entity')
const vos = of('value-object')
const events = of('event')
const errors = of('error')
const repos = of('repository')
const services = of('service')
const commands = of('command-handler')
const queries = of('query-handler')
const handlers = of('event-handler')
const ports = of('port')
const domainObjects = [...roots, ...entities, ...vos]

function qname(el) {
  return `${el.module}.${el.data.name}`
}
/** 解析可带模块前缀的名字 → 该种类的元素 */
function find(kinds, name, currentModule) {
  const [mod, nm] = name.includes('.') ? name.split('.') : [currentModule, name]
  return els.find((e) => kinds.includes(e.kind) && e.module === mod && e.data.name === nm) ?? null
}
function stepCalls(steps) {
  return (steps ?? []).filter((s) => s.call).map((s) => s.call)
}
function raiseKey(r) {
  return typeof r === 'string' ? r : `${r.event}|${r.when}`
}

// ========== 方向 ① ==========
const r1 = makeReport(1)
r1.blindSpots = ['判断类检查未在此执行，见 judgments[]', '业务描述的名词是否漏建模：仅列为判断项']

// 前置：schema
const schemaRun = spawnSync(process.execPath, [path.join(devTeam, 'tools', 'check-schema.js'), root], { encoding: 'utf8' })
if (schemaRun.status !== 0) {
  for (const line of schemaRun.stdout.split('\n').filter((l) => l.startsWith('✗'))) add(r1, 'error', 'schema', line.slice(2).trim(), '不符合 schema（详见 check-schema）')
}
for (const el of model.elements.filter((e) => e.kind === 'invalid')) add(r1, 'error', 'schema', el.file, `JSON 解析失败：${el.error}`)

// 标签：层与文件对得上、字母与种类对得上、分层文件里每条都标了层（agents/business/layers.md）
let unlayered = 0
for (const s of business) {
  if (!inScope(s.id)) continue
  if (s.unknownLabel) add(r1, 'error', 'label.unknown', s.id, `标签认不得：(${s.unknownLabel.join('-')})——层只有 ${LAYERS.join(' / ')}，种类只有 ${Object.keys(KINDS).join(' / ')}`)
  if (s.labelLayer && s.fileLayer && s.labelLayer !== s.fileLayer) add(r1, 'error', 'label.layer-file', s.id, `标签写的是「${s.labelLayer}」，却放在 ${s.file}`)
  if (s.ruleKind && KINDS[s.ruleKind] && KINDS[s.ruleKind] !== s.id[0]) add(r1, 'error', 'label.kind-letter', s.id, `种类「${s.ruleKind}」只能标在 ${KINDS[s.ruleKind]} 开头的编号上`)
  if (s.kind === 'usage' && s.labelLayer === '业务抽象') add(r1, 'error', 'label.usage-layer', s.id, '旧的使用语句只可能是业务落地')
  if (s.fileLayer && !s.labelLayer) add(r1, 'error', 'label.missing-layer', s.id, `${s.file} 是分层文件，每条语句都要标层：(${s.fileLayer}-种类)`)
  if (!s.fileLayer && !s.labelLayer) unlayered++
}
if (unlayered) add(r1, 'warning', 'label.unlayered', 'business/', `${unlayered} 条语句还没分层（老布局；按段落点亮时补标签、搬进 business/<Module>/abstraction.md 或 practice.md）`)

// 模型分步建（第九十五、九十七批，seed/slices.md「模型怎么建」）：校验 ① 只查本步及之前该落的种类，还没到的种类不报错、单列「留给后面」。
// 模块切片的骨架初稿只有字段，事实才有落点；业务走查加约束、公式、情形；段落切片（应用层，没有 pass）全查。
const pass = sliceRec?.pass ?? '应用'
const PASS_KINDS = { 骨架: new Set(['事实']), 行为: new Set(['事实', '约束', '公式', '情形']), 应用: null }
const NEXT_PASS = { 骨架: '业务走查', 行为: '应用层（段落切片）' }
const passAllows = (kind) => !PASS_KINDS[pass] || !kind || PASS_KINDS[pass].has(kind)
// 覆盖：能力 → 命令/查询（命令与查询是应用遍的东西）
for (const g of goals) {
  const hit = [...commands, ...queries].some((e) => e.data.traces.includes(g.id))
  if (!hit) {
    if (pass !== '应用') { defer('coverage.pass', g.id, `能力的落点是命令 / 查询，留给应用层的段落切片：${g.text}`); continue }
    add(r1, 'error', 'coverage.goal', g.id, `能力没有任何命令或查询追溯：${g.text}`)
  }
}
// 覆盖：规则 → 按种类的落点
const sig = (name, input, output) => `${name}(${(input ?? []).map((p) => `${p.name}: ${p.type}`).join(', ')})${output ? ` → ${output}` : ''}`
// 规则可以标明自己管哪几个编号。问某一条业务语句时，只摆标了这个编号的那几条，
// 加上没标编号的（那些是这个方法的底子，摆哪条都得带上）；其余的收起来，只报个数。
// 不这么做的话，一个挂了七八个编号的方法，问哪一条都要把整块端给人读一遍。
const ruleText = (r) => (typeof r === 'string' ? r : r.text)
const ruleTraces = (r) => (typeof r === 'string' ? null : r.traces)
const rulesText = (rules, id) => {
  const all = rules ?? []
  const keep = id ? all.filter((r) => { const tr = ruleTraces(r); return !tr || tr.includes(id) }) : all
  const hidden = all.length - keep.length
  const body = keep.length ? keep.map((r) => ruleText(r) + carriesOf(r, id)).join('；') : '（无）'
  return `规则：${body}` + (hidden ? `（这个方法另有 ${hidden} 条规则，管的是别的编号，未列出）` : '')
}
const throwsText = (t) => (t.length ? `　抛出：${t.join(', ')}` : '')
const raisesText = (r) => (r.length ? `　发出：${r.map((x) => (typeof x === 'string' ? x : `${x.event}（${x.when}）`)).join(', ')}` : '')
// 错误的条件、命令的步骤，跟规则一样：标了编号的按编号挑，没标的每次都摆，藏起来的报个数
// 一条业务语句落在好几处时，每一处说一句自己承担哪一半（模型里的 carries）
const carriesOf = (x, id) => { const c = x && x.carries && id ? x.carries[id] : null; return c ? `〔本处承担：${c}〕` : '' }
const pickText = (items, id, sep) => {
  const all = Array.isArray(items) ? items : [items]
  const one = (x) => (typeof x === 'string' ? x : x.text)
  const tr = (x) => (typeof x === 'string' ? null : x.traces)
  const keep = id ? all.filter((x) => { const q = tr(x); return !q || q.includes(id) }) : all
  const hidden = all.length - keep.length
  return keep.map((x) => one(x) + carriesOf(x, id)).join(sep) + (hidden ? `（另有 ${hidden} 处管的是别的编号，未列出）` : '')
}
/**
 * 这个方法（或领域服务的操作）承不承载这条业务语句：自己挂着这个编号算，**里面哪一条规则挂着也算**。
 * 规则可以各自标自己管哪几个编号（`rulesText` 就是按这个挑的），可认落点这一步早先只看方法自己那一层，
 * 于是只写在规则上的追溯谁也看不见——语句被当成「没有落点」，再被种类归进「留给后面的遍」，一路无声绕过所有人。
 * 2026-09-16 k-001 真出过：R-103（共付比例往高往低两种改法）、R-118、R-119（先动哪一本账）三条规则早就写好了，
 * 却因为追溯只挂在规则上而没人判。
 */
const tracedHere = (m, id) => (m.traces ?? []).includes(id) || (m.rules ?? []).some((r) => typeof r !== 'string' && (r.traces ?? []).includes(id))

function ruleLandings(id) {
  const out = []
  for (const el of domainObjects) {
    const objLabel = { 'aggregate-root': '聚合根', entity: '实体', 'value-object': '值对象' }[el.kind]
    for (const inv of el.data.aggregateInvariants ?? []) if (inv.traces.includes(id)) out.push({ kind: 'invariant', el, label: `聚合 ${el.data.name} 的规则`, text: `聚合 ${el.data.name} 的规则：${inv.text}${carriesOf(inv, id)}` })
    for (const inv of el.data.invariants) if (inv.traces.includes(id)) out.push({ kind: 'invariant', el, label: `${el.data.name} 的规则`, text: `${objLabel} ${el.data.name} 的规则：${inv.text}${carriesOf(inv, id)}${throwsText(inv.throws ?? [])}` })
    for (const b of el.data.behaviors) if (tracedHere(b, id)) out.push({ kind: b.throws.length ? 'behavior-guard' : 'behavior', el, label: `${el.data.name}.${b.name}`, text: `${el.data.name}.${sig(b.name, b.input, b.output)}　${rulesText(b.rules, id)}${raisesText(b.raises)}${throwsText(b.throws)}` })

    // 字段也是模型的落点：聚合上记着什么、每一栏干什么用，跟不变量一样在承载业务
    for (const f of el.data.fields ?? []) if ((f.traces ?? []).includes(id)) out.push({ kind: 'field', el, label: `${el.data.name} 的字段 ${f.name}`, text: `${objLabel} ${el.data.name} 的字段 ${f.name}: ${f.type}${f.nullable ? '（可空）' : ''}${f.note ? `　${f.note}` : ''}` })
  }
  for (const s of services) for (const op of s.data.operations) if (tracedHere(op, id)) out.push({ kind: 'service', el: s, label: `领域服务 ${s.data.name}.${op.name}`, text: `领域服务 ${s.data.name}.${sig(op.name, op.input, op.output)}　${rulesText(op.rules, id)}${throwsText(op.throws)}` })
  for (const h of handlers) if (h.data.traces.includes(id)) out.push({ kind: 'event-handler', el: h, label: `事件处理 ${h.data.name}`, text: `事件处理 ${h.data.name}（触发：${h.data.trigger}）：${h.data.steps.map((s) => s.text).join(' → ')}` })
  for (const e of errors) if (e.data.traces.includes(id)) out.push({ kind: 'error', el: e, label: `错误 ${e.data.name}`, text: `错误 ${e.data.name}：${e.data.condition ? pickText(e.data.condition, id, '；') : '（无条件说明）'}` })
  // 端口也是落点：描述我方系统之外的业务流程（政府门户上收到转介）的事实落在边界上，不落聚合（agents/model/shapes.md；验收项目第六十八批）
  for (const p of ports) if ((p.data.traces ?? []).includes(id)) out.push({ kind: 'port', el: p, label: `端口 ${p.data.name}`, text: `端口 ${p.data.name}（${p.data.kind === 'external-system' ? '外部系统' : '模块'} ${p.data.target}）：${(p.data.operations ?? []).map((op) => `${op.name}${op.note ? '——' + op.note : ''}`).join('；')}` })
  return out
}
// 种类 → 该落在哪种元素上（只是提醒，报警告）。消息里用文件里写的那个词（rawKind），旧标签的语句指纹才对得上以前的裁决：事实落字段或结构性的不变量；约束落不变量、守卫、错误；公式落计算；触发落事件处理
const EXPECTED = { 事实: ['field', 'invariant', 'behavior', 'port'], 约束: ['invariant', 'behavior-guard', 'error', 'field'], 公式: ['behavior', 'behavior-guard', 'service', 'field'], 触发: ['event-handler', 'port'], 流程: ['behavior-guard', 'invariant', 'error', 'command', 'port', 'service'], 情形: ['behavior', 'behavior-guard', 'invariant', 'error', 'field', 'command'] }
// 本段只作背景的语句：故事里讲到它，可本段没有能承载它的动作（次序、核对这类要等后面的段落）。
// 切片里写明编号与理由，校验器就不因「没有落点」报错——但记进 deferred 单列出来，谁也别忘了它还欠着。
const background = new Map((sliceRec?.backgroundTraces ?? []).map((b) => [b.id, b.why]))
for (const r of rules) {
  const landings = ruleLandings(r.id)
  if (!landings.length) {
    if (background.has(r.id)) { defer('coverage.background', r.id, `本段只作背景，落点等后面的段落：${background.get(r.id)}`); continue }
    if (!passAllows(r.ruleKind)) { defer('coverage.pass', r.id, `种类「${r.rawKind ?? r.ruleKind}」的落点留给${NEXT_PASS[pass] ?? '后面的遍'}：${r.text}`); continue }
    add(r1, 'error', 'coverage.rule', r.id, `规则没有任何落点：${r.text}`)
    continue
  }
  if (background.has(r.id)) add(r1, 'warning', 'coverage.background', r.id, `切片把它记成本段只作背景，模型里却给了落点：要么去掉切片里那一条，要么去掉落点`)
  if (r.ruleKind && EXPECTED[r.ruleKind] && !landings.some((l) => EXPECTED[r.ruleKind].includes(l.kind))) {
    add(r1, 'warning', 'coverage.rule-kind', r.id, `规则种类「${r.rawKind ?? r.ruleKind}」的落点应为 ${EXPECTED[r.ruleKind].join(' / ')}，实际只有 ${[...new Set(landings.map((l) => l.kind))].join(' / ')}`)
  }
  // 一条业务语句一条判断：模型侧列出全部落点及其完整上下文
  const importance = landings.some((l) => ['invariant', 'behavior-guard', 'error', 'behavior'].includes(l.kind)) ? 'high' : 'medium'
  const where = [...new Set(landings.map((l) => l.label).filter(Boolean))]
  const ask = `${r.id}「${r.text}」——模型把它写在 ${where.join('、') || '这几处'}。这几处合起来是不是把这句话说全了？有没有多加限制、少了条件，或方向反了？`
  judge(r1, '模型规则是否与业务一致？', r.id, { business: `[${r.id}]${labelOf(r) ? ` (${labelOf(r)})` : ''} ${r.text}`, model: landings.map((l) => l.text).join('\n') }, importance, [...new Set(landings.map((l) => l.el.file))], { ask })
}
// 覆盖：旧的使用语句（U，已停发，老项目里还有）→ 落点不限种类，但必须有；一条一判。新项目按五问问出来的情形是普通的 R（种类「情形」），走上面那条路
function usageLandings(id) {
  const out = ruleLandings(id)
  for (const c of commands) if (c.data.traces.includes(id)) out.push({ kind: 'command', el: c, text: `命令 ${c.data.name}（输入：${(c.data.input ?? []).map((p) => p.name).join(', ') || '无'}）：${pickText(c.data.steps, id, ' → ')}` })
  for (const q of queries) if (q.data.traces.includes(id)) out.push({ kind: 'query', el: q, text: `查询 ${q.data.name}（输入：${(q.data.input ?? []).map((p) => p.name).join(', ') || '无'}）` })
  return out
}
for (const u of usages) {
  const landings = usageLandings(u.id)
  if (!landings.length) {
    add(r1, 'error', 'coverage.usage', u.id, `旧的使用语句没有任何落点（模型必须回应系统会被怎么用）：${u.text}`)
    continue
  }
  judge(r1, '模型对使用场景的回应是否充分？', u.id, { business: `[${u.id}] (${labelOf(u)}) ${u.text}`, model: landings.map((l) => l.text).join('\n') }, 'high', [...new Set(landings.map((l) => l.el.file))], { ask: `${u.id}「${u.text}」——模型在 ${[...new Set(landings.map((l) => l.label).filter(Boolean))].join('、') || '这几处'} 的回应，够不够应付这种用法？` })
}
// 追溯反向：每个元素 traces 非空且存在
function checkTraces(target, traces, level = 'error') {
  if (!traces || !traces.length) return add(r1, level, 'traces.empty', target, 'traces 为空')
  for (const t of traces) if (!byId.has(t)) add(r1, 'error', 'traces.unknown', target, `追溯编号不存在：${t}`)
}
for (const el of [...domainObjects, ...events, ...errors, ...ports, ...commands, ...queries, ...handlers]) checkTraces(el.file, el.data.traces)
for (const el of domainObjects) for (const b of el.data.behaviors) checkTraces(`${el.file}#behaviors.${b.name}`, b.traces)
for (const s of services) for (const op of s.data.operations) checkTraces(`${s.file}#operations.${op.name}`, op.traces)
for (const m of model.modules?.data.modules ?? []) { if (scopeMods && !scopeMods.has(m.name) && !(m.traces ?? []).length) defer('traces.empty', `${model.modules.file}#${m.name}`, `模块 ${m.name} 本段外未建，追溯待填`); else checkTraces(`${model.modules.file}#${m.name}`, m.traces, 'warning') }
for (const g of goals) {
  const ucs = [...commands, ...queries].filter((x) => x.data.traces.includes(g.id))
  if (!ucs.length) continue
  const lines = ucs.map((e) => {
    const kind = e.kind === 'query-handler' ? '查询' : '命令'
    const steps = e.data.steps.map((s) => (s.when ? `[${s.when}] ${s.text}` : s.text)).join(' → ')
    const result = e.kind === 'query-handler' ? `　返回：${e.data.result.map((p) => p.name).join(', ')}` : ''
    return `${kind} ${e.data.name}（${e.data.actor}；输入：${e.data.input.map((p) => p.name).join(', ')}）：${steps}${result}`
  })
  const ucNames = ucs.map((e) => `${e.kind === 'query-handler' ? '查询' : '命令'} ${e.data.name}（${e.data.steps.length} 步）`).join('、')
  judge(r1, '用例是否按步骤完成了业务目标？', g.id, { business: `[${g.id}]${labelOf(g) ? ` (${labelOf(g)})` : ''} ${g.text}`, model: lines.join('\n') }, 'medium', ucs.map((e) => e.file), { ask: `${g.id}「${g.text}」——${ucNames} 走完，这件事真的做成了吗？有没有缺一步（该通知没通知、该存没存），或者做的其实是另一件事？` })
}

// 命名：名词在词汇表
const terms = new Set(glossary.terms.map((t) => t.name))
for (const el of [...domainObjects, ...errors, ...events]) if (!terms.has(el.data.name)) add(r1, 'error', 'glossary.noun', el.file, `名字不在词汇表中：${el.data.name}`)
for (const t of glossary.terms) for (const a of t.aliases) if (/^[A-Z][A-Za-z0-9]*$/.test(a) && els.some((e) => e.data.name === a)) judge(r1, '模型用的是词汇表的法定名吗？', `glossary#${t.name}`, { business: `${t.name}（别名 ${a}）`, model: a }, 'low')

// 模型内部一致性
function resolveCall(call, currentModule, allowMembers) {
  const targetKinds = { behavior: allowMembers ? ['aggregate-root', 'entity', 'value-object'] : ['aggregate-root'], factory: ['aggregate-root', 'entity', 'value-object'], service: ['service'], repository: ['repository'], port: ['port'], command: ['command-handler'] }[call.kind]
  const el = find(targetKinds, call.target, currentModule)
  if (!el) return { el: null, reason: `目标不存在或种类不符：${call.kind} ${call.target}` }
  let ok = false
  if (call.kind === 'behavior') ok = el.data.behaviors.some((b) => b.name === call.method)
  else if (call.kind === 'factory') ok = /^[A-Z][A-Z0-9_]*$/.test(call.method)
  else if (call.kind === 'service') ok = el.data.operations.some((o) => o.name === call.method)
  else if (call.kind === 'repository') ok = el.data.methods.some((m) => m.name === call.method)
  else if (call.kind === 'port') ok = el.data.operations.some((o) => o.name === call.method)
  else if (call.kind === 'command') ok = call.method === 'execute'
  return ok ? { el } : { el, reason: `方法不存在：${call.target}.${call.method}` }
}
/** 行为 / 服务操作的 raises、throws 传递闭包（按模型自身的声明） */
function closureOf(call, currentModule, seen = new Set()) {
  const key = `${call.kind}:${call.target}.${call.method}`
  if (seen.has(key)) return { raises: [], throws: [] }
  seen.add(key)
  const { el } = resolveCall(call, currentModule, true)
  if (!el) return { raises: [], throws: [] }
  if (call.kind === 'factory') return { raises: [], throws: [...(el.data.aggregateInvariants ?? []), ...el.data.invariants].flatMap((i) => i.throws ?? []) }
  if (call.kind === 'behavior') {
    const b = el.data.behaviors.find((x) => x.name === call.method)
    return b ? { raises: b.raises, throws: b.throws } : { raises: [], throws: [] }
  }
  if (call.kind === 'service') {
    const op = el.data.operations.find((x) => x.name === call.method)
    return op ? { raises: op.raises, throws: op.throws } : { raises: [], throws: [] }
  }
  if (call.kind === 'command') return { raises: el.data.raises, throws: el.data.throws }
  return { raises: [], throws: [] }
}
function checkUseCase(el, { allowMembers, queryOnly, hasWrites }) {
  const steps = el.data.steps
  const outputs = []
  const union = { raises: new Map(), throws: new Set() }
  const touched = new Set()
  const repoWrites = new Set()
  const cross = []
  const stepFps = new Set(steps.map((x) => fingerprint(x.text)))
  const reordered = steps.some((x, i) => { const fp = fingerprint(x.text); return decisions.some((d) => d.by !== 'role' && d.on === fp && d.target.startsWith(el.file + '#steps.') && d.target !== `${el.file}#steps.${i}`) })
  const HANDLER = { 'command-handler': '命令', 'query-handler': '查询', 'event-handler': '事件处理' }
  const stepContext = (i) => `${HANDLER[el.kind] ?? el.kind} ${el.data.name} · 第 ${i + 1} 步，共 ${steps.length} 步${i ? `（上一步：${steps[i - 1].text.slice(0, 40)}${steps[i - 1].text.length > 40 ? '…' : ''}）` : ''}`
  steps.forEach((s, i) => {
    if (s.when && s.when !== '否则' && !outputs.some((o) => s.when.includes(o))) add(r1, 'error', 'step.when', `${el.file}#steps.${i}`, `when 未引用前面某步的 output：${s.when}`)
    if (s.output) outputs.push(s.output)
    if (!s.call) return
    if (s.call.target.includes('.')) cross.push(s.call)
    if (queryOnly && s.call.kind !== 'repository') add(r1, 'error', 'query.read-only', `${el.file}#steps.${i}`, `查询只能调用仓储：${s.call.kind} ${s.call.target}.${s.call.method}`)
    const r = resolveCall(s.call, el.module, allowMembers)
    if (!r.el) return add(r1, 'error', 'call.unresolved', `${el.file}#steps.${i}`, r.reason)
    if (r.reason) add(r1, 'error', 'call.unresolved', `${el.file}#steps.${i}`, r.reason)
    if (s.call.kind === 'behavior' && !allowMembers && r.el.kind !== 'aggregate-root') add(r1, 'error', 'step.behavior-root-only', `${el.file}#steps.${i}`, `处理器只能调用聚合根的行为：${s.call.target}`)
    if (s.call.kind === 'repository') {
      const m = r.el.data.methods.find((x) => x.name === s.call.method)
      if (queryOnly && m && m.kind !== 'read') add(r1, 'error', 'query.read-only', `${el.file}#steps.${i}`, `查询调用了写方法：${s.call.target}.${s.call.method}`)
      if (m && m.kind === 'write') repoWrites.add(r.el.data.aggregate)
      touched.add(r.el.data.aggregate)
    }
    if (s.call.kind === 'behavior' && r.el.kind === 'aggregate-root') touched.add(r.el.data.name)
    if (s.call.kind === 'service') {
      const op = r.el.data.operations.find((x) => x.name === s.call.method)
      for (const w of op?.writes ?? []) touched.add(w)
    }
    const c = closureOf(s.call, el.module)
    for (const x of c.raises) union.raises.set(raiseKey(x), x)
    for (const x of c.throws) union.throws.add(x)
    if (s.when) judge(r1, '分流条件是否只引用了领域调用的结果？', `${el.file}#steps.${i}`, { model: `${s.when} → ${s.text}` }, 'medium', undefined, { context: stepContext(i), reordered, ask: `${HANDLER[el.kind] ?? el.kind} ${el.data.name} 第 ${i + 1} 步的分流条件「${s.when}」——它只引用了上一步领域调用的结果吗？有没有直接比较输入或字段？` })
    judge(r1, '步骤是否只是编排，没有夹带业务判断？', `${el.file}#steps.${i}`, { model: s.text }, 'medium', undefined, { context: stepContext(i), siblings: stepFps, reordered, ask: `${HANDLER[el.kind] ?? el.kind} ${el.data.name} 第 ${i + 1} 步「${s.text}」——这一步只是取、交给、存、发吗？有没有自己做「如果 / 比对 / 算数」这种业务判断？判断该住在聚合或领域服务里。` })
  })
  for (const c of cross) add(r1, 'error', 'cross-module.call', el.file, `跨模块调用只能经端口或事件：${c.kind} ${c.target}.${c.method}`)
  if (!queryOnly) {
    const declaredR = new Set((el.data.raises ?? []).map(raiseKey))
    const declaredT = new Set(el.data.throws ?? [])
    for (const k of union.raises.keys()) if (!declaredR.has(k)) add(r1, 'error', 'usecase.raises', el.file, `raises 缺少被调用行为所发出的事件：${k}`)
    for (const k of declaredR) if (!union.raises.has(k)) add(r1, 'error', 'usecase.raises', el.file, `raises 多出未被任何步骤发出的事件：${k}`)
    for (const k of union.throws) if (!declaredT.has(k)) add(r1, 'error', 'usecase.throws', el.file, `throws 缺少被调用行为抛出的错误：${k}`)
    for (const k of declaredT) if (!union.throws.has(k)) add(r1, 'error', 'usecase.throws', el.file, `throws 多出未被任何步骤抛出的错误：${k}`)
  }
  if (hasWrites) {
    const w = new Set(el.data.writes)
    for (const x of repoWrites) if (!w.has(x)) add(r1, 'error', 'usecase.writes', el.file, `writes 缺少被仓储保存的聚合：${x}`)
    for (const x of w) if (!touched.has(x)) add(r1, 'error', 'usecase.writes', el.file, `writes 中的聚合没有被任何步骤触及：${x}`)
    if (el.data.writes.length > 1) add(r1, 'confirm', 'writes.multiple', el.file, `一个事务写多个聚合：${el.data.writes.join('、')}`, { options: ['合并为一个聚合', '抽第三个聚合持有该不变量', '改为最终一致（事件 + 补偿）', '承认例外（保留 writesNote）'], note: el.data.writesNote ?? '' })
  }
}
for (const c of commands) checkUseCase(c, { allowMembers: false, queryOnly: false, hasWrites: true })
for (const q of queries) checkUseCase(q, { allowMembers: false, queryOnly: true, hasWrites: false })
for (const h of handlers) checkUseCase(h, { allowMembers: false, queryOnly: false, hasWrites: true })
for (const s of services) {
  const modAggs = new Set(roots.filter((r) => r.module === s.module).map((r) => r.data.name))
  for (const c of s.data.coordinates) if (!modAggs.has(c)) add(r1, 'error', 'service.coordinates', s.file, `coordinates 不是本模块的聚合：${c}`)
  for (const op of s.data.operations) {
    for (const rd of op.reads) if (!s.data.coordinates.includes(rd)) add(r1, 'error', 'service.reads', `${s.file}#operations.${op.name}`, `reads 中的聚合不在 coordinates：${rd}`)
    op.steps.forEach((st, i) => {
      if (!st.call) return
      const r = resolveCall(st.call, s.module, true)
      if (!r.el || r.reason) add(r1, 'error', 'call.unresolved', `${s.file}#operations.${op.name}.steps.${i}`, r?.reason ?? '目标不存在')
      if (st.call.target.includes('.')) add(r1, 'error', 'cross-module.call', s.file, `领域服务不得跨模块：${st.call.target}`)
    })
  }
}
// 事件 / 错误的发布方
const raisedEvents = new Set()
const thrownErrors = new Set()
for (const el of domainObjects) {
  for (const b of el.data.behaviors) {
    for (const r of b.raises) raisedEvents.add(typeof r === 'string' ? r : r.event)
    for (const t of b.throws) thrownErrors.add(t)
  }
  for (const inv of [...(el.data.aggregateInvariants ?? []), ...el.data.invariants]) for (const t of inv.throws ?? []) thrownErrors.add(t)
}
for (const s of services) for (const op of s.data.operations) for (const t of op.throws) thrownErrors.add(t)
for (const e of events) if (!raisedEvents.has(e.data.name)) add(r1, 'error', 'event.no-publisher', e.file, `事件没有任何行为发出：${e.data.name}`)
for (const e of errors) if (!thrownErrors.has(e.data.name)) add(r1, 'error', 'error.no-publisher', e.file, `错误没有任何行为或不变量抛出：${e.data.name}`)
// 行为 raises/throws 里引用的事件/错误必须存在
for (const el of domainObjects) for (const b of el.data.behaviors) {
  for (const r of b.raises) if (!find(['event'], typeof r === 'string' ? r : r.event, el.module)) add(r1, 'error', 'behavior.raises.unknown', `${el.file}#behaviors.${b.name}`, `事件不存在：${typeof r === 'string' ? r : r.event}`)
  for (const t of b.throws) if (!find(['error'], t, el.module)) add(r1, 'error', 'behavior.throws.unknown', `${el.file}#behaviors.${b.name}`, `错误不存在：${t}`)
}
// 事件处理的 trigger、事件是否有处理者
const handled = new Set()
for (const h of handlers) {
  const ev = find(['event'], h.data.trigger, h.module)
  if (!ev) add(r1, 'error', 'handler.trigger', h.file, `trigger 指向不存在的事件：${h.data.trigger}`)
  else handled.add(qname(ev))
  const expected = h.data.name.split('On').pop()
  if (ev && ev.data.name !== expected) add(r1, 'error', 'handler.name', h.file, `类名中的事件 ${expected} 与 trigger ${h.data.trigger} 不一致`)
}
for (const e of events) if (!handled.has(qname(e))) add(r1, 'warning', 'event.no-handler', e.file, `事件没有任何处理者（可能是终止事件）：${e.data.name}`)
// module.json ↔ 文件；idRefs
for (const mf of model.moduleFiles) {
  const modRoots = roots.filter((r) => r.module === mf.module)
  const listed = new Set(mf.data.aggregates.map((a) => a.name))
  for (const r of modRoots) if (!listed.has(r.data.name)) add(r1, 'error', 'module.aggregates', mf.file, `聚合清单缺少 ${r.data.name}（存在 ${r.file}）`)
  for (const a of mf.data.aggregates) {
    const r = modRoots.find((x) => x.data.name === a.name)
    if (!r) {
      if (scopeAggs && !scopeAggs.has(`${mf.module}.${a.name}`)) defer('module.aggregates', mf.file, `粗版聚合 ${a.name} 本段外未建`)
      else add(r1, 'error', 'module.aggregates', mf.file, `聚合清单中的 ${a.name} 没有 aggregate-root 文件`)
      continue
    }
    const members = new Set([...entities, ...vos].filter((m) => m.module === mf.module && m.aggregateFolder === r.aggregateFolder).map((m) => m.data.name))
    for (const m of a.members) if (!members.has(m)) { if (scopeAggs) defer('module.members', `${mf.file}#${a.name}`, `粗版成员 ${m} 本段外未建`); else add(r1, 'error', 'module.members', `${mf.file}#${a.name}`, `members 中的 ${m} 没有实体 / 值对象文件`) }
    for (const m of members) if (!a.members.includes(m)) add(r1, 'error', 'module.members', `${mf.file}#${a.name}`, `members 缺少 ${m}`)
    for (const ref of a.idRefs) if (!find(['aggregate-root'], ref.to, mf.module)) {
      const refMod = qualify(ref.to, mf.module).split('.')[0]
      // 按模块一次建一个（第九十七批）：这个模块引用别的模块的聚合，而那个模块的模型还没建，是必然的，不是错。
      // 只要它在 modules.json 里（战略设计划过），就单列出来记着；modules.json 里都没有才是真错。
      const known = (model.modules?.data.modules ?? []).some((m) => m.name === refMod)
      if (scopeAggs && !scopeAggs.has(qualify(ref.to, mf.module))) defer('module.idRefs', `${mf.file}#${a.name}`, `idRef 指向的粗版聚合 ${ref.to} 本段外未建`)
      else if (scopeMods && !scopeMods.has(refMod) && known) defer('module.idRefs', `${mf.file}#${a.name}`, `idRef 指向 ${ref.to}，${refMod} 模块的模型还没建`)
      else add(r1, 'error', 'module.idRefs', `${mf.file}#${a.name}`, `idRef 指向不存在的聚合：${ref.to}`)
    }
  }
  if (!model.modules?.data.modules.some((m) => m.name === mf.module)) add(r1, 'error', 'modules.list', mf.file, `modules.json 未列出模块 ${mf.module}`)
}
for (const m of model.modules?.data.modules ?? []) {
  if (model.moduleFiles.some((mf) => mf.module === m.name)) continue
  // 该模块承接的语句全在切片范围之外 → 本轮本就不建它，不报错
  if (scopeIds && !(m.traces ?? []).some((t) => scopeIds.has(t))) continue
  add(r1, 'error', 'modules.list', model.modules.file, `模块 ${m.name} 没有 model/${m.name}/module.json`)
}
for (const el of els) if (el.data.module && el.data.module !== el.module) add(r1, 'error', 'module.field', el.file, `module 字段 ${el.data.module} 与所在目录 ${el.module} 不一致`)
for (const el of [...entities, ...vos, ...events, ...errors, ...repos]) {
  const root = roots.find((r) => r.module === el.module && r.aggregateFolder === el.aggregateFolder)
  if (root && el.data.aggregate !== root.data.name) add(r1, 'error', 'aggregate.field', el.file, `aggregate 字段 ${el.data.aggregate} 与所在文件夹的聚合根 ${root.data.name} 不一致`)
}
// 不变量跨聚合（判断）
for (const el of roots) for (const inv of el.data.aggregateInvariants ?? []) judge(r1, '这条不变量是否需要另一个聚合才能成立？', `${el.file}#aggregateInvariants`, { model: inv.text }, 'high')

finish(r1, 'validate-1')

// ========== 方向 ② ==========
if (codebase) {
  const r2 = makeReport(2)
  r2.blindSpots = ['实体封装的运行时行为、适配器的正确性、测试的充分性：不覆盖', '文字差异（rules / text / narrative / condition / when）只列为判断项']
  let sha = 'nogit'
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: codebase, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  const version = `${sha}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
  const decodedDir = path.join(root, 'model-decoded', version)
  r2.decodedVersion = version
  const system = model.modules?.data.system ?? ''
  const dec = spawnSync(process.execPath, [path.join(devTeam, 'tools', 'decode.js'), codebase, decodedDir, '--system', system], { encoding: 'utf8' })
  if (dec.status !== 0) {
    add(r2, 'error', 'decode.failed', codebase, dec.stderr || dec.stdout)
  } else {
    const issuesFile = path.join(decodedDir, '_decode-issues.json')
    if (fs.existsSync(issuesFile)) for (const i of JSON.parse(fs.readFileSync(issuesFile, 'utf8')).issues) add(r2, 'error', 'lint', i.file, i.text)
    const diffJson = path.join(root, 'reports', '_diff.json')
    fs.mkdirSync(path.dirname(diffJson), { recursive: true })
    spawnSync(process.execPath, [path.join(devTeam, 'tools', 'diff-model.js'), path.join(root, 'model'), decodedDir, '--json', diffJson], { encoding: 'utf8' })
    const TEXTUAL = /\/(rules\/\d+|text|aggregateNarrative|condition|when|note|responsibility)$/
    for (const f of JSON.parse(fs.readFileSync(diffJson, 'utf8')).findings) {
      const target = `${f.file}${f.path ? '#' + f.path : ''}`
      if (outOfScope(f.file)) { defer(`diff.${f.kind}`, target, '本段范围外，未建', r2); continue }
      // module.json 里粗版的成员、引用、本段没建的聚合：方向 ① 已按 --slice 不计，方向 ② 同一口径
      if (sliceRec && /module\.json$/.test(f.file) && f.path) {
        const mod = String(f.file).replace(/^model\//, '').split('/')[0]
        const m1 = f.path.match(/^\/aggregates\/([^/]+)\/(members|idRefs)(\/|$)/)
        const m2 = f.path.match(/^\/aggregates\/([^/]+)$/)
        if ((m1 && f.kind === 'missing') || (m2 && f.kind === 'missing' && scopeAggs && !scopeAggs.has(`${mod}.${m2[1]}`))) { defer(`diff.${f.kind}`, target, '粗版，本段范围外未建', r2); continue }
      }
      // 模型上的说明文字（note）是给人审模型看的，代码不照抄（第八十七批：注释讲行为与原因、不抄上下文）——模型有、代码没有不算差异；代码写了才比是不是一个意思
      if (f.kind === 'missing' && /\/note$/.test(f.path ?? '')) continue
      if (f.kind === 'changed' && TEXTUAL.test(f.path)) {
        judge(r2, '模型文字与代码注释是否同一个意思？', target, { model: f.model, code: f.code }, /aggregateNarrative|note|responsibility/.test(f.path) ? 'low' : /rules|condition/.test(f.path) ? 'high' : 'medium')
        continue
      }
      const label = { 'missing-file': '模型有、代码无（整个文件）', 'extra-file': '代码有、模型无（整个文件）', missing: '模型有、代码无', extra: '代码有、模型无', changed: '不一致' }[f.kind]
      add(r2, 'error', `diff.${f.kind}`, target, label, { model: f.model ?? undefined, code: f.code ?? undefined })
    }
    fs.rmSync(diffJson, { force: true })
  }
  finish(r2, 'validate-2')
}

// ---------- 结论与写出 ----------
/** 同一条判断项的身份：目标 + 检查项 + 双方的原文。原文变了就是新的一条，旧判断不该跟过来。 */
function judgeKey(x) {
  return [x.target, x.check, x.sides?.business ?? '', x.sides?.model ?? '', x.sides?.code ?? ''].join('\u0000')
}
/**
 * 重跑时把上一份报告里已经填好的判断与裁决接过来。
 * 校验角色填 verdict/confidence/reason 要花很久，人的裁决更是不可再生——
 * 从前这里无条件覆盖，跑一次全没了（角色文件的自检恰好又要求跑它）。
 * 只在「目标、检查项、双方原文」都一字不差时才接：任何一侧的文字变了就当作新的一条，重新判。
 */
/** 被顶掉的是另一条切片的报告就先存一份，别让它无声消失 */
function archivePrevious(dir, name, slice) {
  const p = path.join(dir, `${name}.json`)
  if (!fs.existsSync(p)) return
  let old
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return }
  if (!old.slice || old.slice === slice) return
  fs.copyFileSync(p, path.join(dir, `${name}.${old.slice}.json`))
  const md = path.join(dir, `${name}.md`)
  if (fs.existsSync(md)) fs.copyFileSync(md, path.join(dir, `${name}.${old.slice}.md`))
  console.log(`（${old.slice} 的上一份报告已存为 ${name}.${old.slice}.json）`)
}
function carryOver(report, name) {
  const dir = path.join(root, 'reports')
  // 当前那份是本切片的就读它（它最新）；是别的切片的，才回头找自己那份存档
  const live = path.join(dir, `${name}.json`)
  const liveIsMine = (() => {
    try { return JSON.parse(fs.readFileSync(live, 'utf8')).slice === report.slice } catch { return false }
  })()
  const p = liveIsMine ? live : path.join(dir, `${name}.${report.slice}.json`)
  if (!fs.existsSync(p)) return 0
  let old
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return 0 }
  if (old.slice !== report.slice || old.direction !== report.direction) return 0
  const by = new Map((old.judgments ?? []).map((x) => [judgeKey(x), x]))
  let kept = 0
  let renamedCarry = 0
  for (const j of report.judgments) {
    // 文字一个字没变的照样认得出；只因改名而变的，把新文字反着换回旧说法，
    // 换出来的与上一份一字不差才接过来——证不出来的不接，校验角色重判一遍
    let o = by.get(judgeKey(j))
    if (!o && unrename) {
      o = by.get(judgeKey({ target: j.target, check: j.check, sides: { business: unrename(j.sides?.business), model: unrename(j.sides?.model), code: j.sides?.code === undefined ? undefined : unrename(j.sides.code) } }))
      if (o) renamedCarry++
    }
    if (!o) continue
    if (o.verdict) { j.verdict = o.verdict; j.confidence = o.confidence; j.reason = o.reason; kept++ }
    if (o.human) j.human = o.human
  }
  // 盲区是校验角色写的，不是机械算出来的——重跑不该把它冲回内置的那两条
  if ((old.blindSpots ?? []).length > (report.blindSpots ?? []).length) report.blindSpots = old.blindSpots
  const oldConfirm = new Map((old.confirms ?? []).map((c) => [[c.check, c.target, c.text].join('\u0000'), c]))
  for (const c of report.confirms) {
    const o = oldConfirm.get([c.check, c.target, c.text].join('\u0000'))
    if (o?.human) c.human = o.human
  }
  // 这一轮没有任何待判断与需确认——能判的都已经在 decisions[] 里了，等于上一轮就写回过
  if (old.applied && !report.judgments.length && !report.confirms.length) report.applied = old.applied
  if (renamedCarry) console.log(`[校验] 这 ${renamedCarry} 条判断的文字只因改名而变（反着换回去一字不差），上一份填好的结论照样接过来，不重判`)
  return kept
}
function finish(report, name) {
  // 重新定基是一趟专门的活：只看哪些裁决过期了、能不能证明是纯改名，不碰报告
  if (rebaseFile) return
  report.judgments.sort((a, b) => rank(b.importance) - rank(a.importance))
  const kept = carryOver(report, name)
  // 已经裁决过的「需人确认」不再算作未清项——人已经拍过板了，报告不该因此永远不干净
  const openConfirms = report.confirms.filter((c) => !c.human?.verdict).length
  const open = report.errors.length + report.warnings.length + openConfirms
  report.conclusion = open === 0 ? 'clean' : 'not-clean'
  const dir = path.join(root, 'reports')
  fs.mkdirSync(dir, { recursive: true })
  archivePrevious(dir, name, report.slice)
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, `${name}.md`), renderMd(report))
  const j = report.judgments.length
  const blank = report.judgments.filter((x) => !x.verdict).length
  console.log(`方向 ${report.direction}：错误 ${report.errors.length} · 警告 ${report.warnings.length} · 需人确认 ${report.confirms.length} · 待判断 ${j}${kept ? `（沿用上一份已填的 ${kept} 条，还要填 ${blank} 条）` : ''} · 已裁决 ${report.decided.length}${report.deferred?.length ? ` · 本段外未建 ${report.deferred.filter((d) => d.kind !== 'coverage.background' && d.kind !== 'coverage.pass').length} 项（粗版，--slice 不计）` : ''}${report.deferred?.some((d) => d.kind === 'coverage.background') ? ` · 只作背景 ${report.deferred.filter((d) => d.kind === 'coverage.background').length} 条` : ''}${report.deferred?.some((d) => d.kind === 'coverage.pass') ? ` · 留给后面的遍 ${report.deferred.filter((d) => d.kind === 'coverage.pass').length} 条` : ''} → ${report.conclusion === 'clean' ? '干净' : '不干净'}（${path.relative(process.cwd(), path.join(dir, name + '.md'))}）`)
  if (report.conclusion !== 'clean') process.exitCode = 1
}
function rank(x) {
  return { high: 3, medium: 2, low: 1 }[x] ?? 0
}
function renderMd(r) {
  const L = []
  L.push(`# 校验报告 · 方向 ${r.direction}${r.direction === 1 ? '（模型 ↔ 业务描述）' : '（代码 ↔ 模型）'}`)
  L.push('')
  L.push(`- 项目：${r.project}`)
  if (r.slice) L.push(`- 切片：${r.slice}`)
  if (r.decodedVersion) L.push(`- 解码版本：${r.decodedVersion}`)
  L.push(`- 时间：${r.at}`)
  L.push(`- 错误 ${r.errors.length} · 警告 ${r.warnings.length} · 需人确认 ${r.confirms.length} · 待判断 ${r.judgments.length} · 已裁决 ${r.decided.length}`)
  L.push(`- **结论：${r.conclusion === 'clean' ? '干净' : '不干净'}**`)
  const section = (title, items, fmt) => {
    L.push('', `## ${title}`, '')
    if (!items.length) return L.push('（无）')
    items.forEach((it, i) => L.push(`${i + 1}. ${fmt(it)}`))
  }
  const show = (v) => (v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v))
  section('错误', r.errors, (e) => `\`${e.target}\` [${e.check}] ${e.text}${e.model !== undefined || e.code !== undefined ? `（模型 ${show(e.model)} ｜ 代码 ${show(e.code)}）` : ''}`)
  section('警告', r.warnings, (e) => `\`${e.target}\` [${e.check}] ${e.text}`)
  section('需人确认', r.confirms, (e) => `\`${e.target}\` [${e.check}] ${e.text}${e.options ? `\n   - 选项：${e.options.join(' / ')}` : ''}${e.note ? `\n   - 备注：${e.note}` : ''}`)
  section('待判断（按重要度降序）', r.judgments, (j) => `\`${j.target}\` **${j.importance}** ${j.ask || j.check}\n   - 业务：${show(j.sides.business)}\n   - 模型：${show(j.sides.model)}${j.sides.code !== undefined ? `\n   - 代码：${show(j.sides.code)}` : ''}`)
  section('已裁决（未变化，未重复提出）', r.decided, (d) => `\`${d.target}\` [${d.check}] ${d.verdict} — ${d.note}（${d.at}）`)
  L.push('', '## 盲区', '')
  for (const b of r.blindSpots) L.push(`- ${b}`)
  L.push('')
  return L.join('\n')
}

// ---------- 纯改名之后重新定基 ----------
/**
 * 改名把裁决的指纹全打掉了，但裁的那件事一个字没变——这种不该让人重裁一遍。
 * 这里要工具自己证明「只改了名字」：拿一份「新说法 → 旧说法」的对照，把现在这段文字
 * 反着换回去，换出来的东西与当初人裁的那一段**一字不差**（指纹对得上），才算证明了。
 * 证不出来的一条都不动：那可能是真改了实质，必须留着过期、由人重裁。
 * 裁决的 verdict 与 note 一个字不改，只重算 on，并在 rebased[] 里记一笔是哪一批改的名。
 */
const SEP = String.fromCharCode(0)
function rebase() {
  if (!rebaseWhy) { console.error("重新定基要用 --说明 写清楚是哪一批改的名、换的是哪几个说法"); process.exit(2) }
  let pairs
  try { pairs = JSON.parse(fs.readFileSync(path.resolve(rebaseFile), "utf8")) } catch (e) { console.error("读不了新旧对照：" + e.message); process.exit(2) }
  const keys = Object.keys(pairs).sort((a, b) => b.length - a.length) // 长的先换，免得「录入花费」被「录入」先切开
  const back = (t) => applyWordMap(t, pairs, keys)
  const proved = new Map() // 文件 → [{ dec, to }]
  const unproved = []
  const seen = new Set()
  for (const { dec, text } of staleSeen) {
    const key = decFile.get(dec) + SEP + dec.target + SEP + dec.check + SEP + dec.on + SEP + fingerprint(text)
    if (seen.has(key)) continue
    seen.add(key)
    const file = decFile.get(dec)
    if (fingerprint(back(text)) === dec.on) {
      if (!proved.has(file)) proved.set(file, [])
      proved.get(file).push({ dec, to: fingerprint(text) })
    } else unproved.push({ file, dec, to: fingerprint(text) })
  }
  let written = 0
  for (const [file, list] of proved) {
    const p = path.join(root, file)
    const data = JSON.parse(fs.readFileSync(p, "utf8"))
    for (const { dec, to } of list) {
      const hit = (data.decisions ?? []).find((x) => x.target === dec.target && x.check === dec.check && x.on === dec.on && x.at === dec.at && x.note === dec.note)
      if (!hit) { console.error(`  ! ${file} 里找不回这一条裁决（${dec.target}），跳过`); continue }
      hit.rebased = [...(hit.rebased ?? []), { at: today, why: rebaseWhy, from: hit.on, to }]
      hit.on = to
      written++
    }
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + String.fromCharCode(10))
  }
  console.log(`裁决对账：问过 ${decStats.问过} 处；压根没人裁过 ${decStats.压根没人裁过} 处；指纹对上 ${decStats.指纹对上} 处；裁决没带指纹、照旧认下 ${decStats.没带指纹就认了} 处；指纹对不上 ${decStats.过期} 处`)
  console.log(`重新定基：这一趟遇到过期的裁决 ${seen.size} 条；证明得了只改名字的 ${written} 条已重算指纹（裁的内容一字未动），证不出来的 ${unproved.length} 条留着过期、要人重裁`)
  for (const u of unproved) console.log(`  · 仍过期：${u.dec.target}（${u.dec.check}）—— ${u.file}`)
  if (!unproved.length && written) console.log("  全部证明得了：这一趟确实只改了说法，没有一处实质变化")
}
if (rebaseFile) rebase()
