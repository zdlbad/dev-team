#!/usr/bin/env node
/**
 * 编码计划。编码开始前，从模型与切片范围算出这次要动哪些代码文件、按什么顺序，
 * 写成 plans/<切片id>.json（+ .md 给人看）。编码 / 原型角色在每一步下面补「关键逻辑」，
 * 人确认后才开写；写的时候每完成一步登记一次，最后核对：文件都在、顺序与计划一致。
 *
 * 用法：
 *   node tools/plan.js build   <项目目录> <切片id> [--code <代码库>] [--force]   算链路（已确认的计划要 --force 才重算）
 *   node tools/plan.js confirm <项目目录> <切片id> [步骤号]                      人确认计划（门禁）；带步骤号只确认那一步，全确认了计划才算通过
 *   node tools/plan.js unconfirm <项目目录> <切片id> <步骤号>                    人撤销某一步的确认（写完的步不能撤，改用留话）
 *   node tools/plan.js comment <项目目录> <切片id> <步骤号> "<一句话>"            人在某一步上留话（哪里不对、要改成什么）；写码角色开写前读它
 *   node tools/plan.js done    <项目目录> <切片id> <步骤号> [说明]                角色：完成第 n 步（记时间，核对顺序用）
 *   node tools/plan.js check   <项目目录> <切片id> [--code <代码库>] [--json]    核对：已确认、关键逻辑齐、文件都在、顺序一致、walk.input 齐
 *
 * 计划的种类由切片决定：故事切片 → proto（领域 + 应用 + 内存适配器 + 原型入口 + 测试 + walk.input）；
 * 实现切片 → shell（生产仓储、HTTP 入口、生产装配 + 外壳测试；文件名取自 contracts/）；老式切片 → full。
 * 退出码：0 正常；1 核对未过；2 用法或前置错误。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { folderOf, codePathOf, modelKeyOf, loadProject, walk, readJson, walkNames, conditionText } = require('./lib/project')
const { journal } = require('./lib/journal')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const sliceId = args[2] && !args[2].startsWith('--') ? args[2] : undefined
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
/** 所有 --x 后面跟的值：把不带 -- 的参数当正文时要排掉它们 */
const USED_VALUES = new Set(args.filter((a, i) => i > 0 && args[i - 1].startsWith('--')))
const today = new Date().toISOString().slice(0, 10)
const now = () => new Date().toISOString()

/** 两条代码路径算不算同一个文件：模块文件夹改成全小写连字符之前（第七十二批）写下的计划里还是 src/Participants/…，
 *  重算时不能因为大小写不同就把它们的关键逻辑与「已做过」先例丢掉 */
function sameFile(a, b) {
  const norm = (f) => (f ? String(f).replace(/^(src|tests)\/([^/]+)/, (_, top, mod) => top + '/' + folderOf(mod)) : null)
  return norm(a) === norm(b)
}
/** 模型里出现过的模块名（给 modelKeyOf 把文件夹名对回真名） */
function moduleNamesOf(model) {
  const names = new Set()
  for (const mf of model.moduleFiles ?? []) names.add(mf.module)
  for (const el of model.elements ?? []) if (el.module) names.add(el.module)
  return names
}
function die(msg) { console.error(msg); process.exit(2) }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n') }
if (!['build', 'confirm', 'amend', 'done', 'check'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !sliceId) {
  die('用法：node tools/plan.js <build|confirm|amend|done|check> <项目目录> <切片id> …（项目目录须含 project.json）')
}
const slicePath = path.join(root, 'slices', `${sliceId}.json`)
if (!fs.existsSync(slicePath)) die(`切片不存在：${path.relative(process.cwd(), slicePath)}`)
const slice = readJson(slicePath)
const storyPath = path.join(root, 'slices', `${sliceId}.story.json`)
const story = fs.existsSync(storyPath) ? readJson(storyPath) : null
// --code 相对当前目录；切片记录里的 codebase 相对项目目录
const codebase = opt('--code') ? path.resolve(opt('--code')) : path.resolve(root, slice.codebase)
const planPath = path.join(root, 'plans', `${sliceId}.json`)
const planMd = path.join(root, 'plans', `${sliceId}.md`)
const rel = (p) => path.relative(process.cwd(), p) || '.'
const posix = (p) => p.replaceAll('\\', '/')

/** 计划种类：故事 → 原型；实现 → 外壳；老式 → 全部 */
const planKind = slice.kind === 'story' || (story && slice.kind !== 'implementation') ? 'proto' : slice.kind === 'implementation' ? 'shell' : 'full'
const roleName = planKind === 'proto' ? '原型' : '编码'

// ---------- 文件存在性（支持文件名里的 *）----------
function exists(file) {
  if (!file) return true
  if (!file.includes('*')) return fs.existsSync(path.join(codebase, file))
  const re = new RegExp('^' + file.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
  return walk(codebase).some((p) => re.test(posix(path.relative(codebase, p))))
}
function appendSliceLog(text) {
  const s = readJson(slicePath)
  s.log.push({ ts: today, stage: 'plan', text })
  writeJson(slicePath, s)
}

/**
 * 每条切片的故事各走了哪些用例、那一步的 walk.input 填的还作不作数。
 * 命令的入参窄一档之后，早先那几条切片的故事输入就成了陈货：递进去命令不认，
 * 那条故事在原型上跑不动——而没有任何东西会说一声。
 * 顶层栏位对得上对不上，机器判得了（extra 就是命令上已经没有的那几个）；
 * 窄在参数里面的（比如 expenses 里每一笔少了几样），类型只是词汇表上的一段话、没有字段清单，
 * 机器判不了——所以只要这一趟动了这条命令，就把那条故事列出来让人看一眼。
 * 一步走两个动作（「A + B」）的，两个动作收的是同一份输入，按两边入参的并集比。
 */
function storyWalks(model) {
  const els = model.elements.filter((e) => e.kind !== "invalid")
  const kinds = ["command-handler", "query-handler", "event-handler"]
  const findEl = (name, hint) => {
    const [m, n] = name.includes(".") ? name.split(".") : [null, name]
    return els.find((e) => kinds.includes(e.kind) && e.data.name === n && (!m || e.module === m)) ??
      (hint && !m ? els.find((e) => kinds.includes(e.kind) && e.data.name === n && e.module === hint) : null) ?? null
  }
  const dir = path.join(root, "slices")
  const out = []
  if (!fs.existsSync(dir)) return out
  const suffix = ".story.json"
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith(suffix)).sort()) {
    let st; try { st = readJson(path.join(dir, file)) } catch { continue }
    const walks = []
    for (const s of st.steps ?? []) {
      const w = s.walk
      if (!w || !w.input || typeof w.input !== "object" || Array.isArray(w.input)) continue
      const hint = w.aggregate && w.aggregate.includes(".") ? w.aggregate.split(".")[0] : null
      const known = new Set()
      const targets = []
      for (const n of walkNames(w.name)) {
        const el = findEl(n, hint)
        if (!el) continue
        targets.push(el.module + "." + el.data.name)
        for (const p of el.data.input ?? []) known.add(p.name)
      }
      if (!targets.length) continue
      walks.push({ n: s.n, name: w.name, targets, extra: Object.keys(w.input).filter((k) => !known.has(k)) })
    }
    if (walks.length) out.push({ slice: file.slice(0, -suffix.length), walks })
  }
  return out
}

