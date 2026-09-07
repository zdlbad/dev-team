#!/usr/bin/env node
/**
 * 编码计划。编码开始前，从模型与切片范围算出这次要动哪些代码文件、按什么顺序，
 * 写成 plans/<切片id>.json（+ .md 给人看）。编码 / 原型角色在每一步下面补「关键逻辑」，
 * 人确认后才开写；写的时候每完成一步登记一次，最后核对：文件都在、顺序与计划一致。
 *
 * 用法：
 *   node tools/plan.js build   <项目目录> <切片id> [--code <代码库>] [--force]   算链路（已确认的计划要 --force 才重算）
 *   node tools/plan.js confirm <项目目录> <切片id>                              人确认计划（门禁）
 *   node tools/plan.js done    <项目目录> <切片id> <步骤号> [说明]                角色：完成第 n 步（记时间，核对顺序用）
 *   node tools/plan.js check   <项目目录> <切片id> [--code <代码库>] [--json]    核对：已确认、关键逻辑齐、文件都在、顺序一致、walk.input 齐
 *
 * 计划的种类由切片决定：故事切片 → proto（领域 + 应用 + 内存适配器 + 原型入口 + 测试 + walk.input）；
 * 实现切片 → shell（生产仓储、HTTP 入口、生产装配 + 外壳测试；文件名取自 contracts/）；老式切片 → full。
 * 退出码：0 正常；1 核对未过；2 用法或前置错误。
 */
const fs = require('node:fs')
const path = require('node:path')
const { loadProject, walk, readJson } = require('./lib/project')

const args = process.argv.slice(2)
const cmd = args[0]
const root = args[1] && path.resolve(args[1])
const sliceId = args[2] && !args[2].startsWith('--') ? args[2] : undefined
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined }
const today = new Date().toISOString().slice(0, 10)
const now = () => new Date().toISOString()

