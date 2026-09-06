#!/usr/bin/env node
/**
 * 校验器。依据 seed/04-validation.md。
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
const { loadProject } = require('./lib/project')

const args = process.argv.slice(2)
const root = args[0] && path.resolve(args[0])
const codeIdx = args.indexOf('--code')
const codebase = codeIdx >= 0 ? path.resolve(args[codeIdx + 1]) : null
const sliceIdx = args.indexOf('--slice')
const sliceId = sliceIdx >= 0 ? args[sliceIdx + 1] : null
if (!root || !fs.existsSync(path.join(root, 'model'))) {
  console.error('用法：node tools/validate.js <项目目录> [--code <代码库目录>] [--slice <切片id>]')
  process.exit(2)
}
const devTeam = path.resolve(__dirname, '..')
const today = new Date().toISOString().slice(0, 10)

// ---------- 判断指南：每类判断在问什么、什么算通过 ----------
const GUIDES = {
  '模型规则是否与业务一致？': {
    question: '模型里这句话（不变量 / 行为规则 / 错误条件）是否完整、准确地表达了业务语句的意思？',
    pass: '意思一致。粒度可以不同：业务一句话可以拆到多个落点，每个落点只覆盖一部分也算通过，只要合起来不漏。',
    fail: '模型说得比业务少（漏了条件或例外）、说得比业务多（加了业务没说的限制）、或方向相反。',
    how: '对照编号把业务语句拆成条件逐个核对：主语、条件、结果各对应到模型里的哪个词。',
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
/** 裁决对象的指纹：文字变了裁决即过期 */
function fingerprint(text) {
  return require('node:crypto').createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 8)
}
function decidedFor(target, check, text) {
  const d = decisions.find((d) => d.target === target && d.check === check)
  if (!d) return null
  if (d.on && d.on !== fingerprint(text)) return { ...d, stale: true }
  return d
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
function judge(report, check, target, sides, importance, related) {
  const on = fingerprint(sides.model)
  const d = decidedFor(target, check, sides.model)
  const item = { target, check, sides, verdict: null, importance, confidence: null, reason: '', on }
  if (related) item.related = related
  if (d?.stale) item.staleDecision = { verdict: d.verdict, note: d.note, at: d.at }
  if (d && !d.stale) {
    report.decided.push({ check, target, text: sides.model, verdict: d.verdict, note: d.note, at: d.at })
    return
  }
  report.judgments.push(item)
}

// ---------- 加载 ----------
const project = loadProject(root)
const { business, glossary, model } = project
for (const el of model.elements) for (const d of el.data?.decisions ?? []) decisions.push(d)
for (const mf of model.moduleFiles) for (const d of mf.data.decisions ?? []) decisions.push(d)
for (const d of model.modules?.data.decisions ?? []) decisions.push(d)

const byId = new Map(business.map((s) => [s.id, s]))
// 切片范围：切片记录里 traces 非空时，覆盖检查只针对范围内的业务语句。
// 范围外的语句本轮本来就还没有落点，报错等于要求一次建完全部模型。
const sliceRec = sliceId ? (project.slices ?? []).map((s) => s.data).find((s) => s.id === sliceId) : null
const scopeIds = sliceRec?.traces?.length ? new Set(sliceRec.traces) : null
const inScope = (id) => !scopeIds || scopeIds.has(id)
const goals = business.filter((s) => s.kind === 'goal' && inScope(s.id))
const rules = business.filter((s) => s.kind === 'rule' && inScope(s.id))
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

// 覆盖：目标 → 命令/查询
for (const g of goals) {
  const hit = [...commands, ...queries].some((e) => e.data.traces.includes(g.id))
  if (!hit) add(r1, 'error', 'coverage.goal', g.id, `目标没有任何命令或查询追溯：${g.text}`)
}
// 覆盖：规则 → 按种类的落点
const sig = (name, input, output) => `${name}(${(input ?? []).map((p) => `${p.name}: ${p.type}`).join(', ')})${output ? ` → ${output}` : ''}`
const rulesText = (rules) => `规则：${rules.length ? rules.join('；') : '（无）'}`
const throwsText = (t) => (t.length ? `　抛出：${t.join(', ')}` : '')
const raisesText = (r) => (r.length ? `　发出：${r.map((x) => (typeof x === 'string' ? x : `${x.event}（${x.when}）`)).join(', ')}` : '')
function ruleLandings(id) {
  const out = []
  for (const el of domainObjects) {
    const objLabel = { 'aggregate-root': '聚合根', entity: '实体', 'value-object': '值对象' }[el.kind]
    for (const inv of el.data.aggregateInvariants ?? []) if (inv.traces.includes(id)) out.push({ kind: 'invariant', el, text: `聚合 ${el.data.name} 的不变量：${inv.text}` })
    for (const inv of el.data.invariants) if (inv.traces.includes(id)) out.push({ kind: 'invariant', el, text: `${objLabel} ${el.data.name} 的不变量：${inv.text}${throwsText(inv.throws ?? [])}` })
    for (const b of el.data.behaviors) if (b.traces.includes(id)) out.push({ kind: b.throws.length ? 'behavior-guard' : 'behavior', el, text: `${el.data.name}.${sig(b.name, b.input, b.output)}　${rulesText(b.rules)}${raisesText(b.raises)}${throwsText(b.throws)}` })
  }
  for (const s of services) for (const op of s.data.operations) if (op.traces.includes(id)) out.push({ kind: 'service', el: s, text: `领域服务 ${s.data.name}.${sig(op.name, op.input, op.output)}　${rulesText(op.rules)}${throwsText(op.throws)}` })
  for (const h of handlers) if (h.data.traces.includes(id)) out.push({ kind: 'event-handler', el: h, text: `事件处理 ${h.data.name}（触发：${h.data.trigger}）：${h.data.steps.map((s) => s.text).join(' → ')}` })
  for (const e of errors) if (e.data.traces.includes(id)) out.push({ kind: 'error', el: e, text: `错误 ${e.data.name}：${e.data.condition || '（无条件说明）'}` })
  return out
}
const EXPECTED = { 不变量: ['invariant', 'behavior-guard', 'error'], 反应: ['event-handler'], 推导: ['behavior', 'behavior-guard', 'service'] }
for (const r of rules) {
  const landings = ruleLandings(r.id)
  if (!landings.length) {
    add(r1, 'error', 'coverage.rule', r.id, `规则没有任何落点：${r.text}`)
    continue
  }
  if (r.ruleKind && EXPECTED[r.ruleKind] && !landings.some((l) => EXPECTED[r.ruleKind].includes(l.kind))) {
    add(r1, 'warning', 'coverage.rule-kind', r.id, `规则种类「${r.ruleKind}」的落点应为 ${EXPECTED[r.ruleKind].join(' / ')}，实际只有 ${[...new Set(landings.map((l) => l.kind))].join(' / ')}`)
  }
  // 一条业务语句一条判断：模型侧列出全部落点及其完整上下文
  const importance = landings.some((l) => ['invariant', 'behavior-guard', 'error', 'behavior'].includes(l.kind)) ? 'high' : 'medium'
  judge(r1, '模型规则是否与业务一致？', r.id, { business: `[${r.id}]${r.ruleKind ? ` (${r.ruleKind})` : ''} ${r.text}`, model: landings.map((l) => l.text).join('\n') }, importance, [...new Set(landings.map((l) => l.el.file))])
}
// 追溯反向：每个元素 traces 非空且存在
function checkTraces(target, traces, level = 'error') {
  if (!traces || !traces.length) return add(r1, level, 'traces.empty', target, 'traces 为空')
  for (const t of traces) if (!byId.has(t)) add(r1, 'error', 'traces.unknown', target, `追溯编号不存在：${t}`)
}
for (const el of [...domainObjects, ...events, ...errors, ...ports, ...commands, ...queries, ...handlers]) checkTraces(el.file, el.data.traces)
for (const el of domainObjects) for (const b of el.data.behaviors) checkTraces(`${el.file}#behaviors.${b.name}`, b.traces)
for (const s of services) for (const op of s.data.operations) checkTraces(`${s.file}#operations.${op.name}`, op.traces)
for (const m of model.modules?.data.modules ?? []) checkTraces(`${model.modules.file}#${m.name}`, m.traces, 'warning')
for (const g of goals) {
  const ucs = [...commands, ...queries].filter((x) => x.data.traces.includes(g.id))
  if (!ucs.length) continue
  const lines = ucs.map((e) => {
    const kind = e.kind === 'query-handler' ? '查询' : '命令'
    const steps = e.data.steps.map((s) => (s.when ? `[${s.when}] ${s.text}` : s.text)).join(' → ')
    const result = e.kind === 'query-handler' ? `　返回：${e.data.result.map((p) => p.name).join(', ')}` : ''
    return `${kind} ${e.data.name}（${e.data.actor}；输入：${e.data.input.map((p) => p.name).join(', ')}）：${steps}${result}`
  })
  judge(r1, '用例是否按步骤完成了业务目标？', g.id, { business: `[${g.id}] ${g.text}`, model: lines.join('\n') }, 'medium', ucs.map((e) => e.file))
}

// 命名：名词在词汇表
const terms = new Set(glossary.terms.map((t) => t.name))
for (const el of domainObjects) if (!terms.has(el.data.name)) add(r1, 'error', 'glossary.noun', el.file, `名字不在词汇表中：${el.data.name}`)
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
    if (s.when) judge(r1, '分流条件是否只引用了领域调用的结果？', `${el.file}#steps.${i}`, { model: `${s.when} → ${s.text}` }, 'medium')
    judge(r1, '步骤是否只是编排，没有夹带业务判断？', `${el.file}#steps.${i}`, { model: s.text }, 'medium')
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
      add(r1, 'error', 'module.aggregates', mf.file, `聚合清单中的 ${a.name} 没有 aggregate-root 文件`)
      continue
    }
    const members = new Set([...entities, ...vos].filter((m) => m.module === mf.module && m.aggregateFolder === r.aggregateFolder).map((m) => m.data.name))
    for (const m of a.members) if (!members.has(m)) add(r1, 'error', 'module.members', `${mf.file}#${a.name}`, `members 中的 ${m} 没有实体 / 值对象文件`)
    for (const m of members) if (!a.members.includes(m)) add(r1, 'error', 'module.members', `${mf.file}#${a.name}`, `members 缺少 ${m}`)
    for (const ref of a.idRefs) if (!find(['aggregate-root'], ref.to, mf.module)) add(r1, 'error', 'module.idRefs', `${mf.file}#${a.name}`, `idRef 指向不存在的聚合：${ref.to}`)
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
function finish(report, name) {
  report.judgments.sort((a, b) => rank(b.importance) - rank(a.importance))
  const open = report.errors.length + report.warnings.length + report.confirms.length
  report.conclusion = open === 0 ? 'clean' : 'not-clean'
  const dir = path.join(root, 'reports')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, `${name}.md`), renderMd(report))
  const j = report.judgments.length
  console.log(`方向 ${report.direction}：错误 ${report.errors.length} · 警告 ${report.warnings.length} · 需人确认 ${report.confirms.length} · 待判断 ${j} · 已裁决 ${report.decided.length} → ${report.conclusion === 'clean' ? '干净' : '不干净'}（${path.relative(process.cwd(), path.join(dir, name + '.md'))}）`)
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
  section('待判断（按重要度降序）', r.judgments, (j) => `\`${j.target}\` **${j.importance}** ${j.check}\n   - 业务：${show(j.sides.business)}\n   - 模型：${show(j.sides.model)}${j.sides.code !== undefined ? `\n   - 代码：${show(j.sides.code)}` : ''}`)
  section('已裁决（未变化，未重复提出）', r.decided, (d) => `\`${d.target}\` [${d.check}] ${d.verdict} — ${d.note}（${d.at}）`)
  L.push('', '## 盲区', '')
  for (const b of r.blindSpots) L.push(`- ${b}`)
  L.push('')
  return L.join('\n')
}