// ========== build ==========
function build(dry = false) {
  const project = loadProject(root)
  const { model } = project
  const els = model.elements.filter((e) => e.kind !== 'invalid')
  const byQ = (kind, q) => { const [m, n] = q.includes('.') ? q.split('.') : [null, q]; return els.find((e) => e.kind === kind && e.data.name === n && (!m || e.module === m)) ?? null }
  const modOf = (el) => el.module
  const q = (el) => `${el.module}.${el.data.name}`

  // ---- 范围：用例（命令 / 查询 / 事件处理）与聚合的限定名 ----
  const useCases = new Set(), aggregates = new Set(), modulesOnly = new Set()
  const missingUseCases = []
  if (story) for (const s of story.steps) {
    const w = s.walk; if (!w || w.kind === 'none') continue
    if (w.aggregate) aggregates.add(w.aggregate)
    // 裸名靠这一步动的聚合定位模块；找不到就按名字在全模型里找唯一的一个
    const hint = w.aggregate?.includes('.') ? w.aggregate.split('.')[0] : null
    for (const n of walkNames(w.name)) {
      const el =
        byQ('command-handler', n) ?? byQ('query-handler', n) ?? byQ('event-handler', n) ??
        (hint ? byQ('command-handler', `${hint}.${n}`) ?? byQ('query-handler', `${hint}.${n}`) ?? byQ('event-handler', `${hint}.${n}`) : null)
      if (el) useCases.add(q(el))
      else missingUseCases.push(`第 ${s.n} 步「${n}」`)
    }
  }
  if (missingUseCases.length) console.error(`[计划] 故事里这些走法在模型里找不到对应的用例，已跳过：${missingUseCases.join('、')}`)
  for (const u of slice.scope.useCases ?? []) { const el = byQ('command-handler', u) ?? byQ('query-handler', u) ?? byQ('event-handler', u); if (el) useCases.add(q(el)) }
  for (const a of slice.scope.aggregates ?? []) { const el = byQ('aggregate-root', a); if (el) aggregates.add(q(el)) }
  if (!useCases.size && !aggregates.size) for (const m of slice.scope.modules ?? []) modulesOnly.add(m)
  if (!useCases.size && !aggregates.size && !modulesOnly.size) die('切片范围为空：故事还没有 walk，或切片记录的 scope 没填')
  for (const m of modulesOnly) for (const el of els.filter((e) => e.module === m)) { if (['command-handler', 'query-handler', 'event-handler'].includes(el.kind)) useCases.add(q(el)); if (el.kind === 'aggregate-root') aggregates.add(q(el)) }

  // ---- 闭包：用例走到的聚合 / 服务 / 仓储 / 端口 ----
  const services = new Set(), repos = new Set(), ports = new Set()
  const ownerAggregate = (el) => (el.kind === 'aggregate-root' ? el.data.name : el.data.aggregate)
  const resolveDomain = (name, m) => els.find((e) => ['aggregate-root', 'entity', 'value-object'].includes(e.kind) && e.module === (name.includes('.') ? name.split('.')[0] : m) && e.data.name === (name.includes('.') ? name.split('.')[1] : name))
  const visitSteps = (steps, m) => {
    for (const s of steps ?? []) {
      const c = s.call; if (!c) continue
      if (c.kind === 'behavior' || c.kind === 'factory') { const d = resolveDomain(c.target, m); if (d) aggregates.add(`${d.module}.${ownerAggregate(d)}`) }
      if (c.kind === 'service') { const sv = byQ('service', c.target.includes('.') ? c.target : `${m}.${c.target}`); if (sv) { services.add(q(sv)); for (const op of sv.data.operations) visitSteps(op.steps, sv.module) } }
      if (c.kind === 'repository') { const r = byQ('repository', c.target.includes('.') ? c.target : `${m}.${c.target}`); if (r) { repos.add(q(r)); aggregates.add(`${r.module}.${r.data.aggregate}`) } }
      if (c.kind === 'port') { const p = byQ('port', c.target.includes('.') ? c.target : `${m}.${c.target}`); if (p) ports.add(q(p)) }
      if (c.kind === 'command') { const cc = byQ('command-handler', c.target.includes('.') ? c.target : `${m}.${c.target}`); if (cc) useCases.add(q(cc)) }
    }
  }
  let size = -1
  while (size !== useCases.size + aggregates.size) {
    size = useCases.size + aggregates.size
    for (const u of [...useCases]) { const el = byQ('command-handler', u) ?? byQ('query-handler', u) ?? byQ('event-handler', u); if (el) visitSteps(el.data.steps, el.module) }
    for (const a of [...aggregates]) { const r = els.find((e) => e.kind === 'repository' && `${e.module}.${e.data.aggregate}` === a); if (r) repos.add(q(r)) }
  }
  // 事件处理与查询：范围内聚合发出的事件、读范围内聚合的查询，都要建。
  // 从前故事切片「只认 walk 走到的」，于是模型里有、计划里没有——校验 ② 解码比对时会报「模型有、代码无」，
  // 而故事本来不必走到每一个用例（发票状态由事件推进、待办清单没人在故事里打开）。模型是按最小建的，里面的东西就该全建。
  const inScopeModules = () => new Set([...aggregates, ...useCases].map((x) => x.split('.')[0]))
  for (const h of els.filter((e) => e.kind === 'event-handler')) {
    const [tm, tn] = h.data.trigger.includes('.') ? h.data.trigger.split('.') : [h.module, h.data.trigger]
    const ev = els.find((e) => e.kind === 'event' && e.module === tm && e.data.name === tn)
    if (!ev || !aggregates.has(`${ev.module}.${ev.data.aggregate}`)) continue
    const byModule = modulesOnly.has(h.module) || (slice.scope.modules ?? []).includes(h.module)
    if (byModule || inScopeModules().has(h.module)) { useCases.add(q(h)); visitSteps(h.data.steps, h.module) }
  }
  // 查询：处理器在范围模块里、且它读的仓储属于范围内的聚合
  for (const h of els.filter((e) => e.kind === 'query-handler')) {
    if (useCases.has(q(h)) || !inScopeModules().has(h.module)) continue
    const reads = (h.data.steps ?? []).some((s) => {
      const c = s.call
      if (!c || c.kind !== 'repository') return false
      const r = byQ('repository', c.target.includes('.') ? c.target : `${h.module}.${c.target}`)
      return r && aggregates.has(`${r.module}.${r.data.aggregate}`)
    })
    if (reads) { useCases.add(q(h)); visitSteps(h.data.steps, h.module) }
  }

  // 端口：范围模块里的端口即使没有哪一步调用它也要建（外部系统的边界本轮可能由人照抄充当适配器，端口文件仍是模型的一部分，校验 ② 解码要对得上）
  for (const p of els.filter((e) => e.kind === 'port' && inScopeModules().has(e.module))) ports.add(q(p))

  // ---- 聚合顺序：被 idRef 指向的先建 ----
  const aggList = [...aggregates]
  const deps = new Map(aggList.map((a) => [a, new Set()]))
  for (const mf of model.moduleFiles) for (const ag of mf.data.aggregates ?? []) {
    const me = `${mf.module}.${ag.name}`
    if (!deps.has(me)) continue
    for (const r of ag.idRefs ?? []) if (deps.has(r.to) && r.to !== me) deps.get(me).add(r.to)
  }
  const ordered = []
  const seen = new Set()
  const visit = (a, stack = new Set()) => { if (seen.has(a)) return; if (stack.has(a)) return; stack.add(a); for (const d of deps.get(a) ?? []) visit(d, stack); seen.add(a); ordered.push(a) }
  for (const a of aggList.sort()) visit(a)

  // ---- 生成步骤 ----
  const steps = []
  // 代码文件夹全小写连字符（agents/common/project-layout.md「名字的两套写法」，第七十二批）：model/Participants/… → src/participants/…
  const codeFile = (el) => codePathOf(posix(el.file), 'src')
  const testFile = (el) => codePathOf(posix(el.file), 'tests')
  const dirOf = folderOf
  const add = (layer, file, target, what, traces, needsKeyLogic, extra = {}) => steps.push({ n: steps.length + 1, layer, action: exists(file) ? 'modify' : 'create', file, target, what, traces: [...new Set(traces ?? [])], needsKeyLogic, keyLogic: null, doneAt: null, ...extra })
  const behaviorsText = (el) => el.data.behaviors.map((b) => b.name).join('、')
  const modulesInScope = [...new Set([...aggregates, ...useCases].map((x) => x.split('.')[0]))].sort()
  // 一个段落最多两个模块（seed/slices.md「开发范围怎么切」）。三个就是把两段并成了一段，算出来的单子人消化不掉。
  // 实现切片本来就把几段并在一起上生产外壳，不受这一条限制
  if (slice.kind !== 'implementation' && slice.kind !== 'refactor' && modulesInScope.length > 2 && !args.includes('--允许超界')) {
    const say = [
      "这一段碰了 " + modulesInScope.length + " 个模块（" + modulesInScope.join("、") + "），超过一个段落该有的大小。",
      "一个故事段落是两个模块的一次交互（有时就是一个模块自己），单一业务意图；三个模块说明这里其实是两段并成了一段。",
      "先把切片拆开；确实要一次算完的话加 --允许超界。见 seed/slices.md「开发范围怎么切」",
    ]
    die(say.join(String.fromCharCode(10)))
  }
  if ((slice.kind === 'story' || story) && !slice.intent) console.error("[计划] 这条切片没写「单一业务意图」（切片记录的 intent）：写不出一句话就是不止一个意图，那要再切。见 seed/slices.md「开发范围怎么切」")

  if (planKind !== 'shell') {
    if (!hasBuildingBlock()) add('building-block', 'src/shared/building-block/domain/AggregateRoot.ts', 'shared.building-block', '首次：把 $DEV_TEAM/building-block/ 拷入 src/shared/building-block/（domain / application / ports / proto）', [], false)
    for (const a of ordered) {
      const [m, n] = a.split('.')
      const rootEl = els.find((e) => e.kind === 'aggregate-root' && e.module === m && e.data.name === n)
      if (!rootEl) continue
      const folder = rootEl.aggregateFolder
      const members = els.filter((e) => ['value-object', 'entity', 'event', 'error'].includes(e.kind) && e.module === m && e.aggregateFolder === folder)
      for (const el of members.filter((e) => e.kind === 'value-object')) add('domain', codeFile(el), q(el), `值对象 ${el.data.name}：行为 ${behaviorsText(el) || '无'}；不变量 ${el.data.invariants.length} 条`, [...el.data.traces, ...el.data.invariants.flatMap((i) => i.traces)], !!(el.data.behaviors.length || el.data.invariants.length))
      for (const el of members.filter((e) => e.kind === 'entity')) add('domain', codeFile(el), q(el), `实体 ${el.data.name}：行为 ${behaviorsText(el) || '无'}；不变量 ${el.data.invariants.length} 条`, [...el.data.traces, ...el.data.invariants.flatMap((i) => i.traces)], !!(el.data.behaviors.length || el.data.invariants.length))
      for (const el of members.filter((e) => e.kind === 'event')) add('domain', codeFile(el), q(el), `事件 ${el.data.name}（${(el.data.payload ?? []).map((p) => p.name).join(', ') || '无 payload'}）`, el.data.traces, false)
      for (const el of members.filter((e) => e.kind === 'error')) add('domain', codeFile(el), q(el), `错误 ${el.data.name}：${conditionText(el.data.condition) || '（条件未写）'}`, el.data.traces, false)
      add('domain', codeFile(rootEl), q(rootEl), `聚合根 ${n}：行为 ${behaviorsText(rootEl) || '无'}；不变量 ${(rootEl.data.aggregateInvariants ?? []).length + rootEl.data.invariants.length} 条`, [...rootEl.data.traces, ...rootEl.data.behaviors.flatMap((b) => b.traces), ...rootEl.data.invariants.flatMap((i) => i.traces), ...(rootEl.data.aggregateInvariants ?? []).flatMap((i) => i.traces)], true)
      const repo = els.find((e) => e.kind === 'repository' && e.module === m && e.data.aggregate === n)
      if (repo && repos.has(q(repo))) add('repository', codeFile(repo), q(repo), `仓储接口 ${repo.data.name}：${repo.data.methods.map((x) => `${x.name}(${x.kind === 'read' ? '读' : '写'})`).join('、')}`, [], false)
    }
    for (const sv of [...services].sort().map((s) => byQ('service', s)).filter(Boolean)) add('service', codeFile(sv), q(sv), `领域服务 ${sv.data.name}：操作 ${sv.data.operations.map((o) => o.name).join('、')}；读 ${[...new Set(sv.data.operations.flatMap((o) => o.reads))].join('、') || '无'}`, sv.data.operations.flatMap((o) => o.traces), true)
    const ucEls = [...useCases].map((u) => byQ('command-handler', u) ?? byQ('query-handler', u) ?? byQ('event-handler', u)).filter(Boolean)
    const ucOrder = { 'command-handler': 0, 'query-handler': 1, 'event-handler': 2 }
    for (const el of ucEls.sort((a, b) => ucOrder[a.kind] - ucOrder[b.kind] || a.data.name.localeCompare(b.data.name))) {
      const label = { 'command-handler': '命令', 'query-handler': '查询', 'event-handler': '事件处理' }[el.kind]
      const extra = el.kind === 'event-handler' ? `触发 ${el.data.trigger}；` : ''
      add('application', codeFile(el), q(el), `${label} ${el.data.name}：${extra}${el.data.steps.map((s) => (s.when ? `[${s.when}] ` : '') + s.text).join(' → ')}${el.data.writes?.length ? `；写 ${el.data.writes.join('、')}` : ''}${el.data.raises?.length ? `；发出 ${el.data.raises.map((r) => (typeof r === 'string' ? r : r.event)).join('、')}` : ''}`, el.data.traces, true)
    }
    for (const p of [...ports].sort().map((x) => byQ('port', x)).filter(Boolean)) add('port', codeFile(p), q(p), `端口 ${p.data.name}（${p.data.kind === 'module' ? '模块 ' : '外部系统 '}${p.data.target}）：${p.data.operations.map((o) => o.name).join('、')}`, p.data.traces, false)
  }

  // 适配器与装配
  const repoEls = [...repos].sort().map((r) => byQ('repository', r)).filter(Boolean)
  const portEls = [...ports].sort().map((x) => byQ('port', x)).filter(Boolean)
  const hasWriter = [...useCases].some((u) => { const el = byQ('command-handler', u) ?? byQ('event-handler', u); return el && (el.data.writes ?? []).length })
  if (planKind === 'proto') {
    for (const r of repoEls) add('adapter', `src/${dirOf(r.module)}/adapters/adapter.InMemory${r.data.aggregate}Repository.ts`, q(r), `内存仓储 InMemory${r.data.aggregate}Repository：实现 ${r.data.name}Interface，另加 all() 给原型页面看状态；save 比对 version`, [], false)
    for (const p of portEls) add('adapter', `src/${dirOf(p.module)}/adapters/adapter.*${p.data.name}.ts`, q(p), p.data.kind === 'module' ? `直连适配器：实现 ${p.data.name}Interface，内部调 ${p.data.target} 模块的仓储或查询，不含判断` : `原型用的假适配器：实现 ${p.data.name}Interface（${p.data.target}），只记录 / 打印，不含判断`, [], false)
    if (hasWriter) add('adapter', `src/*/adapters/adapter.InMemoryEventPublisher.ts`, 'shared.EventPublisher', '进程内事件总线：按事件名分发给订阅者；原型里顺手记进宿主的事件流水', [], false)
  } else if (planKind === 'shell') {
    const contracts = loadContracts()
    for (const r of repoEls) {
      const t = contracts.tables.find((c) => c.aggregate === `${r.module}.${r.data.aggregate}` || c.aggregate === r.data.aggregate)
      const orm = t?.orm && !isMarker(t.orm) ? t.orm : '*'
      add('shell', `src/${dirOf(r.module)}/adapters/adapter.${orm}${r.data.aggregate}Repository.ts`, q(r), `生产仓储 ${orm === '*' ? '<技术>' : orm}${r.data.aggregate}Repository：实现 ${r.data.name}Interface；表 ${t?.table && !isMarker(t.table) ? t.table : '（契约未定）'}；save 带乐观锁（where version = ?，成功 +1，不符抛 ConcurrencyError）；不分发事件`, [], true, { contract: t ? posix(t.file) : null })
    }
    for (const p of portEls.filter((x) => x.data.kind === 'external-system')) add('shell', `src/${dirOf(p.module)}/adapters/adapter.*${p.data.name}.ts`, q(p), `生产适配器：实现 ${p.data.name}Interface，对接 ${p.data.target}；只做线格式转换`, [], true)
    for (const u of [...useCases].sort()) {
      const el = byQ('command-handler', u) ?? byQ('query-handler', u)
      if (!el) continue
      const h = contracts.https.find((c) => c.useCase === u || c.useCase === el.data.name)
      add('shell', null, q(el), `HTTP 入口 ${el.data.name}：${h ? `${h.method ?? '?'} ${h.path ?? '?'}` : '（契约未定）'}；字段名沿用命令 input（${(el.data.input ?? []).map((x) => x.name).join(', ')}）；领域错误按 contracts/errors 映射状态码；文件位置由技术选型定`, el.data.traces, true, { contract: h ? posix(h.file) : null })
    }
  } else {
    for (const r of repoEls) add('adapter', `src/${dirOf(r.module)}/adapters/adapter.*${r.data.aggregate}Repository.ts`, q(r), `仓储适配器：实现 ${r.data.name}Interface；save 带乐观锁；不分发事件`, [], false)
    for (const p of portEls) add('adapter', `src/${dirOf(p.module)}/adapters/adapter.*${p.data.name}.ts`, q(p), `适配器：实现 ${p.data.name}Interface（${p.data.target}）；只做线格式转换，不含判断`, [], false)
    if (hasWriter) add('adapter', `src/*/adapters/adapter.*EventPublisher.ts`, 'shared.EventPublisher', '事件发布适配器：实现 EventPublisherInterface', [], false)
  }
  for (const m of modulesInScope) add('composition', `src/${dirOf(m)}/module.ts`, `${m}.module`, planKind === 'shell' ? `生产装配：换掉内存适配器，顺序 适配器 → 领域服务 → 处理器 → 事件订阅；@module / @responsibility / @trace 不变` : `组合根 build${m}Module：实例化顺序 适配器 → 领域服务 → 处理器 → 事件订阅${planKind === 'proto' ? '；把每个命令 / 查询 / 仓储登记到原型宿主（登记名 = 模块.名字）' : ''}`, [], false)
  if (planKind === 'proto') add('proto', 'src/proto/main.ts', 'proto.main', '原型入口：new ProtoHost((h) => { build 各模块 })，serve(PROTO_PORT)', [], false)

  // 测试（03 §八：tests/ 镜像 src/，文件名 = 源文件名 + .test.ts）
  if (planKind !== 'shell') {
    for (const a of ordered) {
      const [m, n] = a.split('.')
      const rootEl = els.find((e) => e.kind === 'aggregate-root' && e.module === m && e.data.name === n)
      if (!rootEl) continue
      const carriers = els.filter((e) => ['aggregate-root', 'entity', 'value-object'].includes(e.kind) && e.module === m && e.aggregateFolder === rootEl.aggregateFolder && (e.data.behaviors.length || e.data.invariants.length))
      for (const el of carriers) add('test', testFile(el), q(el), `领域测试 ${el.data.name}：每条 rule、每个 throws、每个 raises 至少一个用例；用例名带编号；只 import 领域层与构建块`, el.data.traces, false)
    }
    for (const sv of [...services].sort().map((s) => byQ('service', s)).filter(Boolean)) add('test', testFile(sv), q(sv), `领域服务测试 ${sv.data.name}：每条 rule 一个用例`, [], false)
    for (const u of [...useCases].sort()) { const el = byQ('command-handler', u) ?? byQ('query-handler', u) ?? byQ('event-handler', u); if (el) add('test', testFile(el), q(el), `用例测试 ${el.data.name}：用内存适配器走 steps 主线 + 每个 when 分流 + 每个 throws`, [], false) }
  } else {
    for (const r of repoEls) add('test', `tests/${dirOf(r.module)}/adapters/adapter.*${r.data.aggregate}Repository.test.ts`, q(r), `仓储测试：save / find 往返 + 版本冲突抛 ConcurrencyError`, [], false)
    for (const u of [...useCases].sort()) { const el = byQ('command-handler', u) ?? byQ('query-handler', u); if (el) add('test', `tests/${dirOf(el.module)}/adapters/*${el.data.name}*.test.ts`, q(el), `契约测试 ${el.data.name}：按 contracts/http 的字段发请求，核对响应与错误 → 状态码`, [], false) }
  }
  if (planKind === 'proto' && story) add('input', null, `${sliceId}.story`, `给故事每一步（kind 为 command / query / time 的）walk 填 input：字段名 = 命令 input 的参数名，值来自故事的金额与日期`, [], false)
  // 这一趟动的命令，别的切片的故事里也在走：它那份 walk.input 是照旧模型填的，
  // 不核对一遍，那条故事就可能在原型上跑不动了而没人知道。谁也不会顺手看见，所以列成一步。
  if (planKind === 'proto') for (const other of storyWalks(model)) {
    if (other.slice === sliceId) continue
    const hit = other.walks.filter((x) => x.targets.some((t) => useCases.has(t)))
    if (!hit.length) continue
    const proven = [...new Set(hit.flatMap((x) => x.extra))]
    const where = hit.map((x) => `第 ${x.n} 步（${x.name}）`).join("、")
    add('input', null, `${other.slice}.story`, `${other.slice} 的故事输入跟着核对：这一趟动的命令它也在走（${where}），那份 walk.input 是照旧模型填的${proven.length ? `——${proven.join("、")} 这几个栏位命令上已经没有了` : '，要照现在的 input 逐个字段核一遍，多出来的删掉、窄掉的改过来'}；不改它这条故事在原型上跑不动`, [], false)
  }
  // 只算不写（plan amend 用）：在「挑掉已经做过的」之前返回，因为那一步会把本计划自己做完的
  // 全部挑走，剩不下东西可比。拿这份未过滤的单子跟「现有步骤 + 已经做过的」对，才知道模型这次改动
  // 有没有多出、少掉或挪动要干的活。
  if (dry) { const d = steps.slice(); interleaveTests(d); return { steps: d, planKind } }

  // ---- 已经做过的挑出去，不再列成步骤 ----
  const { remaining, already, unrecorded } = pickOutAlreadyDone(steps, model)
  steps.length = 0
  steps.push(...remaining)

  // ---- 测试就位：哪一块写完就配哪一块的测试 ----
  interleaveTests(steps)

  // ---- 合并旧计划的关键逻辑；写出 ----
  const old = fs.existsSync(planPath) ? readJson(planPath) : null
  if (old?.confirmedAt && !args.includes('--force')) die(`计划已于 ${old.confirmedAt} 确认；要重算请加 --force（关键逻辑与人留的话保留；内容没变的步确认也留着，只有新步和变了的步要重新确认；完成记录清零）`)
  // 重算按「这次改了什么」算账（2026-09-14 项目所有者：「我改一条，两个段落都被重新写了一遍」）：
  // 上一版同一步的关键逻辑、人留的话都带过来；一步的做什么与关键逻辑一个字没变，人对它的确认也留着——只有新步和内容变了的步要人重新确认。
  let kept = 0
  if (old) for (const s of steps) {
    const o = old.steps.find((x) => x.target === s.target && x.layer === s.layer && sameFile(x.file, s.file))
    if (!o) continue
    if (o.keyLogic) s.keyLogic = o.keyLogic
    if (o.humanNotes?.length) s.humanNotes = o.humanNotes
    if (o.confirmedAt && o.action === s.action && o.what === s.what && (o.keyLogic ?? null) === (s.keyLogic ?? null)) { s.confirmedAt = o.confirmedAt; kept++ }
  }
  const allConfirmed = steps.length > 0 && steps.every((s) => s.confirmedAt)
  const redo = steps.filter((s) => !s.confirmedAt).length
  const plan = { slice: sliceId, kind: planKind, role: roleName, builtAt: now(), codebase: posix(path.relative(root, codebase)), scope: { modules: modulesInScope, aggregates: ordered, useCases: [...useCases].sort() }, steps, already, modelFingerprint: modelFingerprint(), confirmedAt: allConfirmed ? (old?.confirmedAt ?? today) : null, log: [...(old?.log ?? []), `${today} ${old ? '重算' : '生成'}：${steps.length} 步（${planKind}）${already.length ? `；另有 ${already.length} 项上一条切片已经做过，没列进步骤` : ''}${old && kept ? `；${kept} 步内容没变、人的确认留着${redo ? `，${redo} 步要重新确认` : ''}` : ''}`] }
  const carried = already.length ? `；另有 ${already.length} 项上一条切片已经做过、代码还在、跟模型仍然一致，没列进步骤` : ''
  if (unrecorded?.length) {
    const line = `这 ${unrecorded.length} 处的文件其实已经在代码库里、也跟模型一致，但没有哪张施工单记过是谁建的，所以仍然列成步骤：${unrecorded.map((s) => s.target).join('、')}`
    console.log('[计划] ' + line)
    plan.log.push(`${today} ${line}`)
  }
  writeJson(planPath, plan)
  fs.writeFileSync(planMd, renderMd(plan))
  appendSliceLog(`编码计划${old ? '重算' : '生成'}：${steps.length} 步（${planKind}），关键逻辑待补 ${steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length} 步${carried}`)
  const todo = steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length
  console.log(`计划已${old ? '重算' : '生成'}：${rel(planPath)}（${steps.length} 步，${planKind}）${carried}；${todo ? `${roleName}角色给 ${todo} 步补关键逻辑，然后人确认（plan confirm）` : '没有要补关键逻辑的，可以直接请人确认（plan confirm）'}`)
}