function die(msg) { console.error(msg); process.exit(2) }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n') }
if (!['build', 'confirm', 'done', 'check'].includes(cmd) || !root || !fs.existsSync(path.join(root, 'project.json')) || !sliceId) {
  die('用法：node tools/plan.js <build|confirm|done|check> <项目目录> <切片id> …（项目目录须含 project.json）')
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

// ========== build ==========
function build() {
  const project = loadProject(root)
  const { model } = project
  const els = model.elements.filter((e) => e.kind !== 'invalid')
  const byQ = (kind, q) => { const [m, n] = q.includes('.') ? q.split('.') : [null, q]; return els.find((e) => e.kind === kind && e.data.name === n && (!m || e.module === m)) ?? null }
  const modOf = (el) => el.module
  const q = (el) => `${el.module}.${el.data.name}`

  // ---- 范围：用例（命令 / 查询 / 事件处理）与聚合的限定名 ----
  const useCases = new Set(), aggregates = new Set(), modulesOnly = new Set()
  if (story) for (const s of story.steps) {
    const w = s.walk; if (!w || w.kind === 'none') continue
    if (w.name && w.name.includes('.')) useCases.add(w.name)
    if (w.aggregate) aggregates.add(w.aggregate)
  }
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
  // 事件处理：范围内聚合发出的事件，其处理器在范围模块里的也算进来（老式切片按模块；故事切片只认 walk 走到的）
  if (planKind !== 'proto') for (const h of els.filter((e) => e.kind === 'event-handler')) {
    const [tm, tn] = h.data.trigger.includes('.') ? h.data.trigger.split('.') : [h.module, h.data.trigger]
    const ev = els.find((e) => e.kind === 'event' && e.module === tm && e.data.name === tn)
    if (ev && aggregates.has(`${ev.module}.${ev.data.aggregate}`) && (modulesOnly.has(h.module) || (slice.scope.modules ?? []).includes(h.module))) { useCases.add(q(h)); visitSteps(h.data.steps, h.module) }
  }

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
  const codeFile = (el) => posix(el.file).replace(/^model\//, 'src/').replace(/\.json$/, '.ts')
  const testFile = (el) => posix(el.file).replace(/^model\//, 'tests/').replace(/\.json$/, '.test.ts')
  const add = (layer, file, target, what, traces, needsKeyLogic, extra = {}) => steps.push({ n: steps.length + 1, layer, action: exists(file) ? 'modify' : 'create', file, target, what, traces: [...new Set(traces ?? [])], needsKeyLogic, keyLogic: null, doneAt: null, ...extra })
  const behaviorsText = (el) => el.data.behaviors.map((b) => b.name).join('、')
  const modulesInScope = [...new Set([...aggregates, ...useCases].map((x) => x.split('.')[0]))].sort()

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
      for (const el of members.filter((e) => e.kind === 'error')) add('domain', codeFile(el), q(el), `错误 ${el.data.name}：${el.data.condition || '（条件未写）'}`, el.data.traces, false)
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
    for (const r of repoEls) add('adapter', `src/${r.module}/adapters/adapter.InMemory${r.data.aggregate}Repository.ts`, q(r), `内存仓储 InMemory${r.data.aggregate}Repository：实现 ${r.data.name}Interface，另加 all() 给原型页面看状态；save 比对 version`, [], false)
    for (const p of portEls) add('adapter', `src/${p.module}/adapters/adapter.*${p.data.name}.ts`, q(p), p.data.kind === 'module' ? `直连适配器：实现 ${p.data.name}Interface，内部调 ${p.data.target} 模块的仓储或查询，不含判断` : `原型用的假适配器：实现 ${p.data.name}Interface（${p.data.target}），只记录 / 打印，不含判断`, [], false)
    if (hasWriter) add('adapter', `src/*/adapters/adapter.InMemoryEventPublisher.ts`, 'shared.EventPublisher', '进程内事件总线：按事件名分发给订阅者；原型里顺手记进宿主的事件流水', [], false)
  } else if (planKind === 'shell') {
    const contracts = loadContracts()
    for (const r of repoEls) {
      const t = contracts.tables.find((c) => c.aggregate === `${r.module}.${r.data.aggregate}` || c.aggregate === r.data.aggregate)
      const orm = t?.orm && !isMarker(t.orm) ? t.orm : '*'
      add('shell', `src/${r.module}/adapters/adapter.${orm}${r.data.aggregate}Repository.ts`, q(r), `生产仓储 ${orm === '*' ? '<技术>' : orm}${r.data.aggregate}Repository：实现 ${r.data.name}Interface；表 ${t?.table && !isMarker(t.table) ? t.table : '（契约未定）'}；save 带乐观锁（where version = ?，成功 +1，不符抛 ConcurrencyError）；不分发事件`, [], true, { contract: t ? posix(t.file) : null })
    }
    for (const p of portEls.filter((x) => x.data.kind === 'external-system')) add('shell', `src/${p.module}/adapters/adapter.*${p.data.name}.ts`, q(p), `生产适配器：实现 ${p.data.name}Interface，对接 ${p.data.target}；只做线格式转换`, [], true)
    for (const u of [...useCases].sort()) {
      const el = byQ('command-handler', u) ?? byQ('query-handler', u)
      if (!el) continue
      const h = contracts.https.find((c) => c.useCase === u || c.useCase === el.data.name)
      add('shell', null, q(el), `HTTP 入口 ${el.data.name}：${h ? `${h.method ?? '?'} ${h.path ?? '?'}` : '（契约未定）'}；字段名沿用命令 input（${(el.data.input ?? []).map((x) => x.name).join(', ')}）；领域错误按 contracts/errors 映射状态码；文件位置由技术选型定`, el.data.traces, true, { contract: h ? posix(h.file) : null })
    }
  } else {
    for (const r of repoEls) add('adapter', `src/${r.module}/adapters/adapter.*${r.data.aggregate}Repository.ts`, q(r), `仓储适配器：实现 ${r.data.name}Interface；save 带乐观锁；不分发事件`, [], false)
    for (const p of portEls) add('adapter', `src/${p.module}/adapters/adapter.*${p.data.name}.ts`, q(p), `适配器：实现 ${p.data.name}Interface（${p.data.target}）；只做线格式转换，不含判断`, [], false)
    if (hasWriter) add('adapter', `src/*/adapters/adapter.*EventPublisher.ts`, 'shared.EventPublisher', '事件发布适配器：实现 EventPublisherInterface', [], false)
  }
  for (const m of modulesInScope) add('composition', `src/${m}/module.ts`, `${m}.module`, planKind === 'shell' ? `生产装配：换掉内存适配器，顺序 适配器 → 领域服务 → 处理器 → 事件订阅；@module / @responsibility / @trace 不变` : `组合根 build${m}Module：实例化顺序 适配器 → 领域服务 → 处理器 → 事件订阅${planKind === 'proto' ? '；把每个命令 / 查询 / 仓储登记到原型宿主（登记名 = 模块.名字）' : ''}`, [], false)
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
    for (const r of repoEls) add('test', `tests/${r.module}/adapters/adapter.*${r.data.aggregate}Repository.test.ts`, q(r), `仓储测试：save / find 往返 + 版本冲突抛 ConcurrencyError`, [], false)
    for (const u of [...useCases].sort()) { const el = byQ('command-handler', u) ?? byQ('query-handler', u); if (el) add('test', `tests/${el.module}/adapters/*${el.data.name}*.test.ts`, q(el), `契约测试 ${el.data.name}：按 contracts/http 的字段发请求，核对响应与错误 → 状态码`, [], false) }
  }
  if (planKind === 'proto' && story) add('input', null, `${sliceId}.story`, `给故事每一步（kind 为 command / query / time 的）walk 填 input：字段名 = 命令 input 的参数名，值来自故事的金额与日期`, [], false)

  // ---- 合并旧计划的关键逻辑；写出 ----
  const old = fs.existsSync(planPath) ? readJson(planPath) : null
  if (old?.confirmedAt && !args.includes('--force')) die(`计划已于 ${old.confirmedAt} 确认；要重算请加 --force（关键逻辑会尽量保留，确认与完成记录清零）`)
  if (old) for (const s of steps) { const o = old.steps.find((x) => x.target === s.target && x.layer === s.layer && (x.file ?? null) === (s.file ?? null)); if (o?.keyLogic) s.keyLogic = o.keyLogic }
  const plan = { slice: sliceId, kind: planKind, role: roleName, builtAt: now(), codebase: posix(path.relative(root, codebase)), scope: { modules: modulesInScope, aggregates: ordered, useCases: [...useCases].sort() }, steps, confirmedAt: null, log: [...(old?.log ?? []), `${today} ${old ? '重算' : '生成'}：${steps.length} 步（${planKind}）`] }
  writeJson(planPath, plan)
  fs.writeFileSync(planMd, renderMd(plan))
  appendSliceLog(`编码计划${old ? '重算' : '生成'}：${steps.length} 步（${planKind}），关键逻辑待补 ${steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length} 步`)
  console.log(`计划已${old ? '重算' : '生成'}：${rel(planPath)}（${steps.length} 步，${planKind}）；${roleName}角色给 ${steps.filter((s) => s.needsKeyLogic && !s.keyLogic).length} 步补关键逻辑，然后人确认（plan confirm）`)
}

/** 构建块在不在：代码库里有 src/shared/building-block，或 tsconfig 的 paths 把 @shared/building-block/* 指到了别处 */
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
function renderMd(plan) {
  const L = [`# 编码计划 · ${plan.slice}（${{ proto: '原型：领域 + 应用 + 内存适配器', shell: '外壳：生产适配器 + 入口', full: '全部' }[plan.kind]}）`, '']
  L.push(`- 生成：${plan.builtAt.slice(0, 16).replace('T', ' ')}　代码库：\`${plan.codebase}\`　确认：${plan.confirmedAt ?? '**未确认**'}`)
  L.push(`- 范围：模块 ${plan.scope.modules.join('、') || '—'}；聚合 ${plan.scope.aggregates.join('、') || '—'}；用例 ${plan.scope.useCases.join('、') || '—'}`)
  L.push('', '按顺序写。每一步写完 `plan done <项目> <切片> <n>`；最后 `plan check`。', '')
  L.push('| # | 层 | 动作 | 文件 | 做什么 | 编号 | 关键逻辑 | 完成 |', '|---|---|---|---|---|---|---|---|')
  const LAYER = { 'building-block': '构建块', domain: '领域', repository: '仓储接口', service: '领域服务', application: '应用', port: '端口', adapter: '适配器', shell: '外壳', composition: '装配', proto: '原型入口', test: '测试', input: '故事输入' }
  for (const s of plan.steps) L.push(`| ${s.n} | ${LAYER[s.layer] ?? s.layer} | ${s.action === 'create' ? '新建' : '修改'} | ${s.file ? `\`${s.file}\`` : '—'} | ${s.what.replaceAll('|', '\\|')} | ${s.traces.join(' ') || '—'} | ${s.keyLogic ? s.keyLogic.replaceAll('|', '\\|') : s.needsKeyLogic ? '**待补**' : '—'} | ${s.doneAt ? s.doneAt.slice(5, 16).replace('T', ' ') : ''} |`)
  L.push('', '## 记录', '', ...plan.log.map((l) => `- ${l}`), '')
  return L.join('\n')
}
function loadPlan() { if (!fs.existsSync(planPath)) die(`计划不存在：${rel(planPath)}（先 plan build）`); return readJson(planPath) }
function savePlan(plan) { writeJson(planPath, plan); fs.writeFileSync(planMd, renderMd(plan)) }

// ========== confirm ==========
function confirm() {
  const plan = loadPlan()
  const unfilled = plan.steps.filter((s) => s.needsKeyLogic && !s.keyLogic)
  if (unfilled.length) die(`还有 ${unfilled.length} 步没有关键逻辑，不能确认：${unfilled.map((s) => `#${s.n} ${s.target}`).join('、')}`)
  plan.confirmedAt = today
  plan.log.push(`${today} 人确认计划`)
  savePlan(plan)
  appendSliceLog(`人确认编码计划（${plan.steps.length} 步）`)
  console.log(`计划已确认：${plan.steps.length} 步。${plan.role}角色按顺序开写，每步完成后 plan done。`)
}

// ========== done ==========
function done() {
  const n = Number(args[3])
  if (!Number.isInteger(n) || n < 1) die('用法：plan done <项目目录> <切片id> <步骤号> [说明]')
  const plan = loadPlan()
  if (!plan.confirmedAt) die('计划还没被人确认，不能开写')
  const s = plan.steps.find((x) => x.n === n)
  if (!s) die(`没有第 ${n} 步`)
  const earlier = plan.steps.filter((x) => x.n < n && !x.doneAt)
  if (earlier.length) console.log(`注意：第 ${earlier.map((x) => x.n).join('、')} 步还没完成——顺序与计划不一致，check 会报`)
  s.doneAt = now()
  const note = args.slice(4).join(' ')
  plan.log.push(`${today} 完成 #${n} ${s.target}${note ? '：' + note : ''}`)
  savePlan(plan)
  console.log(`#${n} ${s.target} 完成${note ? '：' + note : ''}（${plan.steps.filter((x) => x.doneAt).length}/${plan.steps.length}）`)
}

// ========== check ==========
function check() {
  const plan = loadPlan()
  const issues = []
  if (!plan.confirmedAt) issues.push('计划未经人确认')
  for (const s of plan.steps.filter((x) => x.needsKeyLogic && !x.keyLogic)) issues.push(`#${s.n} ${s.target}：关键逻辑未补`)
  for (const s of plan.steps.filter((x) => x.file && !exists(x.file))) issues.push(`#${s.n} ${s.target}：文件不存在 ${s.file}`)
  for (const s of plan.steps.filter((x) => !x.doneAt)) issues.push(`#${s.n} ${s.target}：未登记完成（plan done）`)
  const doneSteps = plan.steps.filter((x) => x.doneAt)
  for (let i = 1; i < doneSteps.length; i++) if (doneSteps[i].doneAt < doneSteps[i - 1].doneAt) issues.push(`顺序不一致：#${doneSteps[i].n} ${doneSteps[i].target}（${doneSteps[i].doneAt.slice(11, 19)}）在 #${doneSteps[i - 1].n}（${doneSteps[i - 1].doneAt.slice(11, 19)}）之前完成`)
  if (plan.steps.some((x) => x.layer === 'input') && story) for (const st of story.steps) if (st.walk && ['command', 'query', 'time'].includes(st.walk.kind) && !st.walk.input) issues.push(`故事第 ${st.n} 步（${st.walk.name}）walk.input 未填`)
  const result = { slice: sliceId, kind: plan.kind, steps: plan.steps.length, done: doneSteps.length, ok: !issues.length, issues }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`计划核对 ${sliceId}（${plan.kind}）：${plan.steps.length} 步，完成 ${doneSteps.length}，${issues.length ? `${issues.length} 个问题` : '一致'}`)
    for (const i of issues) console.log(`  ✗ ${i}`)
  }
  process.exit(issues.length ? 1 : 0)
}

if (cmd === 'build') build()
if (cmd === 'confirm') confirm()
if (cmd === 'done') done()
if (cmd === 'check') check()