/** 构建块在不在：代码库里有 src/shared/building-block，或 tsconfig 的 paths 把 @shared/building-block/* 指到了别处 */
/**
 * 把测试步骤从末尾那一整块挪到它测的东西旁边。
 * 领域测试只 import 领域层与构建块，紧跟它测的那一步；
 * 用例与仓储测试要用内存适配器走一遍，排在最后一个适配器之后——再往前放就没东西可跑。
 */
function interleaveTests(steps) {
  const tests = steps.filter((s) => s.layer === 'test')
  if (!tests.length) return
  const rest = steps.filter((s) => s.layer !== 'test')
  const needsAdapter = new Set(['application', 'repository'])
  const lastAdapter = rest.map((s) => s.layer).lastIndexOf('adapter')
  const after = new Map() // 位置 → 挂在它后面的那几个测试
  const tail = []
  for (const test of tests) {
    const subject = rest.findIndex((s) => s.target === test.target)
    if (subject < 0) { tail.push(test); continue }
    const at = needsAdapter.has(rest[subject].layer) && lastAdapter > subject ? lastAdapter : subject
    if (!after.has(at)) after.set(at, [])
    after.get(at).push(test)
  }
  const out = []
  rest.forEach((s, i) => { out.push(s); for (const x of after.get(i) ?? []) out.push(x) })
  out.push(...tail)
  steps.length = 0
  steps.push(...out)
  steps.forEach((s, i) => { s.n = i + 1 })
}
/**
 * 已经做过的挑出去。
 *
 * 为什么要有这一道：几条切片共用同一批聚合时，前一条切片是照整份模型写的，
 * 后一条切片算出来的单子上会有一大半早就完工了（s-003 头一回算出来 60 步、其中 58 步已完工）。
 * 一张大半都是打勾的单子，会教人闭着眼睛往下按。
 *
 * 三条判据要同时成立，缺一不可：
 * - 别的切片的施工单上有同一个文件、同一个目标的一步，而且真的登记完成过（doneAt）；
 * - 那个文件现在还在（或者当初就是按「用现成的、不另建文件」结掉的）；
 * - 源码与测试对应的那个模型文件，这一次解码比对下来 0 处差异。模型后来改过、代码没跟上的，
 *   差异不为 0，这一步就重新出现在单子上，它的测试也跟着回来。
 *
 * 接线的那几步（适配器、组合根、原型入口、构建块）单算：只要还剩一样要建，接线就得留着,
 * 新建的东西要登记进去；一样都不建时，接线也就不必动。
 */
function pickOutAlreadyDone(steps, model) {
  const priors = []
  const dir = path.join(root, "plans")
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    // 本切片自己上一版计划里做过的也算：模型没再动、代码还在，就不该重新出现在单子上
    if (!f.endsWith(".json")) continue
    let prev; try { prev = readJson(path.join(dir, f)) } catch { continue }
    for (const s of prev.steps ?? []) if (s.doneAt) priors.push({ slice: prev.slice, n: s.n, file: s.file ?? null, target: s.target, noFile: s.noFile ?? null })
    // 上一版计划里「已经做过、没列成步骤」的那张表也是先例：--force 重算会把完成记录清零，
    // 不带上它们，第二次重算就把没动过的错误、端口、适配器全摆回人面前（2026-09-13 s-001 从 10 步变 16 步）
    for (const a of prev.already ?? []) priors.push({ slice: a.by?.slice ?? prev.slice, n: a.by?.n ?? 0, file: a.file ?? null, target: a.target, noFile: a.by?.noFile ?? null })
  }
  if (!priors.length) return { remaining: [...steps], already: [] } // 拷一份：调用方会先清空 steps 再回填，原样返回同一个数组就把自己清空了（2026-09-13 s-001 算出 0 步）
  const clean = cleanModelFiles(model)
  // 这一步对得上模型里的哪个文件。对不上的（适配器、组合根、原型入口——模型里本来就没有它们，
  // 文件名里还带 *），返回 null：那种只看「做过 + 文件还在」，不看跟模型差不差。
  const modelKey = (f) => {
    if (!f) return null
    const key = modelKeyOf(f, moduleNamesOf(model))
    if (!key || key.includes("*")) return null
    return fs.existsSync(path.join(root, "model", key)) ? key : null
  }
  const settle = (s) => {
    // 故事输入不是代码文件：别的切片当初填过，不等于它按现在的模型还填得对，一律不算做过
    if (s.layer === 'input') return null
    const prior = priors.find((x) => x.target === s.target && sameFile(x.file, s.file))
    if (!prior) return null
    if (!prior.noFile && !exists(s.file)) return null
    const key = modelKey(s.file)
    if (key && (!clean || !clean.has(key))) return null
    return { slice: prior.slice, n: prior.n, ...(prior.noFile ? { noFile: prior.noFile } : {}) }
  }
  const WIRING = new Set(["adapter", "composition", "proto", "building-block"])
  const already = []
  const note = (s, by) => already.push({ layer: s.layer, file: s.file ?? null, target: s.target, what: s.what, by })
  const kept = []
  for (const s of steps) {
    if (WIRING.has(s.layer)) { kept.push(s); continue }
    const by = settle(s)
    if (by) note(s, by); else kept.push(s)
  }
  const isSettledInSubstance = (s) => s.action !== "create" && exists(s.file) && (() => { const k = modelKey(s.file); return k ? !!clean && clean.has(k) : false })()
  // 装配（仓储与端口的适配器、组合根、原型入口）要不要重新过一遍，得按它依赖的东西判，不能「只要有新东西就全摆出来」。
  // 在已有聚合里添一个值对象，装配一个字都不用动——那种把九步装配摆到人面前，人只会把它们当噪音划过去。
  const kindOf = (x) => { const b = x ? String(x).split("/").pop() : ""; return b.includes(".") ? b.split(".")[0] : "" }
  // 这几种新建出来非接不可：新聚合根要仓储与适配器，新的命令 / 查询 / 事件处理器要登记，新端口要适配器，新事件要订阅
  const CREATES_NEED_WIRING = new Set(["aggregate-root", "command-handler", "query-handler", "event-handler", "port", "repository", "event"])
  const moduleOf = (t) => String(t ?? "").split(".")[0]
  const newWiringModules = new Set(kept.filter((s) => !WIRING.has(s.layer) && s.layer !== "input" && s.action === "create" && CREATES_NEED_WIRING.has(kindOf(s.file))).map((s) => moduleOf(s.target)))
  // 命令的入参怎么从页面那一侧对接进来，住在组合根里：应用层动了，这个模块的组合根就要跟着看一遍
  const appTouched = new Set(kept.filter((s) => s.layer === "application").map((s) => moduleOf(s.target)))
  const wiringNeeded = (s) => {
    const m = moduleOf(s.target)
    if (s.layer === "composition") return newWiringModules.has(m) || appTouched.has(m)
    if (s.layer === "proto") return newWiringModules.size > 0
    // 仓储与端口的适配器：只有那个仓储 / 端口本身是这一趟新建的，才要跟着建
    return kept.some((x) => x.target === s.target && !WIRING.has(x.layer) && x.action === "create")
  }
  const remaining = []
  for (const s of kept) {
    if (!WIRING.has(s.layer) || wiringNeeded(s)) { remaining.push(s); continue }
    const by = settle(s)
    if (by) note(s, by); else remaining.push(s)
  }
  const unrecorded = remaining.filter((s) => !WIRING.has(s.layer) && s.layer !== "input" && isSettledInSubstance(s))
  return { remaining, already, unrecorded }
}

/** 解码一遍代码，跟模型比一比：哪些模型文件是 0 处差异的。比不了就返回 null，一步都不挑出去 */
function cleanModelFiles(model) {
  if (!fs.existsSync(codebase)) return null
  const modelDir = path.join(root, "model")
  if (!fs.existsSync(modelDir)) return null
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-decoded-"))
  try {
    const out = path.join(tmp, "model")
    const system = model.modules?.data.system ?? ""
    const dec = spawnSync(process.execPath, [path.join(__dirname, "decode.js"), codebase, out, "--system", system], { encoding: "utf8" })
    if (dec.status !== 0) { console.error("[计划] 解码没跑通，这一次不挑「已经做过的」：" + (dec.stderr || dec.stdout || "").trim().split(String.fromCharCode(10))[0]); return null }
    const diffJson = path.join(tmp, "_diff.json")
    spawnSync(process.execPath, [path.join(__dirname, "diff-model.js"), modelDir, out, "--json", diffJson], { encoding: "utf8" })
    if (!fs.existsSync(diffJson)) return null
    const dirty = new Set(JSON.parse(fs.readFileSync(diffJson, "utf8")).findings.map((f) => f.file))
    const all = walk(modelDir).map((f) => posix(path.relative(modelDir, f))).filter((f) => f.endsWith(".json") && !path.basename(f).startsWith("_"))
    return new Set(all.filter((f) => !dirty.has(f)))
  } catch (e) {
    console.error("[计划] 比对没跑通，这一次不挑「已经做过的」：" + e.message)
    return null
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 模型此刻的样子，算成一个指纹。算计划时记下来，核对时再算一次——对不上就说明
 * 模型在算完计划之后又改过，这份单子已经不作数了，别让人去确认一份过期的单子。
 *
 * 指纹里**不算 decisions 与 questions**：那两样是人的裁决与模型师留的问题，
 * 变了不影响这次要动哪些文件、按什么顺序，算进去只会天天报假警。
 * 同理不算 traces、carries、note：那是给校验与人看的注解，业务分析回填一个编号不该让整张单子作废。
 */
const FP_SKIP = new Set(["decisions", "questions", "traces", "carries", "note"])
function modelFingerprint() {
  const dir = path.join(root, "model")
  if (!fs.existsSync(dir)) return null
  const crypto = require("node:crypto")
  const h = crypto.createHash("sha256")
  for (const f of walk(dir).map((x) => posix(path.relative(dir, x))).filter((x) => x.endsWith(".json") && !path.basename(x).startsWith("_")).sort()) {
    let d; try { d = readJson(path.join(dir, f)) } catch { continue }
    const strip = (o) => {
      if (Array.isArray(o)) return o.map(strip)
      if (o && typeof o === "object") {
        const out = {}
        for (const k of Object.keys(o).sort()) { if (FP_SKIP.has(k)) continue; out[k] = strip(o[k]) }
        return out
      }
      return o
    }
    h.update(f + String.fromCharCode(0) + JSON.stringify(strip(d)) + String.fromCharCode(0))
  }
  return h.digest("hex").slice(0, 16)
}

function hasBuildingBlock() {
  if (fs.existsSync(path.join(codebase, 'src', 'shared', 'building-block'))) return true
  const tc = path.join(codebase, 'tsconfig.json')
  if (!fs.existsSync(tc)) return false
  try { const ts = require('typescript'); const cfg = ts.readConfigFile(tc, ts.sys.readFile); const paths = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, codebase).options.paths ?? {}; return Object.keys(paths).some((k) => k.startsWith('@shared/building-block')) } catch { return false }
}

// ---------- contracts/（接口角色写；这里只读）----------
const MARKERS = ['（没问过）', '（故意推迟）']
const isMarker = (v) => typeof v === 'string' && MARKERS.includes(v)
function loadContracts() {
  const dir = path.join(root, 'contracts')
  const out = { https: [], tables: [], errors: [] }
  if (!fs.existsSync(dir)) return out
  for (const f of walk(dir).filter((p) => p.endsWith('.json'))) {
    let d; try { d = readJson(f) } catch { continue }
    const item = { ...d, file: path.relative(root, f) }
    if (d.kind === 'http') out.https.push(item); else if (d.kind === 'table') out.tables.push(item); else if (d.kind === 'error-status') out.errors.push(item)
  }
  return out
}

// ---------- 给人看的 markdown ----------
const KEY_LOGIC_MAX = 600 // 一步关键逻辑的字数提醒线（SKILL.md「节奏」）：超了只提示「看看有没有啰嗦」，不拒收——完整、直白的话不为凑字数压缩（2026-09-13 项目所有者）
function cellKeyLogic(s) {
  if (!s.keyLogic) return s.needsKeyLogic ? '**待补**' : '—'
  if (!s.keyLogic.includes('\n')) return s.keyLogic.replaceAll('|', '\\|')
  const first = s.keyLogic.split('\n').find((l) => l.trim()) ?? ''
  return `${first.replaceAll('|', '\\|')}（详见下方「关键逻辑」第 ${s.n} 步）`
}
function renderMd(plan) {
  const L = [`# 编码计划 · ${plan.slice}（${{ proto: '原型：领域 + 应用 + 内存适配器', shell: '外壳：生产适配器 + 入口', full: '全部' }[plan.kind]}）`, '']
  L.push(`- 生成：${plan.builtAt.slice(0, 16).replace('T', ' ')}　代码库：\`${plan.codebase}\`　确认：${plan.confirmedAt ?? '**未确认**'}`)
  L.push(`- 范围：模块 ${plan.scope.modules.join('、') || '—'}；聚合 ${plan.scope.aggregates.join('、') || '—'}；用例 ${plan.scope.useCases.join('、') || '—'}`)
  L.push('', '按顺序写。每一步写完 `plan done <项目> <切片> <n>`；最后 `plan check`。', '')
  L.push('| # | 层 | 动作 | 文件 | 做什么 | 编号 | 关键逻辑 | 完成 |', '|---|---|---|---|---|---|---|---|')
  const LAYER = { 'building-block': '构建块', domain: '领域', repository: '仓储接口', service: '领域服务', application: '应用', port: '端口', adapter: '适配器', shell: '外壳', composition: '装配', proto: '原型入口', test: '测试', input: '故事输入' }
  for (const s of plan.steps) L.push(`| ${s.n} | ${LAYER[s.layer] ?? s.layer} | ${s.action === 'create' ? '新建' : '修改'} | ${s.file ? `\`${s.file}\`` : '—'} | ${s.what.replaceAll('|', '\\|')} | ${s.traces.join(' ') || '—'} | ${cellKeyLogic(s)} | ${s.doneAt ? s.doneAt.slice(5, 16).replace('T', ' ') : ''} |`)
  const multi = plan.steps.filter((s) => s.keyLogic && s.keyLogic.includes('\n'))
  if (multi.length) {
    L.push('', '## 关键逻辑', '', `守卫按执行顺序一行一条，\`→ throw\` / \`→ return\` / \`→ raise\` 是结果，行尾 \`//\` 后是编号；超过 ${KEY_LOGIC_MAX} 字会提醒看看有没有啰嗦，但完整直白优先，不为凑字数压缩。`, '')
    for (const s of multi) L.push(`### 第 ${s.n} 步 · ${LAYER[s.layer] ?? s.layer} · ${s.file ? '\`' + s.file + '\`' : s.target}${s.keyLogic.length > KEY_LOGIC_MAX ? `　**${s.keyLogic.length} 字，看看有没有啰嗦**` : ''}`, '', '\`\`\`text', s.keyLogic.replace(/```/g, "'''"), '\`\`\`', '')
  }
  if (plan.already?.length) {
    L.push('', `## 已经做过的 ${plan.already.length} 项（不在上面的步骤里）`, '')
    L.push('这些文件别的切片已经写过、代码还在，而且解码回来跟现在的模型一致，所以这一次不必再动。', '模型后来改了、代码没跟上的，会自动回到上面的步骤里。', '')
    L.push('| 层 | 文件 | 目标 | 谁做的 |', '|---|---|---|---|')
    for (const a of plan.already) L.push(`| ${LAYER[a.layer] ?? a.layer} | ${a.file ? '`' + a.file + '`' : '—'} | ${a.target} | ${a.by.slice} 第 ${a.by.n} 步${a.by.noFile ? '（用现成的，不另建文件）' : ''} |`)
  }
  const talked = plan.steps.filter((s) => s.humanNotes?.length)
  if (talked.length) {
    L.push('', '## 人在步骤上留的话', '', '写码角色开写前先读这一节：人对哪一步有话，按话改，改了在 plan done 的说明里回一句。', '')
    for (const s of talked) for (const h of s.humanNotes) L.push(`- 第 ${s.n} 步 ${s.target}（${String(h.ts).slice(0, 16).replace('T', ' ')}）：${h.text}`)
  }
  L.push('', '## 记录', '', ...plan.log.map((l) => `- ${l}`), '')
  return L.join('\n')
}
function loadPlan() { if (!fs.existsSync(planPath)) die(`计划不存在：${rel(planPath)}（先 plan build）`); return readJson(planPath) }
function savePlan(plan) { writeJson(planPath, plan); fs.writeFileSync(planMd, renderMd(plan)) }

// ========== amend：确认之后模型又动了一点，核对无碍就只换指纹 ==========
// 场景（2026-09-13 第七十三批）：计划确认、十步写完之后，项目所有者当面裁了一条新规矩，
// 业务分析补语句、模型师给已有聚合加了一条不变量、原型在原步骤里补了守卫与用例。
// 这时 check 会因为模型指纹对不上报「计划过期」，可两条现成的路都不对：
//   build --force 会把人的确认与十步完成记录一起清零；手改 modelFingerprint 等于自己把闸门按掉。
// 所以核对一遍：把现在的模型重算一份单子，跟「这份计划的步骤 + 它记下已经做过的」比。
// 要干的活一件没多、没少，才准换指纹，并把为什么、换的是哪两个指纹记进计划与切片日志。
function amend() {
  const plan = loadPlan()
  const reason = args.slice(3).filter((a) => !a.startsWith('--') && !USED_VALUES.has(a)).join(' ').trim()
  if (!reason) die('用法：plan amend <项目目录> <切片id> "<为什么确认之后还要动：谁裁的、改了什么>" [--code <代码库>]\n（这不是重算：只在要动的文件与顺序一件没变时换掉模型指纹）')
  if (!plan.confirmedAt) die('这份计划还没被人确认，不用 amend——直接 plan build 重算就行')
  const nowFp = modelFingerprint()
  if (!nowFp) die('读不到模型，算不出指纹')
  if (nowFp === plan.modelFingerprint) { console.log('模型指纹没变，不用 amend'); return }
  const dry = build(true)
  if (dry.planKind !== plan.kind) die(`计划种类从 ${plan.kind} 变成了 ${dry.planKind}，这不是小修：请 plan build --force 重算并请人重新确认`)
  const key = (x) => `${x.layer}|${x.target}|${x.file ?? ''}`
  const had = new Map()
  for (const x of plan.steps) had.set(key(x), `#${x.n}`)
  for (const a of plan.already ?? []) had.set(key(a), '已经做过')
  const nowKeys = dry.steps.map(key)
  const added = nowKeys.filter((k) => !had.has(k))
  const gone = [...had.keys()].filter((k) => !nowKeys.includes(k))
  // 顺序也要对：现有步骤在新单子里的先后不能变
  const mineNow = nowKeys.filter((k) => [...plan.steps].some((x) => key(x) === k))
  const mineWas = plan.steps.map(key).filter((k) => nowKeys.includes(k))
  const reordered = mineNow.join('\n') !== mineWas.join('\n')
  if (added.length || gone.length || reordered) {
    const L = ['模型这次的改动动到了要干的活，amend 不接（这道闸门就是防这个）：']
    for (const k of added) L.push(`  多出来要干的：${k.split('|').slice(0, 2).join(' ')} ${k.split('|')[2]}`)
    for (const k of gone) L.push(`  不用干了：${k.split('|').slice(0, 2).join(' ')} ${k.split('|')[2]}（原来是 ${had.get(k)}）`)
    if (reordered) L.push('  现有步骤的先后变了')
    L.push('请 plan build --force 重算，补关键逻辑，再请人重新确认。')
    die(L.join('\n'))
  }
  const before = plan.modelFingerprint
  plan.modelFingerprint = nowFp
  plan.amendedAt = today
  plan.log.push(`${today} 确认后追加：${reason}（核对过：要动的文件与顺序一件没变；模型指纹 ${String(before).slice(0, 12)}… → ${nowFp.slice(0, 12)}…）`)
  savePlan(plan)
  appendSliceLog(`编码计划确认后追加：${reason}（要动的文件与顺序没变，只换模型指纹）`)
  console.log(`已核对：${dry.steps.length} 项活跟这份计划对得上，一件没多没少、先后没变。\n模型指纹已更新，人的确认与 ${plan.steps.filter((x) => x.doneAt).length}/${plan.steps.length} 步完成记录都留着。\n理由已记进计划与切片日志。`)
}

// ========== confirm ==========
/**
 * 人确认计划。可以一步一步确认（plan confirm <项目> <切片> <步骤号>），也可以一次全确认（不带步骤号）；
 * 每一步记 confirmedAt，全部步骤都确认了计划才算通过（plan.confirmedAt）。2026-09-14 项目所有者：「编码计划可以分步确认」。
 */
function confirm() {
  const plan = loadPlan()
  const stepArg = args[3] && /^\d+$/.test(args[3]) ? Number(args[3]) : null
  const targets = stepArg ? plan.steps.filter((s) => s.n === stepArg) : plan.steps.filter((s) => !s.confirmedAt)
  if (stepArg && !targets.length) die(`没有第 ${stepArg} 步（计划共 ${plan.steps.length} 步）`)
  const unfilled = targets.filter((s) => s.needsKeyLogic && !s.keyLogic)
  if (unfilled.length) die(`还有 ${unfilled.length} 步没有关键逻辑，不能确认：${unfilled.map((s) => `#${s.n} ${s.target}`).join('、')}`)
  const over = targets.filter((s) => s.keyLogic && s.keyLogic.length > KEY_LOGIC_MAX)
  if (over.length) console.error(`提醒：有 ${over.length} 步关键逻辑超过 ${KEY_LOGIC_MAX} 字，看看有没有啰嗦（完整直白的话不必压缩）：`)
  for (const s of over) console.error(`  #${s.n} ${s.target}（${s.keyLogic.length} 字）`)
  for (const s of targets) s.confirmedAt = today
  const left = plan.steps.filter((s) => !s.confirmedAt)
  if (stepArg) plan.log.push(`${today} 人确认第 ${stepArg} 步`)
  journal(root, { kind: 'confirm', who: '人', slice: sliceId, text: stepArg ? `确认编码计划第 ${stepArg} 步 ${targets[0].target}` : `确认编码计划剩下的 ${targets.length} 步` })
  if (!left.length) {
    plan.confirmedAt = today
    plan.log.push(`${today} 人确认计划`)
    savePlan(plan)
    appendSliceLog(`人确认编码计划（${plan.steps.length} 步${stepArg ? '，分步确认' : ''}）`)
    console.log(`计划已确认：${plan.steps.length} 步。${plan.role}角色按顺序开写，每步完成后 plan done。`)
  } else {
    savePlan(plan)
    console.log(`第 ${targets.map((s) => s.n).join('、')} 步已确认，还剩 ${left.length} 步：${left.map((s) => '#' + s.n).join(' ')}。全部确认后计划才算通过。`)
  }
}

/** 人撤销某一步的确认（2026-09-14 项目所有者：「单步确认按钮不好用，而且也无法撤销或者加 comment」）。写完的步不能撤——要改就留话，写码角色按话改 */
function unconfirm() {
  const n = Number(args[3])
  if (!Number.isInteger(n) || n < 1) die('用法：plan unconfirm <项目目录> <切片id> <步骤号>')
  const plan = loadPlan()
  const s = plan.steps.find((x) => x.n === n)
  if (!s) die(`没有第 ${n} 步（计划共 ${plan.steps.length} 步）`)
  if (!s.confirmedAt) die(`第 ${n} 步本来就没确认`)
  if (s.doneAt) die(`第 ${n} 步已经写完了，撤销确认没有意义；对它有话就 plan comment 留下，写码角色按话改`)
  s.confirmedAt = null
  plan.confirmedAt = null
  plan.log.push(`${today} 人撤销第 ${n} 步的确认`)
  journal(root, { kind: 'unconfirm', who: '人', slice: sliceId, text: `撤销编码计划第 ${n} 步 ${s.target} 的确认` })
  savePlan(plan)
  console.log(`第 ${n} 步的确认撤了；计划回到未通过，还有 ${plan.steps.filter((x) => !x.confirmedAt).length} 步没确认`)
}
/** 人在某一步上留话：哪里不对、要改成什么、为什么。存进步骤的 humanNotes，写进 .md 的「人在步骤上留的话」一节，写码角色开写前读 */
function comment() {
  const n = Number(args[3])
  const text = args.slice(4).filter((a) => !a.startsWith('--') && !USED_VALUES.has(a)).join(' ').trim()
  if (!Number.isInteger(n) || n < 1 || !text) die('用法：plan comment <项目目录> <切片id> <步骤号> "<一句话：哪里不对、要改成什么>"')
  const plan = loadPlan()
  const s = plan.steps.find((x) => x.n === n)
  if (!s) die(`没有第 ${n} 步（计划共 ${plan.steps.length} 步）`)
  s.humanNotes = [...(s.humanNotes ?? []), { ts: now(), text }]
  plan.log.push(`${today} 人在第 ${n} 步留话：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`)
  journal(root, { kind: 'comment', who: '人', slice: sliceId, text: `在编码计划第 ${n} 步 ${s.target} 留话：${text}` })
  savePlan(plan)
  console.log(`第 ${n} 步 ${s.target} 留下了：${text}（${plan.role}角色开写前会读）`)
}

// ========== done ==========
function done() {
  const n = Number(args[3])
  if (!Number.isInteger(n) || n < 1) die('用法：plan done <项目目录> <切片id> <步骤号> [--已有 说明|说明]')
  const plan = loadPlan()
  if (!plan.confirmedAt) die('计划还没被人确认，不能开写')
  const s = plan.steps.find((x) => x.n === n)
  if (!s) die(`没有第 ${n} 步`)
  const earlier = plan.steps.filter((x) => x.n < n && !x.doneAt)
  if (earlier.length) console.log(`注意：第 ${earlier.map((x) => x.n).join('、')} 步还没完成——顺序与计划不一致，check 会报`)
  s.doneAt = now()
  // 「已有」：构建块里现成的东西够用，这一步不另建文件。理由必须写，check 照着理由放行、不再报文件不存在
  const rest = args.slice(4)
  const noFile = rest[0] === '--已有' || rest[0] === '--no-file'
  const note = (noFile ? rest.slice(1) : rest).join(' ')
  if (noFile) {
    if (!note) die('用 --已有 结掉一步时要写清楚用的是哪个现成的东西、为什么不另建')
    s.noFile = note
  }
  plan.log.push(`${today} 完成 #${n} ${s.target}${noFile ? '（已有，不另建文件）' : ''}${note ? '：' + note : ''}`)
  savePlan(plan)
  console.log(`#${n} ${s.target} 完成${note ? '：' + note : ''}（${plan.steps.filter((x) => x.doneAt).length}/${plan.steps.length}）`)
}

// ========== check ==========
function check() {
  const plan = loadPlan()
  const issues = []
  const notes = []
  if (plan.modelFingerprint) {
    const nowFp = modelFingerprint()
    if (nowFp && nowFp !== plan.modelFingerprint) issues.push(`算完这份计划之后模型又改过：这份单子上要动哪些文件、按什么顺序都可能不作数了，要动的文件与顺序若一件没变，用 plan amend "<为什么>" 核对后换指纹（确认与完成记录都留着）；真变了才 plan build --force 重算再往下走`)
  }
  if (!plan.confirmedAt) issues.push('计划未经人确认')
  for (const s of plan.steps.filter((x) => x.needsKeyLogic && !x.keyLogic)) issues.push(`#${s.n} ${s.target}：关键逻辑未补`)
  for (const s of plan.steps.filter((x) => x.keyLogic && x.keyLogic.length > KEY_LOGIC_MAX)) notes.push(`#${s.n} ${s.target}：关键逻辑 ${s.keyLogic.length} 字，超过 ${KEY_LOGIC_MAX} 字提醒线，看看有没有啰嗦（不拦）`)
  // 测试步骤不强制补关键逻辑，但空着就没人知道该断言什么——单独报一行，别让它悄悄溜过去
  for (const s of plan.steps.filter((x) => !x.needsKeyLogic && !x.keyLogic && x.layer === 'test')) issues.push(`#${s.n} ${s.target}：测试步骤的关键逻辑空着（不强制，但空着就没人知道该断言什么）`)
  for (const s of plan.steps.filter((x) => x.file && !x.noFile && !exists(x.file))) issues.push(`#${s.n} ${s.target}：文件不存在 ${s.file}`)
  for (const s of plan.steps.filter((x) => x.noFile)) notes.push(`#${s.n} ${s.target}：用现成的，不另建文件——${s.noFile}`)
  for (const a of plan.already ?? []) if (a.file && !a.by.noFile && !exists(a.file)) issues.push(`${a.target}：算计划时认定它已经做过（${a.by.slice} 第 ${a.by.n} 步），现在文件不见了 ${a.file}`)
  if (plan.already?.length) notes.push(`另有 ${plan.already.length} 项是别的切片做过的，没列进步骤（见计划里「已经做过的」那一节）`)
  for (const s of plan.steps.filter((x) => !x.doneAt)) issues.push(`#${s.n} ${s.target}：未登记完成（plan done）`)
  const doneSteps = plan.steps.filter((x) => x.doneAt)
  for (let i = 1; i < doneSteps.length; i++) if (doneSteps[i].doneAt < doneSteps[i - 1].doneAt) issues.push(`顺序不一致：#${doneSteps[i].n} ${doneSteps[i].target}（${doneSteps[i].doneAt.slice(11, 19)}）在 #${doneSteps[i - 1].n}（${doneSteps[i - 1].doneAt.slice(11, 19)}）之前完成`)
  if (plan.steps.some((x) => x.layer === 'input') && story) for (const st of story.steps) if (st.walk && ['command', 'query', 'time'].includes(st.walk.kind) && !st.walk.input) issues.push(`故事第 ${st.n} 步（${st.walk.name}）walk.input 未填`)
  // 填了、但填的还作不作数：命令的入参窄了之后，故事输入上多出来的栏位递进去命令不认。
  // 判得出来的只有顶层那一层，窄在参数里面的判不出来——那种由计划里那一步管（见 build）
  for (const other of storyWalks(loadProject(root).model)) {
    const stale = other.walks.filter((x) => x.extra.length)
    if (!stale.length) continue
    const where = stale.map((x) => `第 ${x.n} 步（${x.name}）多出 ${x.extra.join("、")}`).join("；")
    const line = `${other.slice} 的故事输入已经不作数：${where}——命令上没有这几个栏位了`
    const mine = other.slice === sliceId || plan.steps.some((x) => x.layer === "input" && x.target === `${other.slice}.story`)
    if (mine) issues.push(line)
    else notes.push(line + "（这一趟的单子上没有它，另找时候补）")
  }
  const result = { slice: sliceId, kind: plan.kind, steps: plan.steps.length, done: doneSteps.length, ok: !issues.length, issues, notes }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`计划核对 ${sliceId}（${plan.kind}）：${plan.steps.length} 步，完成 ${doneSteps.length}，${issues.length ? `${issues.length} 个问题` : '一致'}`)
    for (const i of issues) console.log(`  ✗ ${i}`)
    for (const n of notes) console.log(`  · ${n}`)
  }
  process.exit(issues.length ? 1 : 0)
}

if (cmd === 'build') build()
if (cmd === 'confirm') confirm()
if (cmd === 'unconfirm') unconfirm()
if (cmd === 'comment') comment()
if (cmd === 'done') done()
if (cmd === 'check') check()
if (cmd === 'amend') amend()
